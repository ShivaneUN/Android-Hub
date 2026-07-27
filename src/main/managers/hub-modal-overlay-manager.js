const { BrowserWindow } = require("electron");
const path = require("path");

class HubModalOverlayManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        /** @type {BrowserWindow | null} */
        this.overlayWindow = null;
        this.readyPromise = null;
        this.currentPanel = null;

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this._syncBounds();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();
        this._onMainFocus = () => this._restoreIfOpen();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);
        mainWindow.on("focus", this._onMainFocus);
    }

    _restoreIfOpen() {
        if (!this.currentPanel) return;
        const win = this.overlayWindow;
        if (!win || win.isDestroyed()) return;
        if (win.isVisible()) return;
        this._syncBounds();
        win.show();
    }

    _htmlPath() {
        return path.join(__dirname, "../../renderer/hub-modal/hub-modal-window.html");
    }

    _preloadPath() {
        return path.join(__dirname, "../../preload/preload.js");
    }

    _syncBounds() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        const win = this.overlayWindow;
        if (!win || win.isDestroyed() || !win.isVisible()) return;

        // Couvre toute la zone contenu pour permettre clic hors modale + fond assombri.
        const contentBounds = this.mainWindow.getContentBounds();
        win.setBounds({
            x: contentBounds.x,
            y: contentBounds.y,
            width: contentBounds.width,
            height: contentBounds.height
        });
    }

    async _ensureWindow() {
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            return this.overlayWindow;
        }

        this.overlayWindow = new BrowserWindow({
            width: 460,
            height: 760,
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
            webPreferences: {
                preload: this._preloadPath(),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        this.readyPromise = this.overlayWindow.loadFile(this._htmlPath());
        await this.readyPromise;
        await this.overlayWindow.webContents.executeJavaScript(`
            new Promise((resolve) => {
                if (window.__hubModalWindowReady) {
                    resolve(true);
                    return;
                }
                window.addEventListener("hub-modal-window-ready", () => resolve(true), { once: true });
            })
        `, true);

        return this.overlayWindow;
    }

    async open(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        const panel = payload.panel || null;
        const win = await this._ensureWindow();
        const alreadyOpen = this.isOpen() && this.currentPanel === panel;

        // Reclic sur le même panneau : ne pas recentrer / redimensionner.
        if (alreadyOpen) {
            if (payload.tab != null) {
                win.webContents.send("hub-modal:open", payload);
            }
            win.focus();
            return true;
        }

        this.currentPanel = panel;
        win.webContents.send("hub-modal:open", payload);
        win.show();
        this._syncBounds();
        win.focus();
        return true;
    }

    hide() {
        const win = this.overlayWindow;
        if (win && !win.isDestroyed()) {
            win.hide();
        }
        this.currentPanel = null;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("hub-modal:closed");
            this.mainWindow.focus();
        }
    }

    isOpen() {
        return Boolean(
            this.overlayWindow
            && !this.overlayWindow.isDestroyed()
            && this.overlayWindow.isVisible()
        );
    }

    getCurrentPanel() {
        return this.currentPanel;
    }

    destroy() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
            this.mainWindow.removeListener("focus", this._onMainFocus);
        }
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
        }
        this.overlayWindow = null;
        this.readyPromise = null;
    }
}

module.exports = { HubModalOverlayManager };
