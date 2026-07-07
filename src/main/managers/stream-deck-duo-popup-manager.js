const { BrowserWindow } = require("electron");
const path = require("path");

const DEFAULT_HEIGHT = 132;

class StreamDeckDuoPopupManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        /** @type {BrowserWindow | null} */
        this.popupWindow = null;
        this.visible = false;
        this.bounds = { clientX: 0, clientY: 0, width: 240, height: DEFAULT_HEIGHT };
        this.readyPromise = null;

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this._syncBounds();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);
    }

    _overlayHtmlPath() {
        return path.join(__dirname, "../../renderer/stream-deck/duo-popup-overlay.html");
    }

    _preloadPath() {
        return path.join(__dirname, "../../preload/duoPopupPreload.js");
    }

    _clientToScreen(x, y) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return { x: Math.round(x), y: Math.round(y) };
        }
        const contentBounds = this.mainWindow.getContentBounds();
        return {
            x: Math.round(contentBounds.x + x),
            y: Math.round(contentBounds.y + y)
        };
    }

    async _ensureWindow() {
        if (this.popupWindow && !this.popupWindow.isDestroyed()) {
            return this.popupWindow;
        }

        this.popupWindow = new BrowserWindow({
            width: 240,
            height: DEFAULT_HEIGHT,
            frame: false,
            transparent: false,
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
            backgroundColor: "#12141b",
            parent: this.mainWindow,
            webPreferences: {
                preload: this._preloadPath(),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        this.readyPromise = this.popupWindow.loadFile(this._overlayHtmlPath());
        await this.readyPromise;
        await this.popupWindow.webContents.executeJavaScript(`
            new Promise((resolve) => {
                if (window.__duoPopupOverlayReady) {
                    resolve(true);
                    return;
                }
                window.addEventListener("duo-popup-overlay-ready", () => resolve(true), { once: true });
            })
        `, true);

        return this.popupWindow;
    }

    _syncBounds() {
        if (!this.visible || !this.mainWindow || this.mainWindow.isDestroyed()) return;

        const win = this.popupWindow;
        if (!win || win.isDestroyed()) return;

        const screen = this._clientToScreen(this.bounds.clientX, this.bounds.clientY);
        win.setBounds({
            x: screen.x,
            y: screen.y,
            width: Math.max(180, Math.round(this.bounds.width)),
            height: Math.round(this.bounds.height || DEFAULT_HEIGHT)
        });
    }

    _sendUpdate(payload) {
        const win = this.popupWindow;
        if (!win || win.isDestroyed()) return;
        win.webContents.send("duo-popup:open", payload);
    }

    async show(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        this.visible = true;
        this.bounds = {
            clientX: Number(payload.clientX) || 0,
            clientY: Number(payload.clientY) || 0,
            width: Number(payload.width) || 240,
            height: Number(payload.height) || DEFAULT_HEIGHT
        };

        const win = await this._ensureWindow();
        this._syncBounds();
        this._sendUpdate({
            slots: payload.slots || [null, null],
            sessions: payload.sessions || [],
            labels: payload.labels || {}
        });

        if (!win.isVisible()) {
            win.show();
        }
        win.focus();
        return true;
    }

    async update(payload = {}) {
        if (!this.visible) return false;
        this._sendUpdate({
            slots: payload.slots || [null, null],
            sessions: payload.sessions || [],
            labels: payload.labels || {}
        });
        return true;
    }

    hide() {
        this.visible = false;
        const win = this.popupWindow;
        if (win && !win.isDestroyed()) {
            win.hide();
        }
    }

    destroy() {
        this.visible = false;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        if (this.popupWindow && !this.popupWindow.isDestroyed()) {
            this.popupWindow.destroy();
        }
        this.popupWindow = null;
        this.readyPromise = null;
    }
}

module.exports = { StreamDeckDuoPopupManager };
