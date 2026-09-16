const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const POPOVER_W = 280;
const ROW_H = 40;
const HEADER_H = 78;
const PAD = 16;

/**
 * Popup écran multi-device (clic droit dock) — miroir de DeviceSpeakerOverlay.
 * Global = même action que le bouton sidebar ; lignes = ON/OFF par appareil.
 */
class ScreenPowerOverlayManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.overlayWindow = null;
        this.visible = false;
        this.bounds = { x: 0, y: 0, width: POPOVER_W, height: HEADER_H + ROW_H };
        this.readyPromise = null;

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this.hide();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);

        ipcMain.removeHandler("screenPowerOverlay:show");
        ipcMain.handle("screenPowerOverlay:show", async (_event, payload = {}) => this.show(payload));

        ipcMain.removeHandler("screenPowerOverlay:hide");
        ipcMain.handle("screenPowerOverlay:hide", async () => {
            this.hide();
            return true;
        });

        ipcMain.removeHandler("screenPowerOverlay:getPanel");
        ipcMain.handle("screenPowerOverlay:getPanel", async () => this._buildPanel());

        ipcMain.removeHandler("screenPowerOverlay:toggleDevice");
        ipcMain.handle("screenPowerOverlay:toggleDevice", async (_event, payload = {}) => {
            return this._toggleDevice(payload);
        });

        ipcMain.removeHandler("screenPowerOverlay:toggleGlobal");
        ipcMain.handle("screenPowerOverlay:toggleGlobal", async () => {
            return this._toggleGlobal();
        });
    }

    _clientToScreen(x, y) {
        const contentBounds = this.mainWindow.getContentBounds();
        return {
            x: Math.round(contentBounds.x + x),
            y: Math.round(contentBounds.y + y)
        };
    }

    _sizeForDeviceCount(count) {
        const n = Math.max(1, Number(count) || 1);
        this.bounds.width = POPOVER_W;
        this.bounds.height = HEADER_H + (n * ROW_H) + PAD;
    }

    _placeAboveAnchor(anchor = {}) {
        const contentBounds = this.mainWindow.getContentBounds();
        const aw = Math.max(1, Number(anchor.width) || 40);
        const ah = Math.max(1, Number(anchor.height) || 40);
        const ax = Number(anchor.x) || 0;
        const ay = Number(anchor.y) || 0;
        const w = this.bounds.width;
        const h = this.bounds.height;
        let x = Math.round(ax + (aw / 2) - (w / 2));
        let y = Math.round(ay - h - 8);
        x = Math.max(8, Math.min(x, contentBounds.width - w - 8));
        if (y < 8) {
            y = Math.round(ay + ah + 8);
        }
        this.bounds.x = x;
        this.bounds.y = y;
    }

    async _buildPanel() {
        if (typeof global.buildScreenPowerPanel === "function") {
            return global.buildScreenPowerPanel({ allowProbe: false });
        }
        return { devices: [], globalScreenOff: false, globalScreenOn: false, enabled: false };
    }

    applyExternalPanel(payload = {}) {
        if (!this.visible) return;
        const win = this.overlayWindow;
        if (!win || win.isDestroyed()) return;

        if (payload.panel && Array.isArray(payload.panel.devices)) {
            this._sizeForDeviceCount(payload.panel.devices.length || 1);
            this._syncBounds();
            win.webContents.send("screenPowerOverlay:panel", { panel: payload.panel });
            return;
        }

        if (payload.mode === "global" && typeof payload.screenOff === "boolean") {
            void this._pushPanelOptimistic(payload.screenOff);
            return;
        }

        if (typeof payload.screenOff === "boolean") {
            void this._pushPanel();
        }
    }

    async _pushPanelOptimistic(screenOff) {
        const panel = await this._buildPanel();
        const next = {
            ...panel,
            devices: (panel.devices || []).map((d) => ({ ...d, screenOff: Boolean(screenOff) })),
            globalScreenOff: Boolean(screenOff),
            globalScreenOn: !screenOff
        };
        this._sizeForDeviceCount(next.devices.length || 1);
        this._syncBounds();
        const win = this.overlayWindow;
        if (win && !win.isDestroyed() && this.visible) {
            win.webContents.send("screenPowerOverlay:panel", { panel: next });
        }
    }

    async _pushPanel() {
        const panel = await this._buildPanel();
        this._sizeForDeviceCount(panel.devices?.length || 1);
        this._syncBounds();
        const win = this.overlayWindow;
        if (win && !win.isDestroyed() && this.visible) {
            win.webContents.send("screenPowerOverlay:panel", { panel });
        }
        return panel;
    }

    async _toggleDevice(payload = {}) {
        const screenOff = typeof payload.screenOff === "boolean"
            ? payload.screenOff
            : null;
        let result;
        if (typeof screenOff === "boolean" && typeof global.applyDeviceScreenPower === "function") {
            const adbSerial = payload.serial || null;
            result = await global.applyDeviceScreenPower({
                adbSerial,
                deviceId: payload.deviceId || adbSerial,
                stableDeviceId: payload.stableDeviceId || null,
                screenOff
            });
        } else if (typeof global.applyDeviceScreenPower === "function") {
            const panel = await this._buildPanel();
            const key = String(payload.key || "");
            const device = (panel.devices || []).find((d) => d.key === key
                || d.serial === payload.serial
                || d.stableDeviceId === payload.stableDeviceId);
            if (!device) {
                return { success: false, error: "Appareil introuvable" };
            }
            result = await global.applyDeviceScreenPower({
                adbSerial: device.serial,
                deviceId: device.deviceId,
                stableDeviceId: device.stableDeviceId,
                screenOff: !device.screenOff
            });
        } else {
            return { success: false, error: "API écran indisponible" };
        }

        await this._pushPanel();
        return result;
    }

    async _toggleGlobal() {
        const result = typeof global.applyGlobalScreenPowerToggle === "function"
            ? await global.applyGlobalScreenPowerToggle()
            : { success: false, error: "API écran indisponible" };
        await this._pushPanel();
        return result;
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
            hasShadow: true,
            thickFrame: false,
            backgroundColor: "#00000000",
            parent: this.mainWindow,
            modal: false,
            alwaysOnTop: true,
            webPreferences: {
                preload: path.join(__dirname, "../../preload/screenPowerOverlayPreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        try {
            this.overlayWindow.setAlwaysOnTop(true, "pop-up-menu");
        } catch (_err) {
            try {
                this.overlayWindow.setAlwaysOnTop(true);
            } catch (_err2) {
                // noop
            }
        }

        this.overlayWindow.on("blur", () => {
            setTimeout(() => {
                if (!this.visible) return;
                const win = this.overlayWindow;
                if (!win || win.isDestroyed()) return;
                if (!win.isFocused()) this.hide();
            }, 220);
        });

        this.readyPromise = this.overlayWindow.loadFile(
            path.join(__dirname, "../../renderer/screen-power/screen-power-overlay.html")
        );
        await this.readyPromise;
        // Attendre que le preload / DOM soit prêt avant le 1er render.
        try {
            await this.overlayWindow.webContents.executeJavaScript(
                "Boolean(window.screenPowerOverlayAPI)"
            );
        } catch (_err) {
            // noop
        }
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
            height: Math.max(100, Math.round(this.bounds.height))
        });
    }

    _setMainPopoverFlag(open) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        const flag = open ? "true" : "false";
        void this.mainWindow.webContents.executeJavaScript(`
            (() => {
                window.__screenPowerPopoverOpen = ${flag};
                const btn = document.getElementById("nav-toggle-screen");
                if (btn) btn.classList.toggle("screen-power-open", ${flag});
                return true;
            })()
        `).catch(() => {});
    }

    async show(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        try {
            // Cacher le dock hover pour ne pas manger le focus / le clic.
            if (global.dockHoverOverlayManager?.hide) {
                global.dockHoverOverlayManager.hide();
            }
            if (global.deviceSpeakerOverlayManager?.hide) {
                global.deviceSpeakerOverlayManager.hide();
            }
        } catch (_err) {
            // noop
        }

        // Ouverture : 1 probe max si aucune intention connue ; ensuite sync mémoire seule.
        const panel = typeof global.buildScreenPowerPanel === "function"
            ? await global.buildScreenPowerPanel({ allowProbe: true })
            : await this._buildPanel();
        this._sizeForDeviceCount(panel.devices?.length || 1);
        this._placeAboveAnchor(payload.anchor || {});
        this.visible = true;
        this._setMainPopoverFlag(true);

        const win = await this._ensureWindow();
        this._syncBounds();

        win.webContents.send("screenPowerOverlay:render", {
            title: String(payload.title || "Écran appareil"),
            panel
        });

        if (!win.isVisible()) {
            win.show();
        }
        try {
            win.setAlwaysOnTop(true, "pop-up-menu");
        } catch (_err) {
            try {
                win.setAlwaysOnTop(true);
            } catch (_err2) {
                // noop
            }
        }
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
        const win = this.overlayWindow;
        this.overlayWindow = null;
        if (win && !win.isDestroyed()) {
            try {
                win.destroy();
            } catch (_err) {
                // noop
            }
        }
    }
}

module.exports = { ScreenPowerOverlayManager };
