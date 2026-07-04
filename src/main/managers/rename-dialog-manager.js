const { BrowserWindow } = require("electron");
const path = require("path");

const DIALOG_WIDTH = 360;
const DIALOG_HEIGHT = 220;

class RenameDialogManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        /** @type {BrowserWindow | null} */
        this.dialogWindow = null;
        /** @type {object | null} */
        this.pending = null;
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
        return path.join(__dirname, "../../renderer/rename/rename-dialog-overlay.html");
    }

    _preloadPath() {
        return path.join(__dirname, "../../preload/renameDialogPreload.js");
    }

    _syncBounds() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        const win = this.dialogWindow;
        if (!win || win.isDestroyed() || !win.isVisible()) return;

        const contentBounds = this.mainWindow.getContentBounds();
        const x = contentBounds.x + Math.max(0, Math.round((contentBounds.width - DIALOG_WIDTH) / 2));
        const y = contentBounds.y + Math.max(0, Math.round((contentBounds.height - DIALOG_HEIGHT) / 2));

        win.setBounds({
            x,
            y,
            width: DIALOG_WIDTH,
            height: DIALOG_HEIGHT
        });
    }

    async _ensureWindow() {
        if (this.dialogWindow && !this.dialogWindow.isDestroyed()) {
            return this.dialogWindow;
        }

        this.dialogWindow = new BrowserWindow({
            width: DIALOG_WIDTH,
            height: DIALOG_HEIGHT,
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
            backgroundColor: "#161b24",
            parent: this.mainWindow,
            webPreferences: {
                preload: this._preloadPath(),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        this.dialogWindow.setAlwaysOnTop(true, "screen-saver");
        if (typeof this.dialogWindow.setVisibleOnAllWorkspaces === "function") {
            this.dialogWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }

        this.readyPromise = this.dialogWindow.loadFile(this._overlayHtmlPath());
        await this.readyPromise;
        await this.dialogWindow.webContents.executeJavaScript(`
            new Promise((resolve) => {
                if (window.__renameDialogReady) {
                    resolve(true);
                    return;
                }
                window.addEventListener("rename-dialog-ready", () => resolve(true), { once: true });
            })
        `, true);
        return this.dialogWindow;
    }

    async show(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        this.pending = { ...payload };
        const win = await this._ensureWindow();
        this._syncBounds();

        console.log("[RenameDialog] show", payload);

        win.webContents.send("rename-dialog:open", {
            currentName: payload.currentName || ""
        });

        win.setAlwaysOnTop(true, "screen-saver");
        win.show();
        win.focus();
        return true;
    }

    hide() {
        this.pending = null;
        const win = this.dialogWindow;
        if (win && !win.isDestroyed()) {
            win.hide();
        }
    }

    getPending() {
        return this.pending;
    }

    destroy() {
        this.pending = null;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        if (this.dialogWindow && !this.dialogWindow.isDestroyed()) {
            this.dialogWindow.destroy();
        }
        this.dialogWindow = null;
        this.readyPromise = null;
    }
}

module.exports = { RenameDialogManager };
