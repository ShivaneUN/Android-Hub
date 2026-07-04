const { BrowserWindow } = require("electron");
const path = require("path");

const WIDTH = 300;
const HEIGHT = 170;

class VideoPreviewTooltipManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        /** @type {BrowserWindow | null} */
        this.tooltipWindow = null;
        this.visible = false;
        this.clientX = 0;
        this.clientY = 0;
        this.state = "hidden";
        this.readyPromise = null;

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this._syncBounds();
        this._onMainMinimize = () => this.hide();
        this._onMainRestore = () => {
            if (this.visible) this._syncBounds();
        };
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("restore", this._onMainRestore);
        mainWindow.on("closed", this._onMainClose);
    }

    _overlayHtmlPath() {
        return path.join(__dirname, "../../renderer/video-preview/tooltip-overlay.html");
    }

    _preloadPath() {
        return path.join(__dirname, "../../preload/tooltipPreload.js");
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

    _clampClientPosition(x, y) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return { x, y };
        }
        const [contentWidth, contentHeight] = this.mainWindow.getContentSize();
        const margin = 8;
        return {
            x: Math.max(margin, Math.min(x, contentWidth - WIDTH - margin)),
            y: Math.max(margin, Math.min(y, contentHeight - HEIGHT - margin))
        };
    }

    async _ensureWindow() {
        if (this.tooltipWindow && !this.tooltipWindow.isDestroyed()) {
            return this.tooltipWindow;
        }

        this.tooltipWindow = new BrowserWindow({
            width: WIDTH,
            height: HEIGHT,
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            closable: false,
            focusable: false,
            skipTaskbar: true,
            show: false,
            hasShadow: true,
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

        this.tooltipWindow.setAlwaysOnTop(true, "screen-saver");
        if (typeof this.tooltipWindow.setVisibleOnAllWorkspaces === "function") {
            this.tooltipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        this.tooltipWindow.setIgnoreMouseEvents(true, { forward: true });

        this.readyPromise = this.tooltipWindow.loadFile(this._overlayHtmlPath());
        await this.readyPromise;
        return this.tooltipWindow;
    }

    _sendUpdate(payload) {
        const win = this.tooltipWindow;
        if (!win || win.isDestroyed()) return;
        win.webContents.send("video-preview:update", payload);
    }

    _syncBounds() {
        if (!this.visible || !this.mainWindow || this.mainWindow.isDestroyed()) return;
        const clamped = this._clampClientPosition(this.clientX, this.clientY);
        this.clientX = clamped.x;
        this.clientY = clamped.y;
        const screen = this._clientToScreen(clamped.x, clamped.y);
        const win = this.tooltipWindow;
        if (!win || win.isDestroyed()) return;
        win.setBounds({
            x: screen.x,
            y: screen.y,
            width: WIDTH,
            height: HEIGHT
        });
    }

    async show(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        const state = payload.state || "loading";
        this.state = state;
        this.visible = true;

        if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
            const clamped = this._clampClientPosition(payload.x, payload.y);
            this.clientX = clamped.x;
            this.clientY = clamped.y;
        }

        const win = await this._ensureWindow();
        this._syncBounds();
        this._sendUpdate({ state, dataUrl: payload.dataUrl || null, visible: true });

        if (!win.isVisible()) {
            win.showInactive();
        }
        win.setAlwaysOnTop(true, "screen-saver");
        return true;
    }

    async setPosition({ x, y }) {
        if (!this.visible) return false;
        const clamped = this._clampClientPosition(x, y);
        this.clientX = clamped.x;
        this.clientY = clamped.y;
        this._syncBounds();
        return true;
    }

    async setState({ state }) {
        if (!state) return false;
        this.state = state;
        if (!this.visible) return false;
        this._sendUpdate({ state, visible: true });
        return true;
    }

    async setFrame({ dataUrl }) {
        if (!this.visible) return false;
        this.state = "live";
        this._sendUpdate({ state: "live", dataUrl: dataUrl || null, visible: true });
        return true;
    }

    hide() {
        this.visible = false;
        this.state = "hidden";
        this._sendUpdate({ state: "hidden", visible: false });
        const win = this.tooltipWindow;
        if (win && !win.isDestroyed()) {
            win.hide();
        }
    }

    destroy() {
        this.visible = false;
        this.state = "hidden";
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("restore", this._onMainRestore);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        if (this.tooltipWindow && !this.tooltipWindow.isDestroyed()) {
            this.tooltipWindow.destroy();
        }
        this.tooltipWindow = null;
        this.readyPromise = null;
    }
}

module.exports = { VideoPreviewTooltipManager, TOOLTIP_WIDTH: WIDTH, TOOLTIP_HEIGHT: HEIGHT };
