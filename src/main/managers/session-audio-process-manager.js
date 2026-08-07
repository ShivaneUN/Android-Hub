const { spawn, execFile } = require("child_process");

const CREATE_NO_WINDOW = 0x08000000;

/**
 * Capture audio device → PC via scrcpy.exe dédié.
 * Args : --no-video --no-window --no-control --audio-buffer=100
 * (source = output / REMOTE_SUBMIX → HP device toujours muet tant que la capture vit).
 *
 * scrcpy 4.0 : --no-audio-playback SANS --record désactive l'audio entièrement
 * ("No audio playback, no recording: audio disabled" → nothing to do).
 * OFF = --no-audio-playback --record=NUL pour garder la capture / REMOTE_SUBMIX.
 *
 * Principe (comme screen OFF) :
 * - Lancement / OFF : pas de son PC + HP muet (capture + record NUL)
 * - ON : son PC + HP toujours muet (capture + lecture)
 */
class SessionAudioProcessManager {
    constructor(scrcpyBinaryPath) {
        this.scrcpyBinaryPath = scrcpyBinaryPath;
        /** @type {Map<string, { child: import('child_process').ChildProcess, serial: string, displayId: number|null, pid: number|null, deviceKey: string|null, pcPlayback: boolean }>} */
        this.processes = new Map();
        /** @type {Set<number>} */
        this._knownPids = new Set();
        /** @type {Map<string, Promise<unknown>>} serialise start/stop par session */
        this._startLocks = new Map();
        /** @type {Promise<string>|null} */
        this._brandedPromise = null;
        /**
         * 1 device physique → 1 session propriétaire audio (Type A ou B).
         * @type {Map<string, string>} canonicalDeviceKey → sessionId
         */
        this._audioOwners = new Map();
        /** @type {Promise<unknown>|null} */
        this._ensureMixerInFlight = null;
        this._ensureMixerAt = 0;
    }

    /** Clé stable pour le propriétaire audio (deviceId > serial). */
    _ownerMapKey(deviceKey, serial = null) {
        return String(deviceKey || serial || "").trim() || null;
    }

    /**
     * Sessions Hub ouvertes sur CE device (plus ancienne d'abord).
     * @returns {Array<{ sessionId: string, deviceKey: string|null, serial: string|null, displayId: number|null, openedAt: number }>}
     */
    listOpenSessionsForDevice(deviceKey, serial = null) {
        const needles = new Set(
            [deviceKey, serial]
                .map((x) => String(x || "").trim())
                .filter(Boolean)
        );
        if (!needles.size) return [];

        const out = [];
        for (const target of this._listActiveSessionTargets()) {
            const ids = [
                target.deviceKey,
                target.serial,
                target.entry?.stableDeviceId,
                target.entry?.deviceId,
                target.niSession?.stableDeviceId,
                target.niSession?.serial
            ].map((x) => String(x || "").trim()).filter(Boolean);

            const hit = ids.some((id) => needles.has(id))
                || [...needles].some((n) => this._matchesDeviceKey(target, n));
            if (!hit) continue;

            const openedAt = Number(target.entry?.openedAt);
            out.push({
                sessionId: target.sessionId,
                deviceKey: target.deviceKey || deviceKey || serial || null,
                serial: target.serial || serial || null,
                displayId: target.displayId,
                openedAt: Number.isFinite(openedAt) ? openedAt : Number.MAX_SAFE_INTEGER
            });
        }

        out.sort((a, b) => a.openedAt - b.openedAt || String(a.sessionId).localeCompare(String(b.sessionId)));
        return out;
    }

    /**
     * Enrichit listOpenSessionsForDevice avec aliases USB/WiFi (async).
     */
    async listOpenSessionsForDeviceAsync(deviceKey, serial = null) {
        const needles = new Set(
            [deviceKey, serial]
                .map((x) => String(x || "").trim())
                .filter(Boolean)
        );
        if (!needles.size) return [];

        let unified = [];
        try {
            unified = await global.deviceRegistry?.listUnifiedDevices?.({ forceFresh: false }) || [];
        } catch (_err) {
            unified = [];
        }
        for (const d of unified) {
            const ids = [d.deviceId, d.serial, d.usbSerial, d.wifiSerial]
                .map((x) => String(x || "").trim())
                .filter(Boolean);
            if (!ids.some((id) => needles.has(id))) continue;
            ids.forEach((id) => needles.add(id));
            break;
        }

        const out = [];
        for (const target of this._listActiveSessionTargets()) {
            const tSerial = target.serial;
            const ids = new Set([
                target.deviceKey,
                target.serial,
                tSerial,
                target.entry?.stableDeviceId,
                target.entry?.deviceId,
                target.niSession?.stableDeviceId,
                target.niSession?.serial
            ].map((x) => String(x || "").trim()).filter(Boolean));

            for (const d of unified) {
                const cand = [d.deviceId, d.serial, d.usbSerial, d.wifiSerial]
                    .map((x) => String(x || "").trim())
                    .filter(Boolean);
                if (!cand.some((id) => ids.has(id))) continue;
                cand.forEach((id) => ids.add(id));
            }

            if (![...ids].some((id) => needles.has(id))
                && ![...needles].some((n) => this._matchesDeviceKey(target, n))) {
                continue;
            }

            const openedAt = Number(target.entry?.openedAt);
            out.push({
                sessionId: target.sessionId,
                deviceKey: target.deviceKey || deviceKey || serial || null,
                serial: tSerial || serial || null,
                displayId: target.displayId,
                openedAt: Number.isFinite(openedAt) ? openedAt : Number.MAX_SAFE_INTEGER
            });
        }

        out.sort((a, b) => a.openedAt - b.openedAt || String(a.sessionId).localeCompare(String(b.sessionId)));
        return out;
    }

    getAudioOwnerSessionId(deviceKey, serial = null) {
        const mapKey = this._ownerMapKey(deviceKey, serial);
        if (!mapKey) return null;
        const owner = this._audioOwners.get(mapKey) || null;
        if (!owner) return null;
        // Owner Hub encore ouvert, OU hold device-audio-* encore vivant.
        const stillOpen = this._listActiveSessionTargets().some((t) => t.sessionId === owner)
            || (String(owner).startsWith("device-audio-") && this.isRunning(owner));
        if (!stillOpen) {
            this._audioOwners.delete(mapKey);
            return null;
        }
        return owner;
    }

    /**
     * Déclare / confirme le propriétaire : 1re session ouverte sur le device.
     * @returns {string|null} sessionId propriétaire
     */
    claimAudioOwner(sessionId, deviceKey, serial = null) {
        const mapKey = this._ownerMapKey(deviceKey, serial);
        if (!mapKey || !sessionId) return null;

        const current = this.getAudioOwnerSessionId(deviceKey, serial);
        if (current) return current;

        // Première session encore ouverte sur ce device (openedAt).
        const open = this.listOpenSessionsForDevice(deviceKey, serial);
        const first = open[0]?.sessionId || sessionId;
        const prev = this._audioOwners.get(mapKey) || null;
        this._audioOwners.set(mapKey, first);
        // Alias serial → même owner si clé différente
        if (serial && this._ownerMapKey(serial) !== mapKey) {
            this._audioOwners.set(this._ownerMapKey(serial), first);
        }
        if (prev !== first) {
            console.log(`[SessionAudio] owner ${mapKey} → ${first}`);
        }
        return first;
    }

    isAudioOwnerSession(sessionId, deviceKey, serial = null) {
        if (!sessionId) return false;
        const owner = this.claimAudioOwner(sessionId, deviceKey, serial);
        return owner === sessionId;
    }

    /**
     * Qui peut régler le volume/mute de CE device dans l'UI ?
     * Toujours oui dès qu'il y a une session, un hold audio, ou un device ciblé :
     * l'owner limite uniquement la capture scrcpy (1 process), pas les sliders.
     */
    canControlDeviceAudio(deviceKey, serial = null, { activeSessionId = null, home = false } = {}) {
        void activeSessionId;
        void home;
        const key = String(deviceKey || "").trim();
        const ser = String(serial || "").trim();
        if (!key && !ser) return false;

        const open = this.listOpenSessionsForDevice(key || ser, ser || key);
        if (open.length > 0) return true;
        if (this.hasCaptureForSerial?.(ser || null, key || null)) return true;

        // Device connecté listé dans le panneau, capture pas encore créée :
        // autoriser — ensureCapture posera le hold au premier geste.
        return Boolean(key || ser);
    }

    async _muteDeviceSpeakerBriefly(serial) {
        const s = String(serial || "").trim();
        if (!s) return;
        try {
            await global.deviceAudioVolumeManager?.forceSpeakerSilent?.(s);
        } catch (err) {
            console.warn(`[SessionAudio] forceSpeakerSilent ${s}:`, err?.message || err);
        }
    }

    /**
     * PID / sessionId de la capture vivante pour CE device (serial ou deviceKey).
     */
    findCaptureSessionId({ serial = null, deviceKey = null, preferSessionId = null } = {}) {
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();
        if (preferSessionId && this.isRunning(preferSessionId)) {
            const entry = this.processes.get(preferSessionId);
            if (entry) {
                const same = (!needle || entry.serial === needle)
                    && (!key || !entry.deviceKey || entry.deviceKey === key);
                if (same || (!needle && !key)) return preferSessionId;
            }
        }
        if (!needle && !key) return null;
        for (const [id, entry] of this.processes.entries()) {
            if (!entry || !this.isRunning(id)) continue;
            if (needle && entry.serial === needle) return id;
            if (key && entry.deviceKey && entry.deviceKey === key) return id;
        }
        return null;
    }

    _forceAudioOwner(deviceKey, serial, sessionId) {
        const mapKey = this._ownerMapKey(deviceKey, serial);
        if (!mapKey || !sessionId) return;
        const prev = this._audioOwners.get(mapKey) || null;
        this._audioOwners.set(mapKey, sessionId);
        if (serial && this._ownerMapKey(serial) !== mapKey) {
            this._audioOwners.set(this._ownerMapKey(serial), sessionId);
        }
        if (prev !== sessionId) {
            console.log(`[SessionAudio] owner ${mapKey} → ${sessionId} (handoff)`);
        }
    }

    _clearAudioOwner(deviceKey, serial) {
        const mapKey = this._ownerMapKey(deviceKey, serial);
        if (mapKey) this._audioOwners.delete(mapKey);
        if (serial) this._audioOwners.delete(this._ownerMapKey(serial));
    }

    _playbackPercentForDevice(deviceKey, serial, pcOn) {
        if (!pcOn) return 0;
        const overlay = global.deviceSpeakerOverlayManager;
        const intent = overlay?.intentPercentByKey?.get?.(deviceKey)
            ?? overlay?.intentPercentByKey?.get?.(serial);
        if (Number.isInteger(intent)) return intent;
        return overlay?.defaultOnPercent || 100;
    }

    /**
     * Ferme une session sans relâcher REMOTE_SUBMIX :
     * bascule owner + capture vers la prochaine session (ou hold device-audio-*).
     * Audio Hub = device-level (pas de --display-id) pour survivre à la fermeture Type B.
     */
    async releaseSessionKeepHold(sessionId, { deviceKey = null, serial = null } = {}) {
        if (!sessionId) return null;
        const closedEntry = this.processes.get(sessionId);
        let ser = String(closedEntry?.serial || serial || "").trim() || null;
        let key = String(closedEntry?.deviceKey || deviceKey || ser || "").trim() || null;

        const sourceId = this.findCaptureSessionId({
            serial: ser,
            deviceKey: key,
            preferSessionId: sessionId
        });
        const sourceEntry = sourceId ? this.processes.get(sourceId) : null;
        if (sourceEntry) {
            ser = String(sourceEntry.serial || ser || "").trim() || null;
            key = String(sourceEntry.deviceKey || key || ser || "").trim() || null;
        }

        const open = ser || key
            ? (await this.listOpenSessionsForDeviceAsync(key, ser))
                .filter((s) => s.sessionId !== sessionId)
            : [];
        const next = open[0] || null;
        const holdId = next?.sessionId || (key || ser ? `device-audio-${key || ser}` : null);
        if (!holdId) {
            if (sourceId) {
                await this._muteDeviceSpeakerBriefly(ser);
                await this.stop(sourceId);
            }
            this._clearAudioOwner(key, ser);
            return null;
        }

        const audio = global.globalAudioOutputManager;
        const pcOn = Boolean(audio?.isDeviceAudioEnabled?.(key || ser));
        const boundToDisplay = Number.isInteger(sourceEntry?.displayId);

        if (next) {
            this._forceAudioOwner(key, ser, next.sessionId);
        } else {
            this._clearAudioOwner(key, ser);
        }

        if (sourceId && sourceId === holdId && !boundToDisplay && this.isRunning(holdId)) {
            this._applyHoldVolume(holdId, key, ser, pcOn);
            return holdId;
        }

        // Adopt Map sans tuer le process — sauf capture liée à un display virtuel.
        if (sourceId && this.isRunning(sourceId) && !boundToDisplay) {
            if (sourceId !== holdId) {
                this.processes.delete(sourceId);
                this.processes.set(holdId, {
                    ...sourceEntry,
                    displayId: null,
                    deviceKey: key || sourceEntry.deviceKey,
                    serial: ser || sourceEntry.serial
                });
                console.log(`[SessionAudio] keep-hold adopt ${sourceId} → ${holdId}`);
            }
            this._applyHoldVolume(holdId, key, ser, pcOn);
            return holdId;
        }

        await this._muteDeviceSpeakerBriefly(ser);
        if (sourceId && this.isRunning(sourceId)) {
            await this.stop(sourceId);
        }
        try {
            await this.start(holdId, {
                serial: ser,
                displayId: null,
                deviceKey: key,
                pcPlayback: pcOn,
                forceOwner: true
            });
            this._applyHoldVolume(holdId, key, ser, pcOn);
            console.log(
                `[SessionAudio] keep-hold restart → ${holdId} `
                + `(pc=${pcOn ? "on" : "off"}; next=${next?.sessionId || "hold"})`
            );
            return holdId;
        } catch (err) {
            console.warn(`[SessionAudio] hold restart:`, err?.message || err);
            return null;
        }
    }

    _applyHoldVolume(holdId, key, ser, pcOn) {
        const holdEntry = this.processes.get(holdId);
        const pid = holdEntry?.pid;
        if (!pid || !global.deviceSpeakerOverlayManager?.applyWindowsPlaybackVolume) return;
        const percent = this._playbackPercentForDevice(key, ser, pcOn);
        void global.deviceSpeakerOverlayManager.applyWindowsPlaybackVolume({
            pid,
            deviceKey: key,
            adbSerial: ser,
            sessionId: holdId,
            percent
        });
    }

    /**
     * Après fermeture d'une session : si elle était owner, la suivante prend la relève.
     */
    async handoffAudioOwner(closedSessionId, { deviceKey = null, serial = null } = {}) {
        if (!closedSessionId) return null;

        if (!this.isRunning(closedSessionId)
            && (deviceKey || serial)
            && this.hasCaptureForSerial?.(serial, deviceKey)) {
            const open = await this.listOpenSessionsForDeviceAsync(deviceKey, serial);
            if (open[0]) {
                this._forceAudioOwner(deviceKey, serial, open[0].sessionId);
                return open[0].sessionId;
            }
            return null;
        }

        return this.releaseSessionKeepHold(closedSessionId, { deviceKey, serial });
    }


    _spawnHidden(command, args) {
        const options = { windowsHide: true, detached: false, stdio: ["ignore", "ignore", "pipe"] };
        if (process.platform === "win32") {
            options.creationFlags = CREATE_NO_WINDOW;
        }
        return spawn(command, args, options);
    }

    _sanitizeMixerFileName(name) {
        return String(name || "Device")
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "Device";
    }

    /** IDs techniques (serial, deviceId hex, IP:port) — jamais comme libellé mixeur. */
    _isUglyMixerId(value, serial = null) {
        const v = String(value || "").trim();
        if (!v || v === "Device") return true;
        if (serial && v === String(serial).trim()) return true;
        if (/^[0-9A-Fa-f]{8,}$/.test(v)) return true; // deviceId / serial hex
        if (/^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(v)) return true;
        if (/^emulator-\d+$/i.test(v)) return true;
        if (/^Android Hub(\s*Audio)?$/i.test(v)) return true;
        return false;
    }

    /**
     * Un seul libellé friendly pour CE device (jamais la liste des devices).
     * Ex. "Xiaomi Pad 5" → exe / FileDescription "Android Hub - Xiaomi Pad 5".
     */
    _resolveDeviceMixerLabel(deviceKey, serial) {
        const isUgly = (value) => this._isUglyMixerId(value, serial);
        const candidates = [];

        const push = (value) => {
            const v = String(value || "").trim();
            if (v && !isUgly(v) && !candidates.includes(v)) candidates.push(v);
        };

        try {
            const panel = global.deviceSpeakerOverlayManager?.lastPanel;
            const keys = new Set(
                [deviceKey, serial].map((x) => String(x || "").trim()).filter(Boolean)
            );
            for (const d of (panel?.devices || [])) {
                const aliases = [d.deviceKey, d.deviceId, d.serial, d.adbSerial]
                    .map((x) => String(x || "").trim())
                    .filter(Boolean);
                if (!aliases.some((a) => keys.has(a))) continue;
                push(d.name);
                break;
            }
        } catch (_err) {
            /* ignore */
        }

        try {
            const fromOverlay = global.deviceSpeakerOverlayManager?._resolveMixerDeviceName?.(
                deviceKey,
                serial
            );
            push(fromOverlay);
        } catch (_err) {
            /* ignore */
        }

        try {
            const cnm = global.customNamesManager;
            if (cnm?.getDeviceDisplayName) {
                push(cnm.getDeviceDisplayName(serial, null));
                push(cnm.getDeviceDisplayName(deviceKey, null));
            }
            if (cnm?.findDeviceRecord) {
                const { record } = cnm.findDeviceRecord([deviceKey, serial], serial || deviceKey);
                push(record?.customName);
                push(record?.originalName);
            }
        } catch (_err) {
            /* ignore */
        }

        if (candidates.length) return candidates[0];

        // Dernier recours : ne jamais coller deviceKey/serial hex dans le mixeur.
        return "Device";
    }

    /**
     * Résolution async (registry) — un device → un nom.
     */
    async _resolveDeviceMixerLabelAsync(deviceKey, serial) {
        const sync = this._resolveDeviceMixerLabel(deviceKey, serial);
        if (sync && sync !== "Device" && !this._isUglyMixerId(sync, serial)) {
            return sync;
        }
        try {
            const unified = await global.deviceRegistry?.listUnifiedDevices?.({ forceFresh: false }) || [];
            const keys = new Set(
                [deviceKey, serial].map((x) => String(x || "").trim()).filter(Boolean)
            );
            for (const d of unified) {
                const ids = [d.deviceId, d.serial, d.usbSerial, d.wifiSerial]
                    .map((x) => String(x || "").trim())
                    .filter(Boolean);
                if (!ids.some((id) => keys.has(id))) continue;
                const name = String(d.name || d.model || "").trim();
                if (name && !this._isUglyMixerId(name, serial)) return name;
            }
        } catch (_err) {
            /* ignore */
        }
        try {
            const cnm = global.customNamesManager;
            if (cnm?.getDeviceDisplayName) {
                for (const key of [serial, deviceKey]) {
                    const n = String(cnm.getDeviceDisplayName(key, null) || "").trim();
                    if (n && !this._isUglyMixerId(n, serial)) return n;
                }
            }
        } catch (_err) {
            /* ignore */
        }
        return sync || "Device";
    }

    /**
     * Template : copie scrcpy.exe → "Android Hub Audio.exe" + rcedit (logo Hub).
     * Jamais spawné tel quel — uniquement source des copies "Android Hub - {device}.exe".
     */
    async _ensureBrandedScrcpyTemplate() {
        const fs = require("fs");
        const path = require("path");
        const {
            brandExeWithHubIdentity,
            resolveHubIconPath,
            readExeFileDescription,
            ensureMixerIconBesideTools
        } = require("./windows-exe-icon");

        const source = this.scrcpyBinaryPath;
        if (!source || !fs.existsSync(source) || process.platform !== "win32") {
            return source;
        }
        if (this._brandedPromise) return this._brandedPromise;

        this._brandedPromise = (async () => {
            const dir = path.dirname(source);
            const branded = path.join(dir, "Android Hub Audio.exe");
            const stampPath = path.join(dir, "Android Hub Audio.exe.hub-ico");
            // Matérialise hors asar + copie tools/android-hub-mixer.ico si possible.
            ensureMixerIconBesideTools(dir);
            const iconPath = resolveHubIconPath();
            if (!iconPath || !fs.existsSync(iconPath)) {
                console.warn("[SessionAudio] icon.ico Hub introuvable — branding impossible");
                return source;
            }
            const sourceMtime = fs.statSync(source).mtimeMs;
            const iconMtime = fs.statSync(iconPath).mtimeMs;
            const stampVersion = 5;

            let stamp = null;
            if (fs.existsSync(stampPath) && fs.existsSync(branded)) {
                try {
                    stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
                } catch (_err) {
                    stamp = null;
                }
            }

            // Template copié sans rcedit = même taille / FileDescription vide → rebuild.
            const descOk = fs.existsSync(branded)
                && readExeFileDescription(branded) === "Android Hub";

            const needRebuild = !stamp
                || stamp.version !== stampVersion
                || stamp.iconOk !== true
                || stamp.sourceMtime !== sourceMtime
                || stamp.iconMtime !== iconMtime
                || stamp.source !== source
                || !descOk;

            if (!needRebuild) return branded;

            try {
                if (fs.existsSync(branded)) fs.unlinkSync(branded);
            } catch (_err) {
                /* ignore */
            }

            fs.copyFileSync(source, branded);
            const brand = await brandExeWithHubIdentity(branded, {
                iconPath,
                displayName: "Android Hub"
            });
            if (!brand?.success) {
                this._brandedPromise = null;
                console.warn("[SessionAudio] brand Hub Audio.exe:", brand?.error || "echec");
                try {
                    if (fs.existsSync(stampPath)) fs.unlinkSync(stampPath);
                } catch (_err) {
                    /* ignore */
                }
                // Garder une copie utilisable comme source si le PE est partiel ; sinon scrcpy.
                if (!fs.existsSync(branded)) {
                    try {
                        fs.copyFileSync(source, branded);
                    } catch (_err) {
                        return source;
                    }
                }
                return source;
            }

            console.log(`[SessionAudio] Android Hub Audio.exe brandé (${path.basename(iconPath)})`);
            fs.writeFileSync(stampPath, JSON.stringify({
                version: stampVersion,
                source,
                sourceMtime,
                iconMtime,
                brandedAt: Date.now(),
                iconOk: true,
                iconPath
            }));
            return branded;
        })();

        try {
            return await this._brandedPromise;
        } catch (err) {
            this._brandedPromise = null;
            console.warn("[SessionAudio] branded template:", err?.message || err);
            return this.scrcpyBinaryPath;
        }
    }

    /**
     * "Android Hub - {device}.exe" : 1 device = 1 exe brandé (nom de CE device uniquement).
     * Ne spawn jamais le template "Android Hub Audio.exe".
     * @returns {Promise<{ binaryPath: string, displayName: string, deviceLabel: string }>}
     */
    async _resolveLabeledScrcpyBinary(deviceKey, serial) {
        const fs = require("fs");
        const path = require("path");
        const {
            brandExeWithHubIdentity,
            stripExeSuffix,
            resolveHubIconPath,
            readExeFileDescription,
            ensureMixerIconBesideTools
        } = require("./windows-exe-icon");
        const source = this.scrcpyBinaryPath;
        const fallback = {
            binaryPath: source,
            displayName: "Android Hub",
            deviceLabel: "Device"
        };
        if (!source || !fs.existsSync(source) || process.platform !== "win32") {
            return fallback;
        }

        const dir = path.dirname(source);
        ensureMixerIconBesideTools(dir);
        const iconPath = resolveHubIconPath();
        const deviceLabel = await this._resolveDeviceMixerLabelAsync(deviceKey, serial);
        const uniqueKey = this._sanitizeMixerFileName(deviceKey || serial || "dev").slice(0, 16);
        const fileLabel = (deviceLabel && deviceLabel !== "Device")
            ? this._sanitizeMixerFileName(deviceLabel)
            : `Device ${uniqueKey}`;
        const displayName = stripExeSuffix(`Android Hub - ${fileLabel}`);
        const labeledPath = path.join(dir, `Android Hub - ${fileLabel}.exe`);
        const deviceStamp = `${labeledPath}.hub-ico`;
        const okResult = { binaryPath: labeledPath, displayName, deviceLabel };

        const descMatches = () => {
            try {
                return fs.existsSync(labeledPath)
                    && readExeFileDescription(labeledPath) === displayName;
            } catch (_err) {
                return false;
            }
        };

        // Réutiliser un exe device déjà brandé — même si le template Audio a échoué.
        if (descMatches()) {
            try {
                fs.writeFileSync(
                    deviceStamp,
                    `v9|ok|${displayName}|${deviceKey || ""}|${serial || ""}|${iconPath || ""}`
                );
            } catch (_err) {
                /* ignore */
            }
            return okResult;
        }

        // Source de copie : template brandé si OK, sinon scrcpy.exe brut.
        const branded = await this._ensureBrandedScrcpyTemplate();
        const brandSource = (branded
            && branded !== source
            && fs.existsSync(branded)
            && readExeFileDescription(branded) === "Android Hub")
            ? branded
            : source;

        if (!iconPath || !fs.existsSync(iconPath)) {
            console.warn(
                "[SessionAudio] icon Hub absent — spawn scrcpy (volume OK, mixeur non brandé)"
            );
            return fallback;
        }

        try {
            if (fs.existsSync(labeledPath)) fs.unlinkSync(labeledPath);
        } catch (unlinkErr) {
            console.warn(
                `[SessionAudio] label unlink ${path.basename(labeledPath)}:`,
                unlinkErr?.message || unlinkErr
            );
        }
        try {
            if (fs.existsSync(deviceStamp)) fs.unlinkSync(deviceStamp);
        } catch (_err) {
            /* ignore */
        }

        try {
            fs.copyFileSync(brandSource, labeledPath);
        } catch (copyErr) {
            console.warn("[SessionAudio] label copy:", copyErr?.message || copyErr);
            return fallback;
        }

        const named = await brandExeWithHubIdentity(labeledPath, {
            iconPath,
            displayName
        });
        if (!named?.success || !descMatches()) {
            console.warn(
                "[SessionAudio] label brand:",
                named?.error || `FileDescription≠${displayName}`
            );
            try {
                if (fs.existsSync(labeledPath)) fs.unlinkSync(labeledPath);
            } catch (_err) {
                /* ignore */
            }
            // Son d'abord : scrcpy brut plutôt qu'un exe cassé.
            return fallback;
        }

        console.log(`[SessionAudio] spawn: ${path.basename(labeledPath)} ("${displayName}")`);
        try {
            fs.writeFileSync(
                deviceStamp,
                `v9|ok|${displayName}|${deviceKey || ""}|${serial || ""}|${iconPath || ""}`
            );
        } catch (_err) {
            /* ignore */
        }
        return okResult;
    }

    _killPidTree(pid) {
        if (!pid || !Number.isInteger(pid) || pid <= 0) return;
        if (process.platform === "win32") {
            try {
                const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
                    windowsHide: true,
                    stdio: "ignore",
                    detached: true
                });
                killer.unref?.();
            } catch (_) {
                /* ignore */
            }
            return;
        }
        try {
            process.kill(pid, "SIGKILL");
        } catch (_) {
            /* ignore */
        }
    }

    async _killOrphanScrcpyAudioProcesses() {
        if (process.platform !== "win32") return;

        await new Promise((resolve) => {
            const script = [
                "$killed = @()",
                "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |",
                "  Where-Object {",
                "    $_.CommandLine -and",
                "    ($_.CommandLine -like '*--no-video*') -and",
                "    ($_.CommandLine -like '*--no-window*' -or $_.CommandLine -like '*--record=NUL*') -and",
                "    (",
                "      $_.Name -eq 'scrcpy.exe' -or",
                "      $_.Name -like 'Android Hub*.exe' -or",
                "      $_.ExecutablePath -like '*\\Android Hub*'",
                "    )",
                "  }",
                "foreach ($p in $procs) {",
                "  $killed += $p.ProcessId",
                "  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue",
                "  & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null",
                "}",
                "if ($killed.Count -gt 0) { $killed -join ',' } else { '' }"
            ].join(" ");

            execFile(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", script],
                { windowsHide: true, timeout: 8000 },
                (err, stdout) => {
                    const text = String(stdout || "").trim();
                    if (text) {
                        console.log(`[SessionAudio] orphans --no-video tues: ${text}`);
                    } else if (err) {
                        console.warn(`[SessionAudio] orphan sweep:`, err.message || err);
                    }
                    resolve();
                }
            );
        });
    }

    _resolveDeviceKey(entry, niSession, serial) {
        return entry?.stableDeviceId
            || niSession?.stableDeviceId
            || entry?.deviceId
            || serial
            || null;
    }

    /** Lecture PC : défaut OFF (mute HP via capture, pas de son PC). */
    _wantPcPlayback(deviceKey, aliasKeys = []) {
        const audio = global.globalAudioOutputManager;
        if (!audio?.isDeviceAudioEnabled) return false;
        return Boolean(audio.isDeviceAudioEnabled(deviceKey, aliasKeys));
    }

    _buildArgs({ serial, displayId, pcPlayback }) {
        // audio-source=output (défaut) : REMOTE_SUBMIX → pas de son sur le HP device.
        // Identité mixeur = exe brandé (Android Hub - {device}.exe + rcedit), pas de fenêtre.
        const args = [
            "--serial", serial,
            "--no-video",
            "--no-window",
            "--no-control",
            "--audio-buffer=100"
        ];

        if (Number.isInteger(displayId)) {
            args.push(`--display-id=${displayId}`);
        }

        if (!pcPlayback) {
            // scrcpy 4.0 : sans --record, --no-audio-playback coupe TOUT l'audio
            // puis exit "nothing to do". record=NUL garde la capture (HP muet) sans son PC.
            args.push(
                "--no-audio-playback",
                "--record=NUL",
                "--record-format=opus"
            );
        }

        return args;
    }

    _attachLogging(sessionId, child) {
        child.stderr?.on("data", (chunk) => {
            const line = chunk.toString().trim();
            if (line) {
                console.log(`[SessionAudio ${sessionId}] ${line}`);
            }
        });
        child.on("exit", (code) => {
            const entry = this.processes.get(sessionId);
            if (entry?.child === child) {
                this.processes.delete(sessionId);
            }
            if (child.pid) {
                this._knownPids.delete(child.pid);
            }
            if (code && code !== 0) {
                console.warn(`[SessionAudio ${sessionId}] processus termine (code ${code})`);
            }
        });
    }

    isRunning(sessionId) {
        const entry = this.processes.get(sessionId);
        return Boolean(entry?.child && !entry.child.killed && entry.child.exitCode === null);
    }

    /** true si une capture scrcpy audio Hub tourne pour ce serial / deviceKey. */
    hasCaptureForSerial(serial, deviceKey = null) {
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();
        if (!needle && !key) return false;
        for (const [sessionId, entry] of this.processes.entries()) {
            if (!entry || !this.isRunning(sessionId)) continue;
            if (needle && entry.serial === needle) return true;
            if (key && entry.deviceKey && entry.deviceKey === key) return true;
            if (needle && entry.serial && (
                needle.startsWith(entry.serial)
                || entry.serial.startsWith(needle)
            )) {
                return true;
            }
        }
        return false;
    }

    /**
     * Réattache une capture existante (ex. launch-*) sur le vrai sessionId
     * sans relâcher REMOTE_SUBMIX.
     */
    adoptCaptureForSession(sessionId, { serial = null, deviceKey = null } = {}) {
        if (!sessionId) return false;
        if (this.isRunning(sessionId)) return true;
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();
        if (!needle && !key) return false;
        for (const [id, entry] of this.processes.entries()) {
            if (id === sessionId || !entry || !this.isRunning(id)) continue;
            // Strict : ne jamais adopter la capture d'un AUTRE device.
            const sameSerial = needle && entry.serial && entry.serial === needle;
            const sameKey = key && entry.deviceKey && entry.deviceKey === key;
            if (!sameSerial && !sameKey) continue;
            // Si les deux sont fournis et divergent du process → skip.
            if (needle && entry.serial && entry.serial !== needle) continue;
            if (key && entry.deviceKey && entry.deviceKey !== key) continue;
            this.processes.delete(id);
            this.processes.set(sessionId, entry);
            console.log(`[SessionAudio] adopt ${id} → ${sessionId} (serial=${entry.serial})`);
            return true;
        }
        return false;
    }

    /**
     * Arrête les captures pour un serial (ex. handoff launchId → sessionId),
     * en gardant éventuellement une session.
     */
    async stopBySerial(serial, { exceptSessionId = null, deviceKey = null } = {}) {
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();
        if (!needle && !key) return;
        const toStop = [];
        for (const [sessionId, entry] of this.processes.entries()) {
            if (exceptSessionId && sessionId === exceptSessionId) continue;
            if (!entry) continue;
            const sameSerial = needle && entry.serial && entry.serial === needle;
            const sameKey = key && entry.deviceKey && entry.deviceKey === key;
            if (sameSerial || sameKey) toStop.push(sessionId);
        }
        for (const sessionId of toStop) {
            await this.stop(sessionId);
        }
    }

    async stop(sessionId) {
        const entry = this.processes.get(sessionId);
        const child = entry?.child || null;
        const pid = entry?.pid || child?.pid || null;

        this.processes.delete(sessionId);

        if (!child && !pid) return;

        console.log(`[SessionAudio ${sessionId}] arret (pid=${pid || "?"})`);

        if (pid) {
            this._killPidTree(pid);
            this._knownPids.delete(pid);
        }

        try {
            if (child && !child.killed) {
                child.kill();
            }
        } catch (_) {
            /* ignore */
        }

        await new Promise((resolve) => {
            if (!child) {
                setTimeout(resolve, 150);
                return;
            }
            const timer = setTimeout(() => {
                if (pid) this._killPidTree(pid);
                resolve();
            }, 600);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /**
     * PID du process scrcpy audio pour UNE session / device (match exact — pas de préfixe).
     * Évite qu'un slider Pad 6 touche le PID d'un autre pad.
     */
    getCapturePid({ sessionId = null, serial = null, deviceKey = null } = {}) {
        if (sessionId && this.isRunning(sessionId)) {
            const pid = this.processes.get(sessionId)?.pid;
            return Number.isInteger(pid) && pid > 0 ? pid : null;
        }
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();

        // 1) Match exact deviceKey
        if (key) {
            for (const [id, entry] of this.processes.entries()) {
                if (!entry || !this.isRunning(id)) continue;
                if (entry.deviceKey === key) {
                    return Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : null;
                }
            }
        }
        // 2) Match exact serial
        if (needle) {
            for (const [id, entry] of this.processes.entries()) {
                if (!entry || !this.isRunning(id)) continue;
                if (entry.serial === needle) {
                    return Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : null;
                }
            }
        }
        return null;
    }

    async start(sessionId, {
        serial,
        displayId = null,
        deviceKey = null,
        pcPlayback = null,
        forceOwner = false
    } = {}) {
        if (!sessionId || !serial) return { success: false, error: "sessionId ou serial manquant" };

        const run = () => this._startUnlocked(sessionId, {
            serial,
            displayId,
            deviceKey,
            pcPlayback,
            forceOwner
        });
        const prev = this._startLocks.get(sessionId) || Promise.resolve();
        const next = prev.then(run, run);
        this._startLocks.set(sessionId, next);
        try {
            return await next;
        } finally {
            if (this._startLocks.get(sessionId) === next) {
                this._startLocks.delete(sessionId);
            }
        }
    }

    async _startUnlocked(sessionId, {
        serial,
        displayId = null,
        deviceKey = null,
        pcPlayback = null,
        forceOwner = false
    } = {}) {
        if (!this.scrcpyBinaryPath) return { success: false, error: "scrcpy introuvable" };

        const fs = require("fs");
        if (!fs.existsSync(this.scrcpyBinaryPath)) {
            return { success: false, error: `scrcpy introuvable: ${this.scrcpyBinaryPath}` };
        }

        const key = deviceKey || serial;
        // 1 device = 1 session audio owner (évite captures dupliquées Type A/B).
        let ownerId = this.claimAudioOwner(sessionId, key, serial);
        if (!forceOwner && ownerId && ownerId !== sessionId) {
            const ownerTarget = this._listActiveSessionTargets()
                .find((t) => t.sessionId === ownerId);
            const ownerSerial = ownerTarget
                ? (await this._resolveSerial(ownerTarget)) || null
                : null;
            const ownerKey = ownerTarget?.deviceKey || null;
            const ownerEntry = this.processes.get(ownerId);
            const runningSerial = ownerEntry?.serial || ownerSerial;
            const runningKey = ownerEntry?.deviceKey || ownerKey;
            const sameDevice = Boolean(
                (serial && runningSerial && String(serial) === String(runningSerial))
                || (key && runningKey && String(key) === String(runningKey))
            );
            if (!sameDevice) {
                // Owner map corrompue / collision entre 2 pads — ce device reprend son owner.
                console.warn(
                    `[SessionAudio] owner mismatch ${ownerId} (ser=${runningSerial}) `
                    + `≠ demande ${sessionId} (ser=${serial}) — reclaim`
                );
                const mapKey = this._ownerMapKey(key, serial);
                if (mapKey) this._audioOwners.set(mapKey, sessionId);
                if (serial) this._audioOwners.set(this._ownerMapKey(serial), sessionId);
                ownerId = sessionId;
            } else {
                return this._startUnlocked(ownerId, {
                    serial: runningSerial || serial,
                    displayId: ownerTarget?.displayId ?? displayId,
                    deviceKey: runningKey || key,
                    pcPlayback,
                    forceOwner: true
                });
            }
        }

        // Intention PC (Windows volume). La capture scrcpy garde TOUJOURS le playback
        // pour apparaître dans le mixeur Windows + tenir REMOTE_SUBMIX.
        const wantPcSound = typeof pcPlayback === "boolean"
            ? pcPlayback
            : this._wantPcPlayback(key);
        const existing = this.processes.get(sessionId);
        if (
            existing
            && existing.serial === serial
            && existing.displayId == null
            && existing.deviceKey === key
            && this.isRunning(sessionId)
            && existing.pcPlayback === true
        ) {
            // Déjà en playback (visible mixeur) : pas de restart — volume Windows seul.
            if (existing.pid) {
                // Pendant une op UI volume, l'overlay pose le % — ne pas écraser ici.
                if (!global.deviceSpeakerOverlayManager?._audioUiInFlight) {
                    const intent = global.deviceSpeakerOverlayManager?.intentPercentByKey?.get?.(key);
                    const percent = Number.isInteger(intent) && intent > 0
                        ? intent
                        : (global.deviceSpeakerOverlayManager?.defaultOnPercent || 100);
                    void global.deviceSpeakerOverlayManager?.applyWindowsPlaybackVolume?.({
                        pid: existing.pid,
                        deviceKey: key,
                        serial,
                        sessionId,
                        percent
                    });
                    void global.deviceSpeakerOverlayManager?.applyWindowsPlaybackMute?.({
                        pid: existing.pid,
                        deviceKey: key,
                        serial,
                        sessionId,
                        muted: !wantPcSound
                    });
                }
                // Renforcer identité mixeur (nom + icône) si absente.
                try {
                    const hostVol = global.deviceSpeakerOverlayManager?._hostVolume;
                    if (hostVol?.setMixerIdentity && existing.mixerDisplayName) {
                        void hostVol.setMixerIdentity(existing.pid, {
                            displayName: existing.mixerDisplayName,
                            exePath: existing.binaryPath || null,
                            force: false
                        });
                    }
                } catch (_err) {
                    /* ignore */
                }
            }
            return {
                success: true,
                reused: true,
                pcPlayback: true,
                softMuted: !wantPcSound,
                pid: existing.pid || null
            };
        }
        // existing.pcPlayback === false → fall through : upgrader vers playback (sinon invisible mixeur).

        // Audio Hub = toujours device-level (REMOTE_SUBMIX).
        // Ne JAMAIS lier au display virtuel Type B : la capture mourrait à la fermeture
        // de la 1re session → fuite HP + pas de handoff.
        const processPlayback = true;
        const args = this._buildArgs({
            serial,
            displayId: null,
            pcPlayback: processPlayback
        });
        console.log(
            `[SessionAudio ${sessionId}] demarrage scrcpy audio `
            + `(pcSound=${wantPcSound ? "on" : "off"} ; mixer-visible ; ${args.join(" ")})`
        );

        if (this.isRunning(sessionId)) {
            await this._muteDeviceSpeakerBriefly(serial);
            await this.stop(sessionId);
            await new Promise((r) => setTimeout(r, 40));
        }

        const labeled = await this._resolveLabeledScrcpyBinary(key, serial);
        const binaryPath = labeled?.binaryPath || this.scrcpyBinaryPath;
        const mixerDisplayName = labeled?.displayName || "Android Hub";

        try {
            let child = this._spawnHidden(binaryPath, args);
            let pid = child.pid || null;
            if (pid) this._knownPids.add(pid);

            this.processes.set(sessionId, {
                child,
                serial,
                displayId: null,
                pid,
                deviceKey: key,
                pcPlayback: processPlayback,
                binaryPath,
                mixerDisplayName
            });
            this._attachLogging(sessionId, child);

            const diedEarly = await this._waitEarlyExit(child, 1200);
            if (diedEarly) {
                console.warn(
                    `[SessionAudio ${sessionId}] exit precoce apres start `
                    + `(pcSound=${wantPcSound ? "on" : "off"}) — retry`
                );
                await this._muteDeviceSpeakerBriefly(serial);
                await this.stop(sessionId);
                await new Promise((r) => setTimeout(r, 300));
                // Si l'exe brandé crash, retomber sur scrcpy.exe (son prioritaire).
                let retryBinary = binaryPath;
                if (retryBinary !== this.scrcpyBinaryPath && this.scrcpyBinaryPath) {
                    const pathMod = require("path");
                    console.warn(
                        `[SessionAudio ${sessionId}] retry avec scrcpy.exe `
                        + `(brandé: ${pathMod.basename(String(retryBinary))})`
                    );
                    retryBinary = this.scrcpyBinaryPath;
                }
                child = this._spawnHidden(retryBinary, args);
                pid = child.pid || null;
                if (pid) this._knownPids.add(pid);
                this.processes.set(sessionId, {
                    child,
                    serial,
                    displayId: null,
                    pid,
                    deviceKey: key,
                    pcPlayback: processPlayback,
                    binaryPath: retryBinary,
                    mixerDisplayName
                });
                this._attachLogging(sessionId, child);
            }

            if (pid) {
                // Identité mixeur : 1 passe + 1 retry léger (pas 3× force).
                try {
                    const hostVol = global.deviceSpeakerOverlayManager?._hostVolume;
                    if (hostVol?.setMixerIdentity) {
                        const applyId = (force = false) => hostVol.setMixerIdentity(pid, {
                            displayName: mixerDisplayName,
                            exePath: binaryPath,
                            force
                        }).catch((err) => {
                            console.warn("[SessionAudio] mixer identity:", err?.message || err);
                        });
                        void applyId(true);
                        setTimeout(() => { void applyId(false); }, 900);
                    }
                } catch (_err) {
                    /* ignore */
                }
                // Volume Windows immédiat (0 si mute Hub) — SUBMIX déjà tenu, pas de fuite HP.
                if (!global.deviceSpeakerOverlayManager?._audioUiInFlight) {
                    const intent = global.deviceSpeakerOverlayManager?.intentPercentByKey?.get?.(key);
                    const percent = Number.isInteger(intent) && intent > 0
                        ? intent
                        : (global.deviceSpeakerOverlayManager?.defaultOnPercent || 100);
                    void global.deviceSpeakerOverlayManager?.applyWindowsPlaybackVolume?.({
                        pid,
                        deviceKey: key,
                        serial,
                        sessionId,
                        percent
                    });
                    void global.deviceSpeakerOverlayManager?.applyWindowsPlaybackMute?.({
                        pid,
                        deviceKey: key,
                        serial,
                        sessionId,
                        muted: !wantPcSound
                    });
                    if (wantPcSound && percent > 0) {
                        void global.deviceSpeakerOverlayManager?.reapplyHostVolumeForCapture?.({
                            pid,
                            deviceKey: key,
                            serial,
                            sessionId,
                            pcPlayback: true
                        });
                    }
                }
            }

            return {
                success: true,
                pcPlayback: processPlayback,
                pcSound: wantPcSound,
                restarted: Boolean(existing),
                retried: Boolean(diedEarly),
                pid: pid || null
            };
        } catch (err) {
            return { success: false, error: err.message || "echec spawn scrcpy audio" };
        }
    }

    /** true si le process quitte avant timeoutMs (échec démarrage audio typique). */
    _waitEarlyExit(child, timeoutMs = 800) {
        return new Promise((resolve) => {
            if (!child || child.exitCode != null) {
                resolve(true);
                return;
            }
            let done = false;
            const finish = (died) => {
                if (done) return;
                done = true;
                child.removeListener("exit", onExit);
                clearTimeout(timer);
                resolve(died);
            };
            const onExit = () => finish(true);
            const timer = setTimeout(() => finish(false), Math.max(100, timeoutMs));
            child.once("exit", onExit);
        });
    }

    async refreshForGlobalAudio() {
        await this.syncAllActiveSessions();
    }

    setResolvers({ getBrowserViewManager, getNewInstanceManager } = {}) {
        this._getBrowserViewManager = typeof getBrowserViewManager === "function" ? getBrowserViewManager : null;
        this._getNewInstanceManager = typeof getNewInstanceManager === "function" ? getNewInstanceManager : null;
    }

    /**
     * Captures scrcpy audio encore vivantes (y compris launch-* avant handoff).
     */
    getRunningCaptures() {
        const out = [];
        for (const [sessionId, entry] of this.processes.entries()) {
            if (!entry || !this.isRunning(sessionId)) continue;
            out.push({
                sessionId,
                serial: entry.serial,
                displayId: entry.displayId,
                deviceKey: entry.deviceKey || entry.serial,
                pcPlayback: Boolean(entry.pcPlayback)
            });
        }
        return out;
    }

    _listActiveSessionTargets() {
        const browserViewManager = this._getBrowserViewManager?.();
        if (!browserViewManager) return [];

        const sessions = browserViewManager.getAllSessions?.() || [];
        const targets = [];

        for (const session of sessions) {
            const sessionId = session?.sessionId;
            const entry = browserViewManager.getSessionEntry?.(sessionId);
            const niSession = entry?.type === "B"
                ? this._getNewInstanceManager?.()?.getNewInstanceSession?.(sessionId)
                : null;
            // Préférer le serial ADB (niSession / deviceId transport), pas seulement stableId.
            let serial = niSession?.serial || entry?.deviceId || session?.deviceId || null;
            if (!sessionId || !serial) continue;

            const deviceKey = this._resolveDeviceKey(entry, niSession, serial);
            let displayId = null;
            if (entry?.type === "B") {
                displayId = Number.isInteger(niSession?.displayId) ? niSession.displayId : null;
            }

            targets.push({ sessionId, serial, displayId, deviceKey, entry, niSession });
        }

        return targets;
    }

    async _resolveSerial(target) {
        let serial = target.serial;
        if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
            const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
                deviceId: target.entry?.stableDeviceId || target.niSession?.stableDeviceId || null,
                serial
            });
            if (resolved) serial = resolved;
        }
        return serial;
    }

    _matchesDeviceKey(target, deviceKey) {
        if (!deviceKey) return false;
        return target.deviceKey === deviceKey
            || target.serial === deviceKey
            || target.entry?.deviceId === deviceKey
            || target.entry?.stableDeviceId === deviceKey
            || target.niSession?.stableDeviceId === deviceKey
            || target.niSession?.serial === deviceKey;
    }

    /**
     * Garantit une capture scrcpy audio pour CE device.
     * Résout USB/WiFi via registry pour retrouver la vraie session Hub
     * (évite device-audio-* orphelin quand Pad 5/6 ne partagent pas le même serial).
     */
    async ensureCaptureForDevice({
        deviceKey = null,
        serial = null,
        pcPlayback = true,
        aliasKeys = []
    } = {}) {
        const needles = new Set(
            [deviceKey, serial, ...(Array.isArray(aliasKeys) ? aliasKeys : [])]
                .map((k) => String(k || "").trim())
                .filter(Boolean)
        );
        if (!needles.size) {
            return { success: false, error: "deviceKey/serial manquant" };
        }

        let resolvedSerial = String(serial || "").trim() || null;
        let resolvedKey = String(deviceKey || "").trim() || resolvedSerial;

        let unified = [];
        try {
            unified = await global.deviceRegistry?.listUnifiedDevices?.() || [];
        } catch (_err) {
            unified = [];
        }

        // Enrichir avec USB/WiFi du registry (Pad WiFi ≠ serial session USB, etc.).
        for (const d of unified) {
            const ids = [d.deviceId, d.serial, d.usbSerial, d.wifiSerial]
                .map((x) => String(x || "").trim())
                .filter(Boolean);
            if (!ids.some((id) => needles.has(id))) continue;
            ids.forEach((id) => needles.add(id));
            resolvedKey = d.deviceId || resolvedKey;
            // Préférer le serial ADB live (d.serial), jamais un Wi‑Fi stale en premier.
            resolvedSerial = d.serial || d.usbSerial || d.wifiSerial || resolvedSerial || null;
            if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
                try {
                    const eff = await global.deviceRegistry.resolveEffectiveAdbSerial({
                        deviceId: d.deviceId || null,
                        serial: resolvedSerial,
                        forceFresh: true
                    });
                    if (eff) {
                        resolvedSerial = eff;
                        needles.add(eff);
                    }
                } catch (_err) {
                    /* ignore */
                }
            }
            break;
        }

        let sessionId = null;
        let displayId = null;

        // Toujours la session propriétaire audio (1re ouverte Type A/B) — pas de 2e capture.
        const openSessions = await this.listOpenSessionsForDeviceAsync(resolvedKey, resolvedSerial);
        if (openSessions.length) {
            const owner = this.getAudioOwnerSessionId(resolvedKey, resolvedSerial)
                || this.claimAudioOwner(openSessions[0].sessionId, resolvedKey, resolvedSerial);
            const ownerSession = openSessions.find((s) => s.sessionId === owner) || openSessions[0];
            sessionId = ownerSession.sessionId;
            displayId = ownerSession.displayId;
            resolvedKey = ownerSession.deviceKey || resolvedKey;
            resolvedSerial = ownerSession.serial || resolvedSerial;
            this.claimAudioOwner(sessionId, resolvedKey, resolvedSerial);
        }

        // Capture déjà vivante sous un autre sessionId (ex. launch-* / device-audio-*) :
        // réutiliser / adopter vers le propriétaire plutôt que d'en créer une 2e.
        if (!sessionId) {
            for (const [id, entry] of this.processes.entries()) {
                if (!entry || !this.isRunning(id)) continue;
                const same = (entry.serial && needles.has(String(entry.serial)))
                    || (entry.deviceKey && needles.has(String(entry.deviceKey)))
                    || (resolvedSerial && entry.serial === resolvedSerial);
                if (!same) continue;
                sessionId = id;
                resolvedSerial = entry.serial || resolvedSerial;
                resolvedKey = entry.deviceKey || resolvedKey;
                displayId = Number.isInteger(entry.displayId) ? entry.displayId : displayId;
                break;
            }
        } else {
            // Adopter une capture launch-* / autre id vers le owner.
            try {
                this.adoptCaptureForSession(sessionId, {
                    serial: resolvedSerial,
                    deviceKey: resolvedKey
                });
            } catch (_err) {
                /* ignore */
            }
        }

        if (!sessionId) {
            if (!resolvedSerial) {
                return { success: false, error: "serial introuvable" };
            }
            // Pas de session Hub : capture dédiée pour piloter le volume device.
            sessionId = `device-audio-${resolvedKey || resolvedSerial}`;
            console.log(
                `[SessionAudio] ensureCapture: pas de session Hub pour ${resolvedKey}, `
                + `capture dédiée ${sessionId} (${resolvedSerial})`
            );
        }

        const result = await this.start(sessionId, {
            serial: resolvedSerial,
            displayId,
            deviceKey: resolvedKey,
            pcPlayback: Boolean(pcPlayback),
            forceOwner: Boolean(openSessions.length)
        });

        await this.dedupeCapturesPerDevice();

        // ADB 100 % seulement au vrai start/restart — pas à chaque reuse (slider device).
        if (pcPlayback && resolvedSerial && !result?.reused && !result?.skipped) {
            void global.deviceSpeakerOverlayManager?.ensureAdbVolumeMaxForAllDevices?.({
                onlySerial: resolvedSerial
            }).catch((err) => {
                console.warn("[SessionAudio] ensureAdb after ensureCapture:", err?.message || err);
            });
        }

        return {
            ...result,
            sessionId: result?.sessionId || sessionId,
            serial: resolvedSerial,
            deviceKey: resolvedKey,
            ownerSessionId: this.getAudioOwnerSessionId(resolvedKey, resolvedSerial),
            pid: result?.pid
                || this.getCapturePid({
                    sessionId: result?.sessionId || sessionId,
                    serial: resolvedSerial,
                    deviceKey: resolvedKey
                })
        };
    }

    /**
     * Cibles audio actives (une entrée par session), serial ADB résolu.
     */
    async getActiveAudioTargets() {
        const out = [];
        for (const target of this._listActiveSessionTargets()) {
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            out.push({
                sessionId: target.sessionId,
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey
            });
        }
        return out;
    }

    /**
     * Une capture scrcpy audio max par device physique.
     * Supprime les device-audio-* / non-owners en doublon dès qu'une session owner vit.
     */
    async dedupeCapturesPerDevice() {
        const running = [...this.processes.entries()]
            .filter(([id, entry]) => entry && this.isRunning(id));
        if (running.length <= 1) return;

        const parent = new Map();
        const find = (id) => {
            let p = parent.get(id) || id;
            while ((parent.get(p) || p) !== p) p = parent.get(p);
            parent.set(id, p);
            return p;
        };
        const union = (a, b) => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent.set(ra, rb);
        };

        for (const [id] of running) parent.set(id, id);

        // Même deviceKey ou même serial → même groupe.
        for (let i = 0; i < running.length; i += 1) {
            for (let j = i + 1; j < running.length; j += 1) {
                const [idA, a] = running[i];
                const [idB, b] = running[j];
                const keyA = String(a.deviceKey || "").trim();
                const keyB = String(b.deviceKey || "").trim();
                const serA = String(a.serial || "").trim();
                const serB = String(b.serial || "").trim();
                const same = (keyA && keyB && keyA === keyB)
                    || (serA && serB && serA === serB);
                if (same) union(idA, idB);
            }
        }

        /** @type {Map<string, string[]>} */
        const groups = new Map();
        for (const [id] of running) {
            const root = find(id);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root).push(id);
        }

        const score = (id) => {
            // Préférer session Hub owner, puis n'importe quelle session, puis hold.
            if (String(id).startsWith("device-audio-")) return 0;
            if (String(id).startsWith("launch-")) return 1;
            return 3;
        };

        for (const ids of groups.values()) {
            if (ids.length <= 1) continue;
            ids.sort((a, b) => score(b) - score(a) || String(a).localeCompare(String(b)));
            const keep = ids[0];
            for (const id of ids.slice(1)) {
                console.log(`[SessionAudio] dedupe stop ${id} (garde ${keep})`);
                await this.stop(id);
            }
            const entry = this.processes.get(keep);
            const mapKey = this._ownerMapKey(entry?.deviceKey, entry?.serial);
            if (mapKey && entry && !String(keep).startsWith("device-audio-")) {
                this._audioOwners.set(mapKey, keep);
            }
        }
    }

    /**
     * Une capture par device (session owner). Pas de doublon device-audio + session.
     */
    async syncAllActiveSessions() {
        const targets = this._listActiveSessionTargets();
        const activeIds = new Set();
        const activeSerials = new Set();
        const activeDeviceKeys = new Set();
        /** @type {Map<string, typeof targets[0]>} 1re session (owner) par device */
        const ownerByDevice = new Map();

        for (const target of targets) {
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            activeIds.add(target.sessionId);
            activeSerials.add(serial);
            const key = String(target.deviceKey || serial);
            if (target.deviceKey) activeDeviceKeys.add(String(target.deviceKey));
            const owner = this.claimAudioOwner(target.sessionId, key, serial);
            if (owner === target.sessionId && !ownerByDevice.has(key)) {
                ownerByDevice.set(key, { ...target, serial });
            } else if (owner === target.sessionId) {
                /* already have */
            } else if (!ownerByDevice.has(key) && owner) {
                // Owner déjà choisi ailleurs — retrouver la target owner.
                const ownerTarget = targets.find((t) => t.sessionId === owner);
                if (ownerTarget) {
                    ownerByDevice.set(key, {
                        ...ownerTarget,
                        serial: await this._resolveSerial(ownerTarget) || serial
                    });
                }
            }
        }

        // Une seule capture par device = session propriétaire.
        for (const target of ownerByDevice.values()) {
            await this.start(target.sessionId, {
                serial: target.serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey,
                forceOwner: true
            });
        }

        for (const sessionId of [...this.processes.keys()]) {
            const entry = this.processes.get(sessionId);
            if (!entry) continue;

            if (activeIds.has(sessionId)) {
                const key = entry?.deviceKey || entry?.serial;
                const owner = key ? this.getAudioOwnerSessionId(key, entry?.serial) : null;
                if (owner && owner !== sessionId) {
                    await this.stop(sessionId);
                }
                continue;
            }

            // device-audio-* : garder SEULEMENT s'il n'y a plus de session Hub pour ce device.
            if (String(sessionId).startsWith("device-audio-")) {
                const ser = String(entry.serial || "").trim();
                const key = String(entry.deviceKey || "").trim();
                const sessionStillOpen = (ser && activeSerials.has(ser))
                    || (key && activeDeviceKeys.has(key))
                    || (key && ownerByDevice.has(key));
                if (sessionStillOpen) {
                    console.log(
                        `[SessionAudio] drop hold ${sessionId} — session Hub active`
                    );
                    await this.stop(sessionId);
                    continue;
                }
                continue;
            }

            await this.stop(sessionId);
        }

        await this.dedupeCapturesPerDevice();

        // Chaque device connecté doit avoir une capture playback (visible mixeur).
        await this.ensureMixerCapturesForConnectedDevices();

        void global.deviceSpeakerOverlayManager?.ensureAdbVolumeMaxForAllDevices?.().catch((err) => {
            console.warn("[SessionAudio] ensureAdb after syncAll:", err?.message || err);
        });
    }

    /**
     * Garantit 1 capture playback (entrée mixeur Windows) par device connecté.
     * Chaque pad a son propre PID + FileDescription "Android Hub - {nom}".
     */
    async ensureMixerCapturesForConnectedDevices(opts = {}) {
        const applyVolume = opts.applyVolume !== false;
        const force = Boolean(opts.force);
        const now = Date.now();
        // Coalesce / throttle : évite boucles owner+volume+identity à chaque poll.
        if (!force && this._ensureMixerInFlight) {
            return this._ensureMixerInFlight;
        }
        if (!force && now - this._ensureMixerAt < 1200) {
            return this._lastEnsureMixerResults || [];
        }

        const run = async () => {
            const overlay = global.deviceSpeakerOverlayManager;
            // Pendant un geste UI, ne pas réécrire le volume (courses 0↔100).
            const skipVolume = !applyVolume || Boolean(overlay?._audioUiInFlight);
            let devices = [];
            try {
                if (overlay?._listConnectedDevices) {
                    devices = await overlay._listConnectedDevices() || [];
                }
            } catch (_err) {
                devices = [];
            }
            if (!devices.length) {
                try {
                    const unified = await global.deviceRegistry?.listUnifiedDevices?.({ forceFresh: false }) || [];
                    devices = unified
                        .filter((d) => d && d.connected !== false)
                        .map((d) => ({
                            deviceId: d.deviceId || null,
                            serial: d.serial || d.usbSerial || d.wifiSerial || null,
                            name: d.name || d.model || null
                        }));
                } catch (_err) {
                    devices = [];
                }
            }

            const results = [];
            for (const d of devices) {
                const deviceKey = d.deviceId || d.deviceKey || d.serial || null;
                let serial = d.serial || d.adbSerial || null;
                if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
                    try {
                        const eff = await global.deviceRegistry.resolveEffectiveAdbSerial({
                            deviceId: deviceKey,
                            serial,
                            forceFresh: false
                        });
                        if (eff) serial = eff;
                    } catch (_err) {
                        /* keep */
                    }
                }
                if (!serial) continue;

                const audio = global.globalAudioOutputManager;
                const pcSound = Boolean(audio?.isDeviceAudioEnabled?.(deviceKey || serial));

                const open = await this.listOpenSessionsForDeviceAsync(deviceKey, serial);
                const captureId = open[0]?.sessionId || `device-audio-${deviceKey || serial}`;
                const displayId = open[0]?.displayId ?? null;

                const mapKey = this._ownerMapKey(deviceKey, serial);
                const mappedOwner = mapKey ? this._audioOwners.get(mapKey) : null;
                if (mappedOwner) {
                    const mappedEntry = this.processes.get(mappedOwner);
                    if (mappedEntry?.serial && mappedEntry.serial !== serial) {
                        this._audioOwners.delete(mapKey);
                    }
                }
                this.claimAudioOwner(captureId, deviceKey || serial, serial);

                try {
                    const already = this.getCapturePid({
                        sessionId: captureId,
                        serial,
                        deviceKey
                    });
                    let started = null;
                    let pid = already;
                    if (!already) {
                        started = await this.start(captureId, {
                            serial,
                            displayId: null,
                            deviceKey: deviceKey || serial,
                            pcPlayback: true,
                            forceOwner: true
                        });
                        pid = started?.pid || this.getCapturePid({
                            sessionId: captureId,
                            serial,
                            deviceKey
                        });
                    }
                    if (!pid || !this.hasCaptureForSerial(serial, deviceKey)) {
                        const holdId = `device-audio-${deviceKey || serial}`;
                        if (!this.isRunning(holdId)) {
                            const retry = await this.start(holdId, {
                                serial,
                                displayId: null,
                                deviceKey: deviceKey || serial,
                                pcPlayback: true,
                                forceOwner: true
                            });
                            pid = retry?.pid || this.getCapturePid({
                                sessionId: holdId,
                                serial,
                                deviceKey
                            });
                        } else {
                            pid = this.getCapturePid({ sessionId: holdId, serial, deviceKey }) || pid;
                        }
                    }
                    if (!skipVolume && pid) {
                        const intent = overlay?.intentPercentByKey?.get?.(deviceKey);
                        const percent = Number.isInteger(intent) && intent > 0
                            ? intent
                            : (overlay?.defaultOnPercent || 100);
                        void overlay?.applyWindowsPlaybackVolume?.({
                            pid,
                            deviceKey,
                            adbSerial: serial,
                            percent
                        });
                        void overlay?.applyWindowsPlaybackMute?.({
                            pid,
                            deviceKey,
                            adbSerial: serial,
                            muted: !pcSound
                        });
                    }
                    results.push({
                        deviceKey,
                        serial,
                        pid,
                        ok: Boolean(pid)
                    });
                    if (!already || started?.restarted) {
                        console.log(
                            `[SessionAudio] mixer device ${d.name || deviceKey}: `
                            + `serial=${serial} pid=${pid || "NONE"} sound=${pcSound ? "on" : "off"}`
                        );
                    }
                } catch (err) {
                    console.warn(
                        `[SessionAudio] mixer ensure ${deviceKey || serial}:`,
                        err?.message || err
                    );
                    results.push({ deviceKey, serial, pid: null, ok: false });
                }
            }

            await this.dedupeCapturesPerDevice();

            const missing = results.filter((r) => !r.ok);
            if (missing.length) {
                console.warn(
                    `[SessionAudio] mixer manquant pour: `
                    + missing.map((m) => m.deviceKey || m.serial).join(", ")
                );
            }
            this._ensureMixerAt = Date.now();
            this._lastEnsureMixerResults = results;
            return results;
        };

        this._ensureMixerInFlight = run().finally(() => {
            this._ensureMixerInFlight = null;
        });
        return this._ensureMixerInFlight;
    }

    /**
     * Resync capture(s) d'UN device — redémarre si ON/OFF (pcPlayback) a changé.
     * Ne touche jamais les autres devices.
     */
    async syncDeviceSessions(deviceKey, muted) {
        const key = typeof deviceKey === "string" ? deviceKey.trim() : "";
        if (!key) return;

        for (const target of this._listActiveSessionTargets()) {
            if (!this._matchesDeviceKey(target, key)) continue;
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            const opts = {
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey || key
            };
            // muted explicite (callback device) → ne pas ré-inférer via d'autres overrides.
            if (typeof muted === "boolean") {
                opts.pcPlayback = !muted;
            }
            await this.start(target.sessionId, opts);
        }
    }

    async syncDeviceSessionsWithAliases(deviceKey, aliasKeys = [], muted) {
        const keys = [deviceKey, ...(Array.isArray(aliasKeys) ? aliasKeys : [])]
            .map((k) => String(k || "").trim())
            .filter(Boolean);
        const unique = [...new Set(keys)];
        if (!unique.length) return;

        // Une seule passe : matcher chaque session au plus une fois (évite multi-restart).
        const seen = new Set();
        for (const target of this._listActiveSessionTargets()) {
            const hit = unique.some((k) => this._matchesDeviceKey(target, k));
            if (!hit || seen.has(target.sessionId)) continue;
            seen.add(target.sessionId);
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            const opts = {
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey || deviceKey || serial
            };
            if (typeof muted === "boolean") {
                opts.pcPlayback = !muted;
            }
            await this.start(target.sessionId, opts);
        }
    }

    async stopAll() {
        const ids = [...this.processes.keys()];
        console.log(`[SessionAudio] stopAll (${ids.length} tracked, ${this._knownPids.size} pids connus)`);

        await Promise.allSettled(ids.map((id) => this.stop(id)));

        for (const pid of [...this._knownPids]) {
            console.log(`[SessionAudio] kill orphelin pid=${pid}`);
            this._killPidTree(pid);
            this._knownPids.delete(pid);
        }

        this.processes.clear();
        this._knownPids.clear();

        await this._killOrphanScrcpyAudioProcesses();
    }
}

module.exports = { SessionAudioProcessManager };
