const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const MAX_WIDTH = 380;
const TIP_MIN_WIDTH = 40;
const TOAST_MIN_WIDTH = 72;
const PAD = 12;

class HubBubbleOverlayManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.overlayWindow = null;
        this.visible = false;
        this.mode = "hidden";
        this.bounds = { x: 0, y: 0, width: 260, height: 48 };
        this.hideTimer = null;
        this.readyPromise = null;

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this.hide();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);

        ipcMain.removeHandler("hub-bubble:show-toast");
        ipcMain.handle("hub-bubble:show-toast", async (_event, payload = {}) => this.showToast(payload));

        ipcMain.removeHandler("hub-bubble:show-tip");
        ipcMain.handle("hub-bubble:show-tip", async (_event, payload = {}) => this.showTip(payload));

        ipcMain.removeHandler("hub-bubble:hide");
        ipcMain.handle("hub-bubble:hide", async () => {
            this.hide();
            return true;
        });

        ipcMain.removeHandler("hub-bubble:report-size");
        ipcMain.handle("hub-bubble:report-size", async (_event, payload = {}) => {
            const minWidth = this._minWidth();
            const width = Math.max(minWidth, Math.min(MAX_WIDTH, Math.round(Number(payload.width) || minWidth)));
            const height = Math.max(32, Math.round(Number(payload.height) || 36));
            this.bounds.width = width;
            this.bounds.height = height;
            if (this.mode === "toast") {
                this._placeToast();
            } else if (this.mode === "tip") {
                this._placeTip(this._tipAnchor);
            }
            this._syncBounds();
            return true;
        });
    }

    _minWidth() {
        return this.mode === "toast" ? TOAST_MIN_WIDTH : TIP_MIN_WIDTH;
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
            focusable: false,
            skipTaskbar: true,
            show: false,
            hasShadow: false,
            thickFrame: false,
            backgroundColor: "#00000000",
            parent: this.mainWindow,
            modal: false,
            webPreferences: {
                preload: path.join(__dirname, "../../preload/hubBubblePreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        // Fenêtre enfant de l'app uniquement (pas alwaysOnTop → pas au-dessus des autres apps Windows).
        this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });

        this.readyPromise = this.overlayWindow.loadFile(
            path.join(__dirname, "../../renderer/hub-bubble/hub-bubble-overlay.html")
        );
        await this.readyPromise;
        return this.overlayWindow;
    }

    _clearHideTimer() {
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }

    _send(payload) {
        const win = this.overlayWindow;
        if (!win || win.isDestroyed()) return;
        win.webContents.send("hub-bubble:render", payload);
    }

    _syncBounds() {
        if (!this.visible || !this.mainWindow || this.mainWindow.isDestroyed()) return;
        const win = this.overlayWindow;
        if (!win || win.isDestroyed()) return;
        const screen = this._clientToScreen(this.bounds.x, this.bounds.y);
        win.setBounds({
            x: screen.x,
            y: screen.y,
            width: Math.max(this._minWidth(), Math.round(this.bounds.width)),
            height: Math.max(32, Math.round(this.bounds.height))
        });
    }

    _placeToast() {
        const { width: cw, height: ch } = this._contentSize();
        this.bounds.x = Math.max(PAD, cw - this.bounds.width - PAD);
        this.bounds.y = Math.max(PAD, ch - this.bounds.height - PAD);
    }

    _placeTip(anchor = {}) {
        const { width: cw, height: ch } = this._contentSize();
        const aw = Math.max(0, Number(anchor.width) || 0);
        const ah = Math.max(0, Number(anchor.height) || 0);
        const ax = Number(anchor.x) || 0;
        const ay = Number(anchor.y) || 0;
        const placement = String(anchor.placement || "above");
        const gap = 8;

        let x = ax + aw / 2 - this.bounds.width / 2;
        let y = ay - this.bounds.height - gap;

        if (placement === "below") {
            y = ay + ah + gap;
        } else if (placement === "left") {
            x = ax - this.bounds.width - gap;
            y = ay + ah / 2 - this.bounds.height / 2;
        } else if (placement === "right") {
            x = ax + aw + gap;
            y = ay + ah / 2 - this.bounds.height / 2;
        }

        this.bounds.x = Math.max(PAD, Math.min(x, cw - this.bounds.width - PAD));
        this.bounds.y = Math.max(PAD, Math.min(y, ch - this.bounds.height - PAD));
    }

    async showToast({ message, type = "info", durationMs = 4200 } = {}) {
        const text = String(message || "").trim();
        if (!text || !this.mainWindow || this.mainWindow.isDestroyed()) return false;

        this._clearHideTimer();
        this.mode = "toast";
        this.visible = true;
        this.bounds.width = Math.min(MAX_WIDTH, Math.max(TOAST_MIN_WIDTH, Math.ceil(text.length * 7.2) + 24));
        this.bounds.height = 40;
        this._placeToast();

        const win = await this._ensureWindow();
        this._syncBounds();
        this._send({
            mode: "toast",
            text,
            type: String(type || "info"),
            visible: true
        });

        if (!win.isVisible()) win.showInactive();

        const ms = Math.max(1200, Number(durationMs) || 4200);
        this.hideTimer = setTimeout(() => this.hide(), ms);
        return true;
    }

    async showTip({ text, detail, color, x, y, width, height, placement = "above" } = {}) {
        const tipText = String(text || "").trim();
        if (!tipText || !this.mainWindow || this.mainWindow.isDestroyed()) return false;

        const tipDetail = String(detail || "").trim();
        const tipColor = /^#[0-9A-Fa-f]{6}$/.test(String(color || "").trim())
            ? String(color).trim()
            : "";

        this._clearHideTimer();
        this.mode = "tip";
        this.visible = true;
        this._tipAnchor = {
            x: Number(x) || 0,
            y: Number(y) || 0,
            width: Number(width) || 0,
            height: Number(height) || 0,
            placement: String(placement || "above")
        };
        const estimateSource = tipDetail ? `${tipText} ${tipDetail}` : tipText;
        this.bounds.width = Math.min(MAX_WIDTH, Math.max(TIP_MIN_WIDTH, Math.ceil(estimateSource.length * 7.2) + 24));
        this.bounds.height = tipDetail || tipColor ? 44 : 36;
        this._placeTip(this._tipAnchor);

        const win = await this._ensureWindow();
        this._syncBounds();
        this._send({
            mode: "tip",
            text: tipText,
            detail: tipDetail,
            color: tipColor,
            type: "info",
            visible: true
        });

        if (!win.isVisible()) win.showInactive();
        return true;
    }

    hide() {
        this._clearHideTimer();
        this.visible = false;
        this.mode = "hidden";
        this._send({ visible: false });
        const win = this.overlayWindow;
        if (win && !win.isDestroyed()) win.hide();
    }

    destroy() {
        this.hide();
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        ipcMain.removeHandler("hub-bubble:show-toast");
        ipcMain.removeHandler("hub-bubble:show-tip");
        ipcMain.removeHandler("hub-bubble:hide");
        ipcMain.removeHandler("hub-bubble:report-size");
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
        }
        this.overlayWindow = null;
        this.readyPromise = null;
    }
}

module.exports = { HubBubbleOverlayManager };
