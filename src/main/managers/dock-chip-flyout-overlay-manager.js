const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const BRIDGE = 20;

class DockChipFlyoutOverlayManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.overlayWindow = null;
        this.visible = false;
        this.bounds = { x: 0, y: 0, width: 260, height: 56 };
        this.anchor = null;
        this.readyPromise = null;

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this.hide();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);

        ipcMain.removeHandler("dock-chip-flyout:show");
        ipcMain.handle("dock-chip-flyout:show", async (_event, payload = {}) => this.show(payload));

        ipcMain.removeHandler("dock-chip-flyout:hide");
        ipcMain.handle("dock-chip-flyout:hide", async () => {
            this.hide();
            return true;
        });

        ipcMain.removeHandler("dock-chip-flyout:report-size");
        ipcMain.handle("dock-chip-flyout:report-size", async (_event, payload = {}) => {
            const width = Math.max(120, Math.round(Number(payload.width) || 200));
            const contentHeight = Math.max(36, Math.round(Number(payload.height) || 44));
            const nextW = width;
            const nextH = contentHeight + BRIDGE;
            if (
                Math.abs(nextW - this.bounds.width) < 2
                && Math.abs(nextH - this.bounds.height) < 2
            ) {
                return true;
            }
            this.bounds.width = nextW;
            this.bounds.height = nextH;
            this._placeAboveAnchor(contentHeight);
            this._syncBounds();
            return true;
        });

        ipcMain.removeHandler("dock-chip-flyout:update");
        ipcMain.handle("dock-chip-flyout:update", async (_event, payload = {}) => this.updateContent(payload));

        ipcMain.removeHandler("dock-chip-flyout:toggle-audio");
        ipcMain.handle("dock-chip-flyout:toggle-audio", async (_event, payload = {}) => {
            return this._invokeMain("toggleAudio", payload);
        });

        ipcMain.removeHandler("dock-chip-flyout:toggle-wifi");
        ipcMain.handle("dock-chip-flyout:toggle-wifi", async (_event, payload = {}) => {
            return this._invokeMain("toggleWifi", payload);
        });

        ipcMain.removeHandler("dock-chip-flyout:request-refresh");
        ipcMain.handle("dock-chip-flyout:request-refresh", async (_event, payload = {}) => {
            return this._invokeMain("refreshFlyout", payload);
        });

        ipcMain.removeHandler("dock-chip-flyout:keep-open");
        ipcMain.handle("dock-chip-flyout:keep-open", async () => {
            if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
            try {
                await this.mainWindow.webContents.executeJavaScript(
                    `window.__dockChipFlyoutHost?.keepOpen?.()`
                );
            } catch (_err) {}
            return true;
        });
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

    _placeAboveAnchor(contentHeight) {
        if (!this.anchor) return;
        const { width: cw, height: ch } = this._contentSize();
        const ax = Number(this.anchor.x) || 0;
        const ay = Number(this.anchor.y) || 0;
        const aw = Number(this.anchor.width) || 0;
        const gap = 8;
        const h = contentHeight + BRIDGE;
        let x = ax + aw / 2 - this.bounds.width / 2;
        let y = ay - contentHeight - gap;
        this.bounds.width = Math.max(120, this.bounds.width);
        this.bounds.height = h;
        this.bounds.x = Math.max(8, Math.min(x, cw - this.bounds.width - 8));
        this.bounds.y = Math.max(8, Math.min(y, ch - this.bounds.height - 8));
    }

    async _ensureWindow() {
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            return this.overlayWindow;
        }

        this.overlayWindow = new BrowserWindow({
            width: this.bounds.width,
            height: this.bounds.height,
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
                preload: path.join(__dirname, "../../preload/dockChipFlyoutPreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        this.readyPromise = this.overlayWindow.loadFile(
            path.join(__dirname, "../../renderer/dock-chip-flyout/dock-chip-flyout-overlay.html")
        );
        await this.readyPromise;
        return this.overlayWindow;
    }

    async _invokeMain(action, payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return { ok: false };
        try {
            const result = await this.mainWindow.webContents.executeJavaScript(`
                (async () => {
                    const api = window.__dockChipFlyoutHost;
                    if (!api || typeof api[${JSON.stringify(action)}] !== "function") return { ok: false };
                    return await api[${JSON.stringify(action)}](${JSON.stringify(payload || {})});
                })()
            `);
            if (result?.html && this.overlayWindow && !this.overlayWindow.isDestroyed() && this.visible) {
                this.overlayWindow.webContents.send("dock-chip-flyout:render", {
                    html: result.html,
                    deviceId: String(result.deviceId || payload.deviceId || ""),
                    serial: String(result.serial || payload.serial || ""),
                    visible: true
                });
            }
            return result || { ok: false };
        } catch (_err) {
            return { ok: false };
        }
    }

    _syncBounds() {
        if (!this.visible || !this.mainWindow || this.mainWindow.isDestroyed()) return;
        const win = this.overlayWindow;
        if (!win || win.isDestroyed()) return;
        const screen = this._clientToScreen(this.bounds.x, this.bounds.y);
        win.setBounds({
            x: screen.x,
            y: screen.y,
            width: Math.max(120, Math.round(this.bounds.width)),
            height: Math.max(48, Math.round(this.bounds.height))
        });
    }

    async show(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        const { x, y, width, height, html, deviceId, serial } = payload;
        const sameAnchor =
            this.visible
            && this.anchor
            && String(this._activeDeviceId || "") === String(deviceId || "")
            && String(this._activeSerial || "") === String(serial || "");

        this.anchor = {
            x: Number(x) || 0,
            y: Number(y) || 0,
            width: Number(width) || 0,
            height: Number(height) || 0
        };
        this._activeDeviceId = String(deviceId || "");
        this._activeSerial = String(serial || "");
        this.visible = true;

        const win = await this._ensureWindow();

        if (!sameAnchor) {
            this.bounds.width = 168;
            this.bounds.height = 140 + BRIDGE;
            this._placeAboveAnchor(140);
            this._syncBounds();
        }

        win.webContents.send("dock-chip-flyout:render", {
            html: String(html || ""),
            deviceId: String(deviceId || ""),
            serial: String(serial || ""),
            visible: true
        });

        if (!win.isVisible()) win.showInactive();
        return true;
    }

    async updateContent(payload = {}) {
        if (!this.visible || !this.overlayWindow || this.overlayWindow.isDestroyed()) {
            return false;
        }
        this._activeDeviceId = String(payload.deviceId || this._activeDeviceId || "");
        this._activeSerial = String(payload.serial || this._activeSerial || "");
        this.overlayWindow.webContents.send("dock-chip-flyout:render", {
            html: String(payload.html || ""),
            deviceId: this._activeDeviceId,
            serial: this._activeSerial,
            visible: true
        });
        return true;
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.anchor = null;
        this._activeDeviceId = "";
        this._activeSerial = "";
        const win = this.overlayWindow;
        if (win && !win.isDestroyed()) {
            win.webContents.send("dock-chip-flyout:render", { visible: false });
            win.hide();
        }
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            void this.mainWindow.webContents.executeJavaScript(
                `window.__dockChipFlyoutHost?.onOverlayHidden?.()`
            );
        }
    }

    destroy() {
        this.hide();
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        [
            "dock-chip-flyout:show",
            "dock-chip-flyout:hide",
            "dock-chip-flyout:report-size",
            "dock-chip-flyout:toggle-audio",
            "dock-chip-flyout:toggle-wifi",
            "dock-chip-flyout:request-refresh",
            "dock-chip-flyout:keep-open",
            "dock-chip-flyout:update"
        ].forEach((channel) => ipcMain.removeHandler(channel));
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
        }
        this.overlayWindow = null;
        this.readyPromise = null;
    }
}

module.exports = { DockChipFlyoutOverlayManager };
