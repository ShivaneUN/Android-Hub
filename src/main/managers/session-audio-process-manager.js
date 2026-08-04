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
        const { brandExeWithHubIdentity, resolveHubIconPath } = require("./windows-exe-icon");

        const source = this.scrcpyBinaryPath;
        if (!source || !fs.existsSync(source) || process.platform !== "win32") {
            return source;
        }
        if (this._brandedPromise) return this._brandedPromise;

        this._brandedPromise = (async () => {
            const dir = path.dirname(source);
            const branded = path.join(dir, "Android Hub Audio.exe");
            const stampPath = path.join(dir, "Android Hub Audio.exe.hub-ico");
            const iconPath = resolveHubIconPath();
            if (!iconPath || !fs.existsSync(iconPath)) {
                console.warn("[SessionAudio] icon.ico Hub introuvable — branding impossible");
                return source;
            }
            const sourceMtime = fs.statSync(source).mtimeMs;
            const iconMtime = fs.statSync(iconPath).mtimeMs;
            const stampVersion = 4;

            let stamp = null;
            if (fs.existsSync(stampPath) && fs.existsSync(branded)) {
                try {
                    stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
                } catch (_err) {
                    stamp = null;
                }
            }

            const needRebuild = !stamp
                || stamp.version !== stampVersion
                || stamp.iconOk !== true
                || stamp.sourceMtime !== sourceMtime
                || stamp.iconMtime !== iconMtime
                || stamp.source !== source;

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
            readExeFileDescription
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

        const branded = await this._ensureBrandedScrcpyTemplate();
        if (!branded || !fs.existsSync(branded) || branded === source) {
            return fallback;
        }

        const iconPath = resolveHubIconPath();
        const deviceLabel = await this._resolveDeviceMixerLabelAsync(deviceKey, serial);
        const uniqueKey = this._sanitizeMixerFileName(deviceKey || serial || "dev").slice(0, 16);
        const fileLabel = (deviceLabel && deviceLabel !== "Device")
            ? this._sanitizeMixerFileName(deviceLabel)
            : `Device ${uniqueKey}`;
        const displayName = stripExeSuffix(`Android Hub - ${deviceLabel}`);
        const dir = path.dirname(source);
        const labeledPath = path.join(dir, `Android Hub - ${fileLabel}.exe`);
        const deviceStamp = `${labeledPath}.hub-ico`;
        const brandedToken = String(fs.statSync(branded).mtimeMs);
        const stampExpected = `v6|ok|${brandedToken}|${displayName}|${deviceKey || ""}|${serial || ""}|${iconPath || ""}`;
        const okResult = { binaryPath: labeledPath, displayName, deviceLabel };

        if (fs.existsSync(labeledPath) && fs.existsSync(deviceStamp)) {
            try {
                const stampOk = fs.readFileSync(deviceStamp, "utf8").trim() === stampExpected;
                const descOk = readExeFileDescription(labeledPath) === displayName;
                if (stampOk && descOk) return okResult;
            } catch (_err) {
                /* recreate */
            }
        }

        try {
            if (fs.existsSync(labeledPath)) fs.unlinkSync(labeledPath);
        } catch (_err) {
            /* ignore */
        }
        try {
            if (fs.existsSync(deviceStamp)) fs.unlinkSync(deviceStamp);
        } catch (_err) {
            /* ignore */
        }

        try {
            fs.copyFileSync(branded, labeledPath);
        } catch (copyErr) {
            console.warn("[SessionAudio] label copy:", copyErr?.message || copyErr);
            console.warn(
                `[SessionAudio] spawn fallback template (pas de nom device) pour ${deviceKey || serial}`
            );
            return {
                binaryPath: branded,
                displayName: "Android Hub",
                deviceLabel
            };
        }

        const named = await brandExeWithHubIdentity(labeledPath, {
            iconPath,
            displayName
        });
        if (!named?.success) {
            console.warn("[SessionAudio] label brand:", named?.error || "echec");
            return okResult;
        }

        console.log(`[SessionAudio] spawn: ${path.basename(labeledPath)} ("${displayName}")`);
        try {
            fs.writeFileSync(deviceStamp, stampExpected);
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
            const sameSerial = needle && entry.serial && (
                entry.serial === needle
                || needle.startsWith(entry.serial)
                || entry.serial.startsWith(needle)
            );
            const sameKey = key && entry.deviceKey && entry.deviceKey === key;
            if (!sameSerial && !sameKey) continue;
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
            const sameSerial = needle && entry.serial && (
                entry.serial === needle
                || needle.startsWith(entry.serial)
                || entry.serial.startsWith(needle)
            );
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

    async start(sessionId, { serial, displayId = null, deviceKey = null, pcPlayback = null } = {}) {
        if (!sessionId || !serial) return { success: false, error: "sessionId ou serial manquant" };

        const run = () => this._startUnlocked(sessionId, {
            serial,
            displayId,
            deviceKey,
            pcPlayback
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

    async _startUnlocked(sessionId, { serial, displayId = null, deviceKey = null, pcPlayback = null } = {}) {
        if (!this.scrcpyBinaryPath) return { success: false, error: "scrcpy introuvable" };

        const fs = require("fs");
        if (!fs.existsSync(this.scrcpyBinaryPath)) {
            return { success: false, error: `scrcpy introuvable: ${this.scrcpyBinaryPath}` };
        }

        const key = deviceKey || serial;
        const wantPlayback = typeof pcPlayback === "boolean"
            ? pcPlayback
            : this._wantPcPlayback(key);
        const normalizedDisplayId = Number.isInteger(displayId) ? displayId : null;
        const existing = this.processes.get(sessionId);
        if (
            existing
            && existing.serial === serial
            && existing.displayId === normalizedDisplayId
            && existing.deviceKey === key
            && existing.pcPlayback === wantPlayback
            && this.isRunning(sessionId)
        ) {
            if (wantPlayback && existing.pid) {
                void global.deviceSpeakerOverlayManager?.reapplyHostVolumeForCapture?.({
                    pid: existing.pid,
                    deviceKey: key,
                    serial,
                    sessionId,
                    pcPlayback: true
                });
            }
            return {
                success: true,
                reused: true,
                pcPlayback: wantPlayback,
                pid: existing.pid || null
            };
        }

        const args = this._buildArgs({
            serial,
            displayId: normalizedDisplayId,
            pcPlayback: wantPlayback
        });
        console.log(
            `[SessionAudio ${sessionId}] demarrage scrcpy audio `
            + `(pcPlayback=${wantPlayback ? "on" : "off"} ; ${args.join(" ")})`
        );

        // Flip pcPlayback (OFF↔ON) : stop puis restart (pas de hot-swap — REMOTE_SUBMIX exclusif).
        const wasPlaybackFlip = Boolean(
            existing
            && this.isRunning(sessionId)
            && existing.serial === serial
            && existing.displayId === normalizedDisplayId
            && existing.deviceKey === key
            && existing.pcPlayback !== wantPlayback
        );

        await this.stop(sessionId);
        if (wasPlaybackFlip) {
            await new Promise((r) => setTimeout(r, 150));
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
                displayId: normalizedDisplayId,
                pid,
                deviceKey: key,
                pcPlayback: wantPlayback,
                binaryPath,
                mixerDisplayName
            });
            this._attachLogging(sessionId, child);

            const diedEarly = await this._waitEarlyExit(child, 1200);
            if (diedEarly) {
                console.warn(
                    `[SessionAudio ${sessionId}] exit precoce apres start `
                    + `(pcPlayback=${wantPlayback ? "on" : "off"}) — retry`
                );
                await this.stop(sessionId);
                await new Promise((r) => setTimeout(r, 300));
                child = this._spawnHidden(binaryPath, args);
                pid = child.pid || null;
                if (pid) this._knownPids.add(pid);
                this.processes.set(sessionId, {
                    child,
                    serial,
                    displayId: normalizedDisplayId,
                    pid,
                    deviceKey: key,
                    pcPlayback: wantPlayback,
                    binaryPath,
                    mixerDisplayName
                });
                this._attachLogging(sessionId, child);
            }

            if (pid) {
                // Identité mixeur (nom device) même si volume saute (OFF / intent 0).
                try {
                    const hostVol = global.deviceSpeakerOverlayManager?._hostVolume;
                    if (hostVol?.setMixerIdentity) {
                        const applyId = () => hostVol.setMixerIdentity(pid, {
                            displayName: mixerDisplayName,
                            exePath: binaryPath,
                            force: true
                        }).catch((err) => {
                            console.warn("[SessionAudio] mixer identity:", err?.message || err);
                        });
                        void applyId();
                        setTimeout(() => { void applyId(); }, 800);
                        setTimeout(() => { void applyId(); }, 2200);
                    }
                } catch (_err) {
                    /* ignore */
                }
                if (wantPlayback) {
                    void global.deviceSpeakerOverlayManager?.reapplyHostVolumeForCapture?.({
                        pid,
                        deviceKey: key,
                        serial,
                        sessionId,
                        pcPlayback: true,
                        mixerDisplayName
                    });
                }
            }

            return {
                success: true,
                pcPlayback: wantPlayback,
                restarted: wasPlaybackFlip,
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
            if (!resolvedSerial) {
                resolvedSerial = d.wifiSerial || d.usbSerial || d.serial || null;
            }
            if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
                try {
                    const eff = await global.deviceRegistry.resolveEffectiveAdbSerial({
                        deviceId: d.deviceId || null,
                        serial: resolvedSerial
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

        for (const target of this._listActiveSessionTargets()) {
            const tSerial = await this._resolveSerial(target);
            const ids = new Set([
                target.deviceKey,
                target.serial,
                tSerial,
                target.entry?.stableDeviceId,
                target.entry?.deviceId,
                target.niSession?.stableDeviceId,
                target.niSession?.serial
            ].map((x) => String(x || "").trim()).filter(Boolean));

            // USB/WiFi du même pad (session USB + slider WiFi, ou l'inverse).
            for (const d of unified) {
                const cand = [d.deviceId, d.serial, d.usbSerial, d.wifiSerial]
                    .map((x) => String(x || "").trim())
                    .filter(Boolean);
                if (!cand.some((id) => ids.has(id) || needles.has(id))) continue;
                cand.forEach((id) => ids.add(id));
            }

            const hit = [...ids].some((id) => needles.has(id))
                || [...needles].some((n) => this._matchesDeviceKey(target, n))
                || (tSerial && [...needles].some((n) => (
                    n === tSerial
                    || n.startsWith(tSerial)
                    || tSerial.startsWith(n)
                )));
            if (!hit) continue;

            sessionId = target.sessionId;
            displayId = target.displayId;
            resolvedKey = target.deviceKey || resolvedKey;
            resolvedSerial = tSerial || resolvedSerial || target.serial;
            break;
        }

        // Capture déjà vivante sous un autre sessionId (ex. launch-* / device-audio-*) :
        // réutiliser plutôt que d'en créer une 2e (REMOTE_SUBMIX exclusif).
        if (!sessionId) {
            for (const [id, entry] of this.processes.entries()) {
                if (!entry || !this.isRunning(id)) continue;
                const same = (entry.serial && needles.has(String(entry.serial)))
                    || (entry.deviceKey && needles.has(String(entry.deviceKey)))
                    || (resolvedSerial && entry.serial && (
                        entry.serial === resolvedSerial
                        || resolvedSerial.startsWith(entry.serial)
                        || entry.serial.startsWith(resolvedSerial)
                    ));
                if (!same) continue;
                sessionId = id;
                resolvedSerial = entry.serial || resolvedSerial;
                resolvedKey = entry.deviceKey || resolvedKey;
                displayId = Number.isInteger(entry.displayId) ? entry.displayId : displayId;
                break;
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
            pcPlayback: Boolean(pcPlayback)
        });

        // ADB 100 % seulement au vrai start/restart — pas à chaque reuse (slider device).
        if (pcPlayback && resolvedSerial && !result?.reused) {
            void global.deviceSpeakerOverlayManager?.ensureAdbVolumeMaxForAllDevices?.({
                onlySerial: resolvedSerial
            }).catch((err) => {
                console.warn("[SessionAudio] ensureAdb after ensureCapture:", err?.message || err);
            });
        }

        return {
            ...result,
            sessionId,
            serial: resolvedSerial,
            deviceKey: resolvedKey
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
     * Une capture par session, avec pcPlayback selon mute global/device.
     */
    async syncAllActiveSessions() {
        const targets = this._listActiveSessionTargets();
        const activeIds = new Set();
        const activeSerials = new Set();

        for (const target of targets) {
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            activeIds.add(target.sessionId);
            activeSerials.add(serial);
            await this.start(target.sessionId, {
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey
            });
        }

        for (const sessionId of [...this.processes.keys()]) {
            if (activeIds.has(sessionId)) continue;
            // Garder les captures "device-audio-*" tant que le serial est encore une session active.
            const entry = this.processes.get(sessionId);
            if (
                String(sessionId).startsWith("device-audio-")
                && entry?.serial
                && activeSerials.has(entry.serial)
            ) {
                continue;
            }
            await this.stop(sessionId);
        }

        // ADB 100 % sur toutes les captures en playback (connues ou device-audio-*).
        void global.deviceSpeakerOverlayManager?.ensureAdbVolumeMaxForAllDevices?.().catch((err) => {
            console.warn("[SessionAudio] ensureAdb after syncAll:", err?.message || err);
        });
    }

    /**
     * Resync capture(s) d'un device — redémarre si ON/OFF (pcPlayback) a changé.
     */
    async syncDeviceSessions(deviceKey, _muted) {
        const key = typeof deviceKey === "string" ? deviceKey.trim() : "";
        if (!key) return;

        for (const target of this._listActiveSessionTargets()) {
            if (!this._matchesDeviceKey(target, key)) continue;
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            await this.start(target.sessionId, {
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey || key
            });
        }
    }

    async syncDeviceSessionsWithAliases(deviceKey, aliasKeys = [], muted) {
        const keys = [deviceKey, ...(Array.isArray(aliasKeys) ? aliasKeys : [])]
            .map((k) => String(k || "").trim())
            .filter(Boolean);
        const unique = [...new Set(keys)];
        if (!unique.length) return;
        for (const key of unique) {
            await this.syncDeviceSessions(key, muted);
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
