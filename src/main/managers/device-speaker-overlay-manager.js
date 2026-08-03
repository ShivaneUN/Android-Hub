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

    _isPcAudioOn(deviceId, serial) {
        const audio = this._audioManager();
        if (!audio) return true;
        if (audio.isGlobalMuted?.()) return false;
        const keys = [deviceId, serial].filter(Boolean);
        for (const key of keys) {
            if (audio.isDeviceMuted?.(key)) return false;
        }
        return true;
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
            const audioOn = this._isPcAudioOn(entry.deviceId, entry.serial || adbSerial);

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
        if (!key) return false;
        return d.deviceKey === key || d.deviceId === key || d.serial === key;
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

    async _applyPcVolume(adbSerial, percent, { opId = null, waitForPcRoute = false } = {}) {
        const volumeManager = this._volumeManager();
        if (!volumeManager || !adbSerial) {
            return { success: false, percent, volume: null, max: DEFAULT_MAX_VOLUME };
        }
        if (opId != null && opId !== this._volumeOpId) {
            return { success: true, superseded: true, percent };
        }

        // Attendre remote_submix (ON restore et OFF→0) sinon media_session tape le HP.
        if (waitForPcRoute && volumeManager.waitForRemoteAudioRoute) {
            await volumeManager.waitForRemoteAudioRoute(adbSerial, { timeoutMs: 2800 });
            if (opId != null && opId !== this._volumeOpId) {
                return { success: true, superseded: true, percent };
            }
        }

        const result = await volumeManager.setVolumePercentPcOnly(adbSerial, percent, {
            // Si la route PC n'est jamais venue, ne pas forcer le set sur le HP.
            force: false
        });
        return result;
    }

    /**
     * Slider libre 0–100.
     * % > 0 → active PC ON ; % = 0 → active OFF.
     */
    async _setDeviceVolume(payload = {}) {
        const volumeManager = this._volumeManager();
        const deviceKey = String(payload.deviceKey || payload.deviceId || "").trim();
        const adbSerial = await this._resolveDeviceSerial(payload);
        if (!volumeManager || !adbSerial) {
            return { success: false, error: "Appareil introuvable" };
        }

        const opId = ++this._volumeOpId;
        const percent = Math.max(
            0,
            Math.min(UI_MAX_PERCENT, Math.round(Number(payload.percent ?? payload.volume) || 0))
        );

        const base = this.lastPanel || await this._buildPanel();
        const device = (base.devices || []).find((d) => this._matchDeviceKey(d, payload))
            || { deviceKey, adbSerial, serial: adbSerial, deviceId: payload.deviceId || null };

        const audio = this._audioManager();
        const key = device.deviceKey || deviceKey;
        const aliases = this._deviceAliasKeys(device);

        let waitForPcRoute = false;
        if (percent > 0) {
            // Sauve le volume et active PC ON si besoin.
            this.savedPercentByKey.set(key, percent);
            this.intentPercentByKey.set(key, percent);
            if (audio && key && !this._isPcAudioOn(device.deviceId, device.serial || adbSerial)) {
                await audio.setDeviceMuted(key, false, { aliasKeys: aliases });
                this._broadcastAudioState();
                waitForPcRoute = true;
            }
        } else {
            // Slider à 0 → OFF PC : mute + volume remote_submix 0 (capture scrcpy inchangée).
            const prev = Number.isInteger(device.percent) && device.percent > 0
                ? device.percent
                : (this.savedPercentByKey.get(key) || this.intentPercentByKey.get(key) || this.defaultOnPercent);
            if (prev > 0) this.savedPercentByKey.set(key, prev);
            this.intentPercentByKey.set(key, 0);
            if (audio && key && this._isPcAudioOn(device.deviceId, device.serial || adbSerial)) {
                await audio.setDeviceMuted(key, true, { aliasKeys: aliases });
                this._broadcastAudioState();
            }
            // Attend remote avant set 0 : sinon media_session peut taper le HP.
            waitForPcRoute = true;
        }

        if (opId !== this._volumeOpId) {
            return { success: true, superseded: true, percent, panel: this.lastPanel };
        }

        // ON = niveau remote ; OFF = remote 0 (PC muet, REMOTE_SUBMIX toujours tenu → HP muet).
        let result = await this._applyPcVolume(adbSerial, percent, { opId, waitForPcRoute });
        if (opId !== this._volumeOpId) {
            return { ...result, panel: this.lastPanel };
        }

        const audioOn = percent > 0;
        const panel = {
            ...base,
            globalMuted: Boolean(this._audioManager()?.isGlobalMuted?.()),
            globalVolume: Number.isInteger(this.lastGlobalPercent)
                ? this.lastGlobalPercent
                : (base.globalVolume ?? 0),
            devices: (base.devices || []).map((d) => {
                const isTarget = deviceKey
                    ? this._matchDeviceKey(d, payload)
                    : (d.adbSerial === adbSerial || d.serial === adbSerial);
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
        return { ...result, percent, panel };
    }

    async _setGlobalVolume(payload = {}) {
        const opId = ++this._volumeOpId;
        const panelBefore = this.lastPanel || await this._buildPanel();
        const devices = panelBefore.devices || [];
        const volumeManager = this._volumeManager();
        if (!volumeManager || !devices.length) {
            return { success: false, error: "Aucun appareil", panel: panelBefore };
        }

        const percent = Math.max(
            0,
            Math.min(UI_MAX_PERCENT, Math.round(Number(payload.percent ?? payload.volume) || 0))
        );
        if (percent > 0) {
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

        const audio = this._audioManager();
        let waitForPcRoute = false;
        if (percent > 0) {
            if (audio?.isGlobalMuted?.()) {
                await audio.setGlobalMuted(false, { skipSpeakerRestore: true });
                waitForPcRoute = true;
            }
        } else if (audio && !audio.isGlobalMuted?.()) {
            // Slider global à 0 → OFF global.
            await audio.setGlobalMuted(true);
        }

        const results = [];
        for (const d of devices) {
            if (opId !== this._volumeOpId) break;
            const key = d.deviceKey || d.serial;
            if (percent > 0) {
                this.intentPercentByKey.set(key, percent);
                this.savedPercentByKey.set(key, percent);
                if (!this._isPcAudioOn(d.deviceId, d.serial || d.adbSerial)) {
                    await audio?.setDeviceMuted?.(key, false, { aliasKeys: this._deviceAliasKeys(d) });
                    waitForPcRoute = true;
                }
            } else {
                const prev = Number.isInteger(d.percent) && d.percent > 0
                    ? d.percent
                    : (this.savedPercentByKey.get(key) || this.defaultOnPercent);
                if (prev > 0) this.savedPercentByKey.set(key, prev);
                this.intentPercentByKey.set(key, 0);
                if (this._isPcAudioOn(d.deviceId, d.serial || d.adbSerial)) {
                    await audio?.setDeviceMuted?.(key, true, { aliasKeys: this._deviceAliasKeys(d) });
                }
                waitForPcRoute = true;
            }
            // ON = niveau remote ; OFF = remote 0 (PC muet, capture inchangée).
            if (!d.adbSerial) continue;
            results.push({
                serial: d.adbSerial,
                ...(await this._applyPcVolume(d.adbSerial, percent, { opId, waitForPcRoute }))
            });
        }
        this._broadcastAudioState();

        if (opId !== this._volumeOpId) {
            return { success: true, panel: this.lastPanel || panelBefore, superseded: true };
        }

        const bySerial = new Map(results.map((r) => [r.serial, r]));
        const panel = {
            ...(this.lastPanel || panelBefore),
            globalVolume: percent,
            globalMuted: Boolean(audio?.isGlobalMuted?.()),
            devices: devices.map((d) => {
                const r = bySerial.get(d.adbSerial);
                return {
                    ...d,
                    volume: Number.isInteger(r?.volume) ? r.volume : d.volume,
                    max: r?.max || d.max,
                    percent,
                    audioOn: percent > 0
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
     * OFF → mute PC + volumes/sliders à 0.
     * ON  → unmute PC + restore volume global sauvé.
     */
    async _toggleGlobalAudio() {
        const audio = this._audioManager();
        const panel = this.lastPanel || await this._buildPanel();
        const devices = panel.devices || [];
        if (!devices.length) {
            // Pas d'appareil : bascule seulement le mute maître.
            if (!audio) return { success: false, error: "Audio indisponible" };
            const result = await audio.toggleGlobalMuted();
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
     * ON/OFF = mute lecture PC seulement.
     * OFF → volume remote_submix 0 (PC silencieux), capture scrcpy gardée (HP silencieux).
     * ON  → unmute + restore volume remote (jamais forcer le HP).
     */
    async _toggleDeviceAudio(payload = {}) {
        const audio = this._audioManager();
        const key = String(payload.deviceKey || payload.deviceId || payload.serial || "").trim();
        if (!audio || !key) {
            return { success: false, error: "deviceKey manquant" };
        }

        const opId = ++this._volumeOpId;

        const base = this.lastPanel || await this._buildPanel();
        const device = this._findPanelDevice(key)
            || (base.devices || []).find((d) => (
                d.deviceKey === key || d.deviceId === key || d.serial === key
            ));
        if (!device) {
            return { success: false, error: "Appareil introuvable", panel: base };
        }

        const currentlyOn = this._isPcAudioOn(device.deviceId, device.serial || device.adbSerial);
        const goingOff = currentlyOn;
        const aliases = this._deviceAliasKeys(device);
        const intentKey = device.deviceKey || key;

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
            // Mute flag + volume remote 0 — ne redémarre pas scrcpy (REMOTE_SUBMIX reste).
            await audio.setDeviceMuted(key, true, { aliasKeys: aliases });
            if (opId !== this._volumeOpId) {
                return { success: true, superseded: true, panel: this.lastPanel || base };
            }
            if (device.adbSerial) {
                await this._applyPcVolume(device.adbSerial, 0, {
                    opId,
                    waitForPcRoute: true
                });
            }
        } else {
            nextPercent = this.savedPercentByKey.has(intentKey)
                ? this.savedPercentByKey.get(intentKey)
                : (this.intentPercentByKey.get(intentKey) || this.defaultOnPercent);
            if (!(nextPercent > 0)) nextPercent = this.defaultOnPercent;
            this.intentPercentByKey.set(intentKey, nextPercent);
            await audio.setDeviceMuted(key, false, { aliasKeys: aliases });
            if (opId !== this._volumeOpId) {
                return { success: true, superseded: true, panel: this.lastPanel || base };
            }
            // Restore niveau PC (remote_submix) sans toucher le HP.
            if (device.adbSerial) {
                await this._applyPcVolume(device.adbSerial, nextPercent, {
                    opId,
                    waitForPcRoute: true
                });
            }
        }

        if (opId !== this._volumeOpId) {
            return { success: true, superseded: true, panel: this.lastPanel || base };
        }

        this._broadcastAudioState();

        const panel = {
            ...base,
            globalMuted: Boolean(audio.isGlobalMuted?.()),
            devices: (base.devices || []).map((d) => {
                const match = d.deviceKey === device.deviceKey
                    || d.deviceId === device.deviceId
                    || (d.adbSerial && d.adbSerial === device.adbSerial);
                if (!match) return d;
                return { ...d, percent: nextPercent, audioOn: !goingOff };
            })
        };
        this.lastPanel = panel;
        this._broadcastPanel(panel);
        return { success: true, muted: goingOff, panel };
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
