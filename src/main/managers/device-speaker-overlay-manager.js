const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const {
    DEFAULT_MAX_VOLUME,
    UI_MAX_PERCENT
} = require("./device-audio-volume-manager");

const POPOVER_W = 300;
const ROW_H = 44;
const HEADER_H = 86;
const PAD = 16;

async function resolveAdbSerial({ serial = null, stableDeviceId = null } = {}) {
    if (!serial && !stableDeviceId) return null;
    if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
        try {
            const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
                deviceId: stableDeviceId || null,
                serial: serial || null
            });
            if (resolved) return resolved;
        } catch (_err) {
            // fallback
        }
    }
    return serial || null;
}

/**
 * Popup audio multi-device au-dessus des BrowserViews.
 * - ON/OFF : mute audio PC (GlobalAudioOutputManager)
 * - Sliders : volume libre 0–100% (stream PC / capture), HP device toujours silencieux
 */
class DeviceSpeakerOverlayManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.overlayWindow = null;
        this.visible = false;
        this.bounds = { x: 0, y: 0, width: POPOVER_W, height: HEADER_H + ROW_H };
        this.readyPromise = null;
        /** Dernière valeur posée via le slider global. */
        this.lastGlobalPercent = null;
        /** Dernier panneau connu. */
        this.lastPanel = null;
        this._volumeOpId = 0;
        /** Volume UI mémorisé par device (survécu au OFF). */
        this.savedPercentByKey = new Map();
        /** Volume UI courant par device (0–100). */
        this.intentPercentByKey = new Map();
        /** Volume global mémorisé avant OFF (dock + popup). */
        this.savedGlobalPercent = null;
        /** Fallback si aucun volume mémorisé à la remise ON. */
        this.defaultOnPercent = 50;
        /** true pendant _toggleDeviceAudio (évite double apply volume via callback mute). */
        this._deviceToggleInFlight = false;
        /** true pendant un drag slider device (évite applyDesired qui écrase le %). */
        this._sliderInFlight = false;

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this.hide();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);

        ipcMain.removeHandler("deviceSpeakerOverlay:show");
        ipcMain.handle("deviceSpeakerOverlay:show", async (_event, payload = {}) => this.show(payload));

        ipcMain.removeHandler("deviceSpeakerOverlay:hide");
        ipcMain.handle("deviceSpeakerOverlay:hide", async () => {
            this.hide();
            return true;
        });

        ipcMain.removeHandler("deviceSpeakerOverlay:getPanel");
        ipcMain.handle("deviceSpeakerOverlay:getPanel", async () => this._buildPanel());

        ipcMain.removeHandler("deviceSpeakerOverlay:setVolume");
        ipcMain.handle("deviceSpeakerOverlay:setVolume", async (_event, payload = {}) => {
            return this._setDeviceVolume(payload);
        });

        ipcMain.removeHandler("deviceSpeakerOverlay:setGlobalVolume");
        ipcMain.handle("deviceSpeakerOverlay:setGlobalVolume", async (_event, payload = {}) => {
            return this._setGlobalVolume(payload);
        });

        ipcMain.removeHandler("deviceSpeakerOverlay:toggleDeviceAudio");
        ipcMain.handle("deviceSpeakerOverlay:toggleDeviceAudio", async (_event, payload = {}) => {
            return this._toggleDeviceAudio(payload);
        });

        ipcMain.removeHandler("deviceSpeakerOverlay:toggleGlobalAudio");
        ipcMain.handle("deviceSpeakerOverlay:toggleGlobalAudio", async () => {
            return this._toggleGlobalAudio();
        });

        ipcMain.removeHandler("deviceSpeakerOverlay:getState");
        ipcMain.handle("deviceSpeakerOverlay:getState", async () => this._buildPanel());
    }

    _volumeManager() {
        return global.deviceAudioVolumeManager || null;
    }

    _audioManager() {
        return global.globalAudioOutputManager || null;
    }

    async _listConnectedDevices() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return [];
        try {
            const fromRenderer = await this.mainWindow.webContents.executeJavaScript(`
                (() => {
                    const list = typeof window.getCurrentDevices === "function"
                        ? window.getCurrentDevices()
                        : (typeof window.getConnectedDevices === "function" ? window.getConnectedDevices() : []);
                    return (Array.isArray(list) ? list : [])
                        .filter((d) => d && d.connected !== false)
                        .map((d) => ({
                            deviceId: d.deviceId || null,
                            serial: d.serial || null,
                            name: d.name || d.model || d.serial || d.deviceId || "Device"
                        }));
                })()
            `);
            if (Array.isArray(fromRenderer) && fromRenderer.length) return fromRenderer;
        } catch (_err) {
            // fallback registry
        }

        try {
            const unified = await global.deviceRegistry?.listUnifiedDevices?.({ forceFresh: false });
            return (Array.isArray(unified) ? unified : [])
                .filter((d) => d && d.connected !== false)
                .map((d) => ({
                    deviceId: d.deviceId || null,
                    serial: d.serial || d.usbSerial || d.wifiSerial || null,
                    name: d.name || d.model || d.serial || d.deviceId || "Device"
                }));
        } catch (_err) {
            return [];
        }
    }

    _isPcAudioOn(deviceId, serial, deviceKey = null) {
        const audio = this._audioManager();
        if (!audio) return true;
        if (audio.isGlobalMuted?.()) return false;
        const keys = [deviceKey, deviceId, serial].filter(Boolean);
        if (!keys.length) return true;
        return !audio.isDeviceMuted?.(keys[0], keys);
    }

    async _buildPanel() {
        const devicesIn = await this._listConnectedDevices();
        const audio = this._audioManager();
        const devices = [];

        for (const entry of devicesIn) {
            const adbSerial = await resolveAdbSerial({
                serial: entry.serial,
                stableDeviceId: entry.deviceId
            });
            const deviceKey = entry.deviceId || entry.serial || adbSerial;
            const audioOn = this._isPcAudioOn(
                entry.deviceId,
                entry.serial || adbSerial,
                deviceKey
            );

            let percent = 0;
            if (audioOn) {
                if (this.intentPercentByKey.has(deviceKey)) {
                    percent = this.intentPercentByKey.get(deviceKey);
                } else if (this.savedPercentByKey.has(deviceKey)) {
                    percent = this.savedPercentByKey.get(deviceKey);
                    this.intentPercentByKey.set(deviceKey, percent);
                } else {
                    percent = this.defaultOnPercent;
                    this.intentPercentByKey.set(deviceKey, percent);
                }
            } else {
                percent = 0;
            }

            devices.push({
                deviceKey,
                deviceId: entry.deviceId || null,
                serial: entry.serial || adbSerial,
                adbSerial: adbSerial || entry.serial || null,
                name: entry.name || entry.serial || "Device",
                volume: null,
                max: DEFAULT_MAX_VOLUME,
                percent,
                audioOn
            });
        }

        const percents = devices.map((d) => d.percent).filter((v) => Number.isInteger(v));
        if (this.lastGlobalPercent === null && percents.length) {
            this.lastGlobalPercent = percents[0];
        }
        const globalVolume = Number.isInteger(this.lastGlobalPercent)
            ? this.lastGlobalPercent
            : 0;

        const panel = {
            success: true,
            globalMuted: Boolean(audio?.isGlobalMuted?.()),
            globalVolume,
            globalMax: UI_MAX_PERCENT,
            devices
        };
        this.lastPanel = panel;
        return panel;
    }

    _matchDeviceKey(d, payload = {}) {
        const key = String(payload.deviceKey || payload.deviceId || "").trim();
        const serial = String(payload.serial || payload.adbSerial || "").trim();
        if (key) {
            if (d.deviceKey === key || d.deviceId === key || d.serial === key || d.adbSerial === key) {
                return true;
            }
        }
        if (serial) {
            if (d.serial === serial || d.adbSerial === serial) return true;
        }
        return false;
    }

    _deviceAliasKeys(device = {}) {
        return [...new Set([
            device.deviceKey,
            device.deviceId,
            device.serial,
            device.adbSerial
        ].filter(Boolean))];
    }

    _findPanelDevice(key) {
        const k = String(key || "").trim();
        if (!k) return null;
        return (this.lastPanel?.devices || []).find((d) => (
            d.deviceKey === k || d.deviceId === k || d.serial === k || d.adbSerial === k
        )) || null;
    }

    async _resolveDeviceSerial(payload = {}) {
        const fromPanel = (this.lastPanel?.devices || []).find((d) => this._matchDeviceKey(d, payload));
        const resolved = await resolveAdbSerial({
            serial: payload.serial || fromPanel?.serial || payload.adbSerial || null,
            stableDeviceId: payload.deviceId || payload.deviceKey || fromPanel?.deviceId || null
        });
        return resolved || payload.adbSerial || fromPanel?.adbSerial || fromPanel?.serial || null;
    }

    _broadcastAudioState() {
        const audio = this._audioManager();
        if (!audio || !this.mainWindow || this.mainWindow.isDestroyed()) return;
        try {
            const { broadcastGlobalAudioState } = require("../ipc/audioHandlers");
            if (typeof broadcastGlobalAudioState === "function") {
                broadcastGlobalAudioState(audio, () => this.mainWindow);
                return;
            }
        } catch (_err) {
            // fallback
        }
        this.mainWindow.webContents.send("audio:global-state-changed", audio.getState());
    }

    _silenceDeviceSpeaker(adbSerial) {
        // Intentionnellement no-op : forceSpeakerSilent via keyevents
        // coupait aussi le stream PC (remote_submix) après un ON.
        void adbSerial;
    }

    async _applyPcVolume(adbSerial, percent, {
        opId = null,
        waitForPcRoute = false,
        deviceKey = null
    } = {}) {
        const volumeManager = this._volumeManager();
        if (!volumeManager || !adbSerial) {
            return { success: false, percent, volume: null, max: DEFAULT_MAX_VOLUME };
        }
        if (opId != null && opId !== this._volumeOpId) {
            return { success: true, superseded: true, percent };
        }

        let routeReady = true;
        if (waitForPcRoute && volumeManager.waitForRemoteAudioRoute) {
            routeReady = await volumeManager.waitForRemoteAudioRoute(adbSerial, { timeoutMs: 4000 });
            if (opId != null && opId !== this._volumeOpId) {
                return { success: true, superseded: true, percent };
            }
        }

        const captureHeld = Boolean(
            global.sessionAudioProcessManager?.hasCaptureForSerial?.(adbSerial, deviceKey)
        );
        const uiPercent = Math.max(0, Math.round(Number(percent) || 0));

        // Pas de capture = pas de stream PC à régler (évite de taper le HP).
        if (!routeReady && !captureHeld) {
            return { success: true, skipped: true, percent: uiPercent, deferred: true };
        }

        // Notre capture tient la route : dumpsys rate parfois → forcer le set PC.
        const force = Boolean(captureHeld && !routeReady);

        const result = await volumeManager.setVolumePercentPcOnly(adbSerial, uiPercent, { force });
        if (result?.deferred && captureHeld) {
            return volumeManager.setVolumePercentPcOnly(adbSerial, uiPercent, { force: true });
        }
        return result;
    }

    /**
     * Slider libre 0–100 sur UN device.
     * 0 → OFF (--no-audio-playback) ; >0 → ON lecture + niveau remote_submix.
     */
    async _setDeviceVolume(payload = {}) {
        const volumeManager = this._volumeManager();
        const deviceKey = String(payload.deviceKey || payload.deviceId || "").trim();
        let adbSerial = String(payload.adbSerial || "").trim()
            || await this._resolveDeviceSerial(payload);
        if (!volumeManager || !adbSerial) {
            // Dernier recours : panel frais
            const base = await this._buildPanel();
            const d = (base.devices || []).find((x) => this._matchDeviceKey(x, payload));
            adbSerial = d?.adbSerial || d?.serial || null;
        }
        if (!volumeManager || !adbSerial) {
            return { success: false, error: "Appareil introuvable" };
        }

        const opId = ++this._volumeOpId;
        this._sliderInFlight = true;

        try {
            const percent = Math.max(
                0,
                Math.min(UI_MAX_PERCENT, Math.round(Number(payload.percent ?? payload.volume) || 0))
            );

            const base = await this._buildPanel();
            const device = (base.devices || []).find((d) => this._matchDeviceKey(d, {
                ...payload,
                adbSerial
            })) || { deviceKey, adbSerial, serial: adbSerial, deviceId: payload.deviceId || null };

            const audio = this._audioManager();
            const key = device.deviceKey || deviceKey || adbSerial;
            const aliases = this._deviceAliasKeys({ ...device, adbSerial });

            const audioOn = percent > 0;
            if (audioOn) {
                this.savedPercentByKey.set(key, percent);
                this.intentPercentByKey.set(key, percent);
            } else {
                const prev = Number.isInteger(device.percent) && device.percent > 0
                    ? device.percent
                    : (this.savedPercentByKey.get(key) || this.defaultOnPercent);
                if (prev > 0) this.savedPercentByKey.set(key, prev);
                this.intentPercentByKey.set(key, 0);
            }

            const patchPanel = (result = {}) => {
                const panel = {
                    ...base,
                    globalMuted: Boolean(audio?.isGlobalMuted?.()),
                    globalVolume: Number.isInteger(this.lastGlobalPercent)
                        ? this.lastGlobalPercent
                        : (base.globalVolume ?? 0),
                    devices: (base.devices || []).map((d) => {
                        const isTarget = key
                            && (d.deviceKey === key || d.deviceId === key
                                || d.serial === key || d.adbSerial === key
                                || d.adbSerial === adbSerial || d.serial === adbSerial);
                        if (!isTarget) return d;
                        return {
                            ...d,
                            adbSerial: adbSerial || d.adbSerial,
                            volume: Number.isInteger(result.volume) ? result.volume : d.volume,
                            max: result.max || d.max,
                            percent,
                            audioOn
                        };
                    })
                };
                this.lastPanel = panel;
                this._broadcastPanel(panel);
                return panel;
            };

            // UI immédiate (le son suit ensuite).
            let panel = patchPanel();

            if (!audioOn) {
                // 0 % = OFF device (coupe lecture PC, garde capture).
                if (audio && key) {
                    await audio.setDeviceMuted(key, true, { aliasKeys: aliases });
                }
                const routeOk = await volumeManager.isRemoteAudioRouteActive?.(adbSerial);
                if (routeOk) {
                    await this._applyPcVolume(adbSerial, 0, {
                        opId,
                        waitForPcRoute: false,
                        deviceKey: key
                    });
                }
                panel = patchPanel();
                return { success: true, percent, panel };
            }

            // >0 = ON + niveau. Réactive la lecture scrcpy si elle était en --no-audio-playback.
            if (audio && key && !this._isPcAudioOn(device.deviceId, device.serial || adbSerial, key)) {
                await audio.setDeviceMuted(key, false, { aliasKeys: aliases });
            } else if (global.sessionAudioProcessManager?.syncDeviceSessionsWithAliases) {
                // Déjà "ON" en flag mais process peut encore être sans playback.
                await global.sessionAudioProcessManager.syncDeviceSessionsWithAliases(
                    key,
                    aliases,
                    false
                );
            }

            // Attendre remote puis poser le % (retries : dumpsys flaky sur multi-device).
            let result = { success: false, deferred: true };
            for (let attempt = 0; attempt < 6; attempt += 1) {
                if (opId !== this._volumeOpId) break;
                result = await this._applyPcVolume(adbSerial, percent, {
                    opId,
                    waitForPcRoute: true,
                    deviceKey: key
                });
                if (result?.success && !result?.deferred && !result?.skipped) break;
                await new Promise((r) => setTimeout(r, 250));
            }

            panel = patchPanel(result);
            return { ...result, success: true, percent, panel };
        } finally {
            this._sliderInFlight = false;
        }
    }

    /**
     * Serials à muter : panel connecté ∪ sessions audio actives (aucun device oublié).
     */
    async _collectAudioMuteTargets(panelDevices = []) {
        const bySerial = new Map();

        for (const d of panelDevices) {
            const key = d.deviceKey || d.deviceId || d.serial;
            const adbSerial = d.adbSerial
                || await this._resolveDeviceSerial({
                    deviceKey: key,
                    deviceId: d.deviceId,
                    serial: d.serial,
                    adbSerial: d.adbSerial
                });
            if (!adbSerial) continue;
            bySerial.set(adbSerial, {
                deviceKey: key || adbSerial,
                adbSerial,
                aliases: this._deviceAliasKeys({ ...d, adbSerial })
            });
        }

        const targets = await global.sessionAudioProcessManager?.getActiveAudioTargets?.() || [];
        for (const t of targets) {
            if (!t?.serial || bySerial.has(t.serial)) continue;
            bySerial.set(t.serial, {
                deviceKey: t.deviceKey || t.serial,
                adbSerial: t.serial,
                aliases: [t.deviceKey, t.serial].filter(Boolean)
            });
        }

        return [...bySerial.values()];
    }

    /**
     * Maître global (comme screen OFF) :
     * OFF → tous les devices OFF (flags reset + volume 0 sur chaque capture)
     * ON  → tous les devices ON (flags reset + volume restore sur chaque capture)
     * Reprend toujours le dessus sur les overrides per-device.
     */
    async _setGlobalVolume(payload = {}) {
        const opId = ++this._volumeOpId;
        const panelBefore = await this._buildPanel();
        const devices = panelBefore.devices || [];
        const volumeManager = this._volumeManager();
        const audio = this._audioManager();
        if (!volumeManager) {
            return { success: false, error: "Volume indisponible", panel: panelBefore };
        }

        const percent = Math.max(
            0,
            Math.min(UI_MAX_PERCENT, Math.round(Number(payload.percent ?? payload.volume) || 0))
        );
        const goingOn = percent > 0;

        if (goingOn) {
            this.savedGlobalPercent = percent;
        } else {
            const prev = Number.isInteger(this.lastGlobalPercent) && this.lastGlobalPercent > 0
                ? this.lastGlobalPercent
                : (Number.isInteger(panelBefore.globalVolume) && panelBefore.globalVolume > 0
                    ? panelBefore.globalVolume
                    : null);
            if (prev > 0) this.savedGlobalPercent = prev;
        }
        this.lastGlobalPercent = percent;

        // 1) Une capture par session active (REMOTE_SUBMIX) — obligatoire avant volume.
        if (global.sessionAudioProcessManager?.syncAllActiveSessions) {
            await global.sessionAudioProcessManager.syncAllActiveSessions();
        }

        // 2) Maître global : reset overrides, tout le monde suit.
        if (audio) {
            if (goingOn) {
                await audio.setGlobalMuted(false, {
                    skipSpeakerRestore: true,
                    resetDevices: true
                });
            } else {
                await audio.setGlobalMuted(true, {
                    skipSpeakerRestore: true,
                    resetDevices: true
                });
            }
        }

        // 3) Volume sur CHAQUE serial (panel ∪ sessions) — aucun device oublié.
        const targets = await this._collectAudioMuteTargets(devices);
        const results = [];
        for (const t of targets) {
            if (opId !== this._volumeOpId) break;
            const key = t.deviceKey;
            if (goingOn) {
                this.intentPercentByKey.set(key, percent);
                this.savedPercentByKey.set(key, percent);
                // Map déjà clear : pas besoin setDeviceMuted (évite callbacks en boucle).
            } else {
                const prev = this.savedPercentByKey.get(key)
                    || this.intentPercentByKey.get(key)
                    || this.defaultOnPercent;
                if (prev > 0) this.savedPercentByKey.set(key, prev);
                this.intentPercentByKey.set(key, 0);
            }
            results.push({
                serial: t.adbSerial,
                ...(await this._applyPcVolume(t.adbSerial, goingOn ? percent : 0, {
                    opId,
                    waitForPcRoute: true,
                    deviceKey: key
                }))
            });
        }

        this._broadcastAudioState();

        if (opId !== this._volumeOpId) {
            return { success: true, panel: this.lastPanel || panelBefore, superseded: true };
        }

        const bySerial = new Map(results.map((r) => [r.serial, r]));
        const panel = {
            ...panelBefore,
            globalVolume: percent,
            globalMuted: Boolean(audio?.isGlobalMuted?.()),
            devices: devices.map((d) => {
                const serial = d.adbSerial || d.serial;
                const r = bySerial.get(d.adbSerial) || bySerial.get(d.serial) || bySerial.get(serial);
                return {
                    ...d,
                    volume: Number.isInteger(r?.volume) ? r.volume : d.volume,
                    max: r?.max || d.max,
                    percent,
                    audioOn: goingOn
                };
            })
        };
        this.lastPanel = panel;
        this._broadcastPanel(panel);
        return {
            success: true,
            globalMuted: Boolean(audio?.isGlobalMuted?.()),
            panel
        };
    }

    /**
     * ON/OFF global (dock clic gauche + icône popup).
     * OFF → TOUS les devices OFF ; ON → TOUS les devices ON.
     * Reprend toujours le dessus (comme screen OFF).
     */
    async _toggleGlobalAudio() {
        const audio = this._audioManager();
        const panel = await this._buildPanel();
        const devices = panel.devices || [];
        const sessionTargets = await global.sessionAudioProcessManager?.getActiveAudioTargets?.() || [];

        if (!devices.length && !sessionTargets.length) {
            if (!audio) return { success: false, error: "Audio indisponible" };
            const result = await audio.setGlobalMuted(!audio.isGlobalMuted?.(), {
                resetDevices: true
            });
            this._broadcastAudioState();
            return { success: true, globalMuted: Boolean(result?.globalMuted), panel };
        }

        const gVol = Number.isInteger(this.lastGlobalPercent)
            ? this.lastGlobalPercent
            : (Number.isInteger(panel.globalVolume) ? panel.globalVolume : 0);
        const anyDeviceOn = devices.some((d) => d.audioOn);
        const currentlyOn = Boolean(audio && !audio.isGlobalMuted?.() && (gVol > 0 || anyDeviceOn));

        if (currentlyOn) {
            if (gVol > 0) this.savedGlobalPercent = gVol;
            return this._setGlobalVolume({ percent: 0 });
        }

        const restore = Number.isInteger(this.savedGlobalPercent) && this.savedGlobalPercent > 0
            ? this.savedGlobalPercent
            : this.defaultOnPercent;
        return this._setGlobalVolume({ percent: restore });
    }

    /**
     * ON/OFF d'UN device (indépendant après interaction).
     * N'affecte que ce serial. Si ON depuis global OFF → lève le maître
     * et laisse les autres en OFF (indépendance locale).
     * Un prochain global OFF/ON reprendra le dessus sur tout le monde.
     */
    async _toggleDeviceAudio(payload = {}) {
        const audio = this._audioManager();
        const key = String(
            payload.deviceKey || payload.deviceId || payload.serial || payload.adbSerial || ""
        ).trim();
        if (!audio || !key) {
            return { success: false, error: "deviceKey manquant" };
        }

        const opId = ++this._volumeOpId;
        this._deviceToggleInFlight = true;

        try {
            const base = await this._buildPanel();
            const payloadSerial = String(payload.serial || payload.adbSerial || "").trim();
            const payloadDeviceId = String(payload.deviceId || "").trim();
            const device = (base.devices || []).find((d) => (
                d.deviceKey === key
                || d.deviceId === key
                || d.serial === key
                || d.adbSerial === key
                || (payloadSerial && (d.serial === payloadSerial || d.adbSerial === payloadSerial))
                || (payloadDeviceId && d.deviceId === payloadDeviceId)
            ));
            if (!device) {
                return { success: false, error: "Appareil introuvable", panel: base };
            }

            const deviceKeyForMute = device.deviceKey || device.deviceId || device.serial || key;
            // Intention UI prioritaire (évite Pad bloqué à 50% si map/UI désynchro).
            let goingOff;
            if (typeof payload.wantOff === "boolean") {
                goingOff = payload.wantOff;
            } else if (typeof payload.wantOn === "boolean") {
                goingOff = !payload.wantOn;
            } else {
                goingOff = this._isPcAudioOn(
                    device.deviceId,
                    device.serial || device.adbSerial,
                    device.deviceKey
                );
            }
            const aliases = this._deviceAliasKeys(device);
            const intentKey = device.deviceKey || key;
            const muteKey = deviceKeyForMute;
            const wasGlobalMuted = Boolean(audio.isGlobalMuted?.());

            const isSameDevice = (d) => {
                if (!d) return false;
                if (device.deviceKey && d.deviceKey === device.deviceKey) return true;
                if (device.deviceId && d.deviceId === device.deviceId) return true;
                if (device.adbSerial && d.adbSerial === device.adbSerial) return true;
                if (device.serial && d.serial === device.serial) return true;
                return false;
            };

            // Appliquer le mute flag + sync AVANT tout return superseded,
            // puis toujours renvoyer un panel cohérent pour CE device.
            let nextPercent = 0;
            if (goingOff) {
                const current = Number.isInteger(device.percent) && device.percent > 0
                    ? device.percent
                    : (this.savedPercentByKey.get(intentKey)
                        || this.intentPercentByKey.get(intentKey)
                        || this.defaultOnPercent);
                if (current > 0) this.savedPercentByKey.set(intentKey, current);
                this.intentPercentByKey.set(intentKey, 0);
                nextPercent = 0;
                await audio.setDeviceMuted(muteKey, true, { aliasKeys: aliases });
            } else {
                nextPercent = this.savedPercentByKey.has(intentKey)
                    ? this.savedPercentByKey.get(intentKey)
                    : this.defaultOnPercent;
                if (!(nextPercent > 0)) nextPercent = this.defaultOnPercent;
                this.intentPercentByKey.set(intentKey, nextPercent);

                const siblings = wasGlobalMuted
                    ? (base.devices || []).filter((d) => !isSameDevice(d))
                    : [];

                await audio.setDeviceMuted(muteKey, false, { aliasKeys: aliases });

                for (const other of siblings) {
                    const otherKey = other.deviceKey || other.deviceId || other.serial;
                    if (!otherKey) continue;
                    const otherIntent = other.deviceKey || otherKey;
                    const prev = Number.isInteger(other.percent) && other.percent > 0
                        ? other.percent
                        : (this.savedPercentByKey.get(otherIntent) || this.defaultOnPercent);
                    if (prev > 0) this.savedPercentByKey.set(otherIntent, prev);
                    this.intentPercentByKey.set(otherIntent, 0);
                    await audio.setDeviceMuted(otherKey, true, {
                        aliasKeys: this._deviceAliasKeys(other),
                        silent: true
                    });
                    if (global.sessionAudioProcessManager?.syncDeviceSessionsWithAliases) {
                        await global.sessionAudioProcessManager.syncDeviceSessionsWithAliases(
                            otherKey,
                            this._deviceAliasKeys(other),
                            true
                        );
                    }
                }
            }

            const buildResultPanel = () => {
                const panel = {
                    ...base,
                    globalMuted: Boolean(audio.isGlobalMuted?.()),
                    globalVolume: Number.isInteger(this.lastGlobalPercent)
                        ? this.lastGlobalPercent
                        : (base.globalVolume ?? 0),
                    devices: (base.devices || []).map((d) => {
                        if (isSameDevice(d)) {
                            return { ...d, percent: nextPercent, audioOn: !goingOff };
                        }
                        if (!goingOff && wasGlobalMuted) {
                            return { ...d, percent: 0, audioOn: false };
                        }
                        return d;
                    })
                };
                this.lastPanel = panel;
                return panel;
            };

            // Panel à jour même si une op volume concurrente arrive ensuite.
            const panelAfterMute = buildResultPanel();
            this._broadcastPanel(panelAfterMute);
            this._broadcastAudioState();

            if (opId !== this._volumeOpId) {
                return { success: true, muted: goingOff, panel: panelAfterMute, superseded: true };
            }

            const adbSerial = device.adbSerial
                || await this._resolveDeviceSerial({
                    deviceKey: muteKey,
                    deviceId: device.deviceId,
                    serial: device.serial,
                    adbSerial: device.adbSerial
                });

            if (adbSerial && !goingOff) {
                // ON : restore % (50 par défaut) sur remote_submix seulement.
                await this._applyPcVolume(adbSerial, nextPercent, {
                    opId,
                    waitForPcRoute: true,
                    deviceKey: muteKey
                });
            } else if (adbSerial && goingOff) {
                // OFF : PC déjà coupé via --no-audio-playback ; volume 0 si route OK.
                const vm = this._volumeManager();
                const routeOk = await vm?.isRemoteAudioRouteActive?.(adbSerial);
                if (routeOk) {
                    await this._applyPcVolume(adbSerial, 0, {
                        opId,
                        waitForPcRoute: false,
                        deviceKey: muteKey
                    });
                }
            }

            const panel = buildResultPanel();
            this._broadcastPanel(panel);
            return { success: true, muted: goingOff, panel };
        } finally {
            this._deviceToggleInFlight = false;
        }
    }

    async syncSlidersFromAudioState(_options = {}) {
        // UI only — jamais de force volume ADB à 0 ici.
        const panel = await this._buildPanel();
        const anyOn = (panel.devices || []).some((d) => d.audioOn);
        if (!anyOn) this.lastGlobalPercent = 0;
        else if (!Number.isInteger(this.lastGlobalPercent)) {
            this.lastGlobalPercent = this.defaultOnPercent;
        }
        panel.globalVolume = Number.isInteger(this.lastGlobalPercent)
            ? this.lastGlobalPercent
            : 0;
        this._broadcastPanel(panel);
        return panel;
    }

    async muteAllDeviceSpeakers() {
        return this.syncSlidersFromAudioState({ silenceDeviceSpeakers: false });
    }

    async restoreAllDeviceSpeakers() {
        return this.syncSlidersFromAudioState({ silenceDeviceSpeakers: true });
    }

    /**
     * Pose immédiatement l'intention UI Hub (slider AUDIO 0% / %) d'après le toggle,
     * sans attendre la capture. Utilisé au tout début du lancement session.
     * touchGlobal=false : ne pas écraser le slider global (autres devices).
     */
    markLaunchAudioIntent({ deviceKey = null, muted = true, touchGlobal = true } = {}) {
        const intentKey = String(deviceKey || "").trim();
        if (!intentKey) return;
        if (muted) {
            if (!this.savedPercentByKey.has(intentKey)) {
                this.savedPercentByKey.set(intentKey, this.defaultOnPercent);
            }
            this.intentPercentByKey.set(intentKey, 0);
            if (touchGlobal) this.lastGlobalPercent = 0;
        } else {
            let percent = this.savedPercentByKey.get(intentKey)
                || this.intentPercentByKey.get(intentKey)
                || this.defaultOnPercent;
            if (!(percent > 0)) percent = this.defaultOnPercent;
            this.intentPercentByKey.set(intentKey, percent);
            if (touchGlobal && (!Number.isInteger(this.lastGlobalPercent) || this.lastGlobalPercent <= 0)) {
                this.lastGlobalPercent = percent;
            }
        }
    }

    /**
     * Au lancement d'une session : OFF→0% / ON→~50% via le slider Hub + capture PC.
     * Pas de mute device : le volume remote_submix suit uniquement le %.
     */
    async applyLaunchAudioForDevice({
        deviceKey = null,
        adbSerial = null,
        muted = true,
        touchGlobal = true
    } = {}) {
        const key = String(deviceKey || "").trim();
        const serial = adbSerial || null;
        if (!serial) {
            return { success: false, error: "serial manquant" };
        }

        const intentKey = key || serial;
        const isMuted = Boolean(muted);
        this.markLaunchAudioIntent({ deviceKey: intentKey, muted: isMuted, touchGlobal });
        let percent = isMuted
            ? 0
            : (this.intentPercentByKey.get(intentKey) || this.defaultOnPercent);

        const volumeManager = this._volumeManager();
        const sap = global.sessionAudioProcessManager;

        // Attendre que la capture Hub tienne REMOTE_SUBMIX.
        for (let i = 0; i < 20; i += 1) {
            if (sap?.hasCaptureForSerial?.(serial, intentKey)) break;
            await new Promise((r) => setTimeout(r, 200));
        }

        if (volumeManager?.waitForRemoteAudioRoute) {
            await volumeManager.waitForRemoteAudioRoute(serial, { timeoutMs: 4500 });
        }

        let result = { success: false };
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const captureHeld = Boolean(sap?.hasCaptureForSerial?.(serial, intentKey));
            const routeOk = Boolean(await volumeManager?.isRemoteAudioRouteActive?.(serial));
            if (!captureHeld && !routeOk) {
                await new Promise((r) => setTimeout(r, 250));
                continue;
            }
            // Forcer le set seulement si la capture tient déjà la route (évite de taper le HP).
            const force = Boolean(captureHeld);
            result = await volumeManager.setVolumePercentPcOnly(serial, percent, {
                force,
                showUi: false
            });
            if (result?.success && !result?.deferred) break;
            await new Promise((r) => setTimeout(r, 250));
        }

        try {
            await this.syncSlidersFromAudioState();
        } catch (_err) {
            /* ignore */
        }

        return { ...result, percent, muted: isMuted, adbSerial: serial };
    }

    /**
     * Comme screenOff au lancement : applique l'intention audio PC courante
     * (0 si muet, % sauvé / 50 sinon) une fois remote_submix prêt.
     */
    async applyDesiredPcVolumeForDevice({
        deviceKey = null,
        adbSerial = null,
        muted = null
    } = {}) {
        const audio = this._audioManager();
        const key = String(deviceKey || "").trim();
        let serial = adbSerial || null;

        if (!serial && key) {
            if (!this.lastPanel?.devices?.length) {
                try {
                    await this._buildPanel();
                } catch (_err) {
                    /* ignore */
                }
            }
            const fromPanel = this._findPanelDevice(key)
                || (this.lastPanel?.devices || []).find((d) => (
                    d.deviceKey === key || d.deviceId === key || d.serial === key || d.adbSerial === key
                ));
            serial = fromPanel?.adbSerial || fromPanel?.serial || null;
            if (!serial) {
                const targets = await global.sessionAudioProcessManager?.getActiveAudioTargets?.() || [];
                const match = targets.find((t) => (
                    t.deviceKey === key
                    || t.serial === key
                    || (fromPanel && (
                        t.deviceKey === fromPanel.deviceKey
                        || t.serial === fromPanel.adbSerial
                        || t.serial === fromPanel.serial
                    ))
                ));
                serial = match?.serial || null;
            }
            if (!serial) {
                serial = await resolveAdbSerial({
                    serial: fromPanel?.serial || key,
                    stableDeviceId: fromPanel?.deviceId || key
                });
            }
        }
        if (!serial) {
            return { success: false, error: "serial manquant" };
        }

        const intentKey = key || serial;
        const isMuted = typeof muted === "boolean"
            ? muted
            : !audio?.isDeviceAudioEnabled?.(intentKey);

        let percent = 0;
        if (isMuted) {
            const prev = this.intentPercentByKey.get(intentKey);
            if (Number.isInteger(prev) && prev > 0) {
                this.savedPercentByKey.set(intentKey, prev);
            } else if (!this.savedPercentByKey.has(intentKey)) {
                this.savedPercentByKey.set(intentKey, this.defaultOnPercent);
            }
            this.intentPercentByKey.set(intentKey, 0);
            percent = 0;
        } else {
            percent = this.savedPercentByKey.has(intentKey)
                ? this.savedPercentByKey.get(intentKey)
                : (this.intentPercentByKey.get(intentKey) || this.defaultOnPercent);
            if (!(percent > 0)) percent = this.defaultOnPercent;
            this.intentPercentByKey.set(intentKey, percent);
        }

        const result = await this._applyPcVolume(serial, percent, {
            opId: null,
            waitForPcRoute: true,
            deviceKey: intentKey
        });
        return { ...result, percent, muted: isMuted, adbSerial: serial };
    }

    /**
     * Applique l'intention audio à chaque device qui a une session (capture) active.
     */
    async applyDesiredPcVolumeForActiveSessions() {
        const targets = await global.sessionAudioProcessManager?.getActiveAudioTargets?.() || [];
        const seen = new Set();
        const results = [];
        for (const target of targets) {
            const serial = target.serial;
            if (!serial || seen.has(serial)) continue;
            seen.add(serial);
            results.push(await this.applyDesiredPcVolumeForDevice({
                deviceKey: target.deviceKey || serial,
                adbSerial: serial,
                muted: null
            }));
        }
        return { success: true, results };
    }

    _broadcastPanel(panel) {
        if (panel) this.lastPanel = panel;
        const win = this.overlayWindow;
        if (win && !win.isDestroyed() && this.visible) {
            win.webContents.send("deviceSpeakerOverlay:panel", panel);
        }
    }

    _clientToScreen(x, y) {
        const contentBounds = this.mainWindow.getContentBounds();
        return {
            x: Math.round(contentBounds.x + x),
            y: Math.round(contentBounds.y + y)
        };
    }

    _contentSize() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return { width: 1280, height: 720 };
        }
        const [width, height] = this.mainWindow.getContentSize();
        return { width, height };
    }

    _sizeForDeviceCount(count) {
        const rows = Math.max(1, count);
        const height = Math.min(
            HEADER_H + rows * ROW_H + PAD,
            Math.max(140, this._contentSize().height - 24)
        );
        this.bounds.width = POPOVER_W;
        this.bounds.height = height;
    }

    _placeAboveAnchor(anchor = {}) {
        const { width: cw, height: ch } = this._contentSize();
        const ax = Number(anchor.x) || 0;
        const ay = Number(anchor.y) || 0;
        const aw = Number(anchor.width) || 0;
        const ah = Number(anchor.height) || 28;
        const gap = 10;
        let x = ax + aw / 2 - this.bounds.width / 2;
        let y = ay - this.bounds.height - gap;
        if (y < 8) {
            y = ay + ah + gap;
        }
        this.bounds.x = Math.max(8, Math.min(x, cw - this.bounds.width - 8));
        this.bounds.y = Math.max(8, Math.min(y, ch - this.bounds.height - 8));
    }

    async _ensureWindow() {
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            return this.overlayWindow;
        }

        this.overlayWindow = new BrowserWindow({
            width: POPOVER_W,
            height: HEADER_H + ROW_H,
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            closable: false,
            focusable: true,
            skipTaskbar: true,
            show: false,
            hasShadow: false,
            thickFrame: false,
            backgroundColor: "#00000000",
            parent: this.mainWindow,
            modal: false,
            webPreferences: {
                preload: path.join(__dirname, "../../preload/deviceSpeakerOverlayPreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        this.overlayWindow.on("blur", () => {
            setTimeout(() => {
                if (!this.visible) return;
                const win = this.overlayWindow;
                if (!win || win.isDestroyed()) return;
                if (!win.isFocused()) this.hide();
            }, 180);
        });

        this.readyPromise = this.overlayWindow.loadFile(
            path.join(__dirname, "../../renderer/device-speaker/device-speaker-overlay.html")
        );
        await this.readyPromise;
        return this.overlayWindow;
    }

    _syncBounds() {
        if (!this.visible || !this.mainWindow || this.mainWindow.isDestroyed()) return;
        const win = this.overlayWindow;
        if (!win || win.isDestroyed()) return;
        const screen = this._clientToScreen(this.bounds.x, this.bounds.y);
        win.setBounds({
            x: screen.x,
            y: screen.y,
            width: Math.max(220, Math.round(this.bounds.width)),
            height: Math.max(120, Math.round(this.bounds.height))
        });
    }

    _setMainPopoverFlag(open) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        const flag = open ? "true" : "false";
        void this.mainWindow.webContents.executeJavaScript(`
            window.__deviceSpeakerPopoverOpen = ${flag};
            const btn = document.getElementById("nav-toggle-global-audio");
            if (btn) btn.classList.toggle("speaker-volume-open", ${flag});
        `).catch(() => {});
    }

    async show(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        // Nouvelle ouverture : ré-estimer le global depuis l'état devices (tous égaux ou 1er).
        this.lastGlobalPercent = null;
        const panel = await this._buildPanel();
        this._sizeForDeviceCount(panel.devices.length || 1);
        this._placeAboveAnchor(payload.anchor || {});
        this.visible = true;
        this._setMainPopoverFlag(true);

        const win = await this._ensureWindow();
        this._syncBounds();

        win.webContents.send("deviceSpeakerOverlay:render", {
            title: String(payload.title || "Audio"),
            panel
        });

        if (!win.isVisible()) win.show();
        try {
            if (typeof win.moveTop === "function") win.moveTop();
            win.focus();
        } catch (_err) {
            // noop
        }
        return true;
    }

    hide() {
        const wasVisible = this.visible;
        this.visible = false;
        this._setMainPopoverFlag(false);
        const win = this.overlayWindow;
        if (wasVisible && win && !win.isDestroyed()) win.hide();
    }

    destroy() {
        this.visible = false;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        for (const channel of [
            "deviceSpeakerOverlay:show",
            "deviceSpeakerOverlay:hide",
            "deviceSpeakerOverlay:getPanel",
            "deviceSpeakerOverlay:getState",
            "deviceSpeakerOverlay:setVolume",
            "deviceSpeakerOverlay:setGlobalVolume",
            "deviceSpeakerOverlay:toggleDeviceAudio"
        ]) {
            ipcMain.removeHandler(channel);
        }
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
        }
        this.overlayWindow = null;
    }
}

module.exports = { DeviceSpeakerOverlayManager };
