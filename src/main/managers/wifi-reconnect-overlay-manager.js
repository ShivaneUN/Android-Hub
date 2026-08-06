const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const POPUP_W = 320;
const POPUP_MIN_H = 160;
const POPUP_MAX_H = 480;

/**
 * Popup « Reconnecter Wi‑Fi » (bouton FAB) en BrowserWindow —
 * nécessaire pour passer au-dessus des BrowserView (flux).
 */
class WifiReconnectOverlayManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.overlayWindow = null;
        this.visible = false;
        this.bounds = { x: 0, y: 0, width: POPUP_W, height: POPUP_MIN_H };
        this.anchor = null;
        this.readyPromise = null;
        this._strings = {};

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this.hide();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);

        ipcMain.removeHandler("wifi-reconnect-overlay:show");
        ipcMain.handle("wifi-reconnect-overlay:show", async (_event, payload = {}) => this.show(payload));

        ipcMain.removeHandler("wifi-reconnect-overlay:update");
        ipcMain.handle("wifi-reconnect-overlay:update", async (_event, payload = {}) => this.update(payload));

        ipcMain.removeHandler("wifi-reconnect-overlay:hide");
        ipcMain.handle("wifi-reconnect-overlay:hide", async () => {
            this.hide();
            return true;
        });

        ipcMain.removeHandler("wifi-reconnect-overlay:is-open");
        ipcMain.handle("wifi-reconnect-overlay:is-open", async () => this.visible);

        ipcMain.removeHandler("wifi-reconnect-overlay:reconnect");
        ipcMain.handle("wifi-reconnect-overlay:reconnect", async (_event, payload = {}) => {
            return this._invokeHost("reconnect", payload);
        });

        ipcMain.removeHandler("wifi-reconnect-overlay:report-size");
        ipcMain.handle("wifi-reconnect-overlay:report-size", async (_event, payload = {}) => {
            const width = Math.max(240, Math.min(POPUP_W, Math.round(Number(payload.width) || POPUP_W)));
            const height = Math.max(
                POPUP_MIN_H,
                Math.min(POPUP_MAX_H, Math.round(Number(payload.height) || POPUP_MIN_H))
            );
            this.bounds.width = width;
            this.bounds.height = height;
            this._placeNearAnchor();
            this._syncBounds();
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

    _placeNearAnchor() {
        if (!this.anchor) return;
        const { width: cw, height: ch } = this._contentSize();
        const ax = Number(this.anchor.x) || 0;
        const ay = Number(this.anchor.y) || 0;
        const aw = Number(this.anchor.width) || 40;
        const ah = Number(this.anchor.height) || 40;
        const w = this.bounds.width;
        const h = this.bounds.height;
        let x = Math.round(ax + aw / 2 - w / 2);
        let y = Math.round(ay - h - 10);
        if (y < 8) y = Math.round(ay + ah + 10);
        this.bounds.x = Math.max(8, Math.min(x, cw - w - 8));
        this.bounds.y = Math.max(8, Math.min(y, ch - h - 8));
    }

    _raiseAboveStreams(win) {
        if (!win || win.isDestroyed()) return;
        try {
            if (!win.isVisible()) win.show();
            try {
                win.focus();
            } catch (_err) {
                // noop
            }
            try {
                win.setAlwaysOnTop(true, "screen-saver");
            } catch (_err) {
                try {
                    win.setAlwaysOnTop(true, "pop-up-menu");
                } catch (_err2) {
                    try {
                        win.setAlwaysOnTop(true);
                    } catch (_err3) {
                        // noop
                    }
                }
            }
            if (typeof win.setVisibleOnAllWorkspaces === "function") {
                try {
                    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
                } catch (_err) {
                    // noop
                }
            }
            if (typeof win.moveTop === "function") win.moveTop();
        } catch (_err) {
            try {
                if (!win.isVisible()) win.show();
            } catch (__err) {}
        }
    }

    async _ensureWindow() {
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            return this.overlayWindow;
        }

        this.overlayWindow = new BrowserWindow({
            width: POPUP_W,
            height: POPUP_MIN_H,
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
                preload: path.join(__dirname, "../../preload/wifiReconnectOverlayPreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        try {
            this.overlayWindow.setAlwaysOnTop(true, "screen-saver");
        } catch (_err) {
            try {
                this.overlayWindow.setAlwaysOnTop(true, "pop-up-menu");
            } catch (_err2) {
                try {
                    this.overlayWindow.setAlwaysOnTop(true);
                } catch (_err3) {
                    // noop
                }
            }
        }

        this.overlayWindow.on("blur", () => {
            setTimeout(() => {
                if (!this.visible) return;
                const win = this.overlayWindow;
                if (!win || win.isDestroyed()) return;
                if (!win.isFocused()) this.hide();
            }, 180);
        });

        this.readyPromise = this.overlayWindow.loadFile(
            path.join(__dirname, "../../renderer/wifi-reconnect/wifi-reconnect-overlay.html")
        );
        await this.readyPromise;
        return this.overlayWindow;
    }

    async _invokeHost(action, payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return { ok: false };
        try {
            const result = await this.mainWindow.webContents.executeJavaScript(`
                (async () => {
                    const api = window.__wifiReconnectHost;
                    if (!api || typeof api[${JSON.stringify(action)}] !== "function") return { ok: false };
                    return await api[${JSON.stringify(action)}](${JSON.stringify(payload || {})});
                })()
            `);
            if (result?.entries && this.visible) {
                this.update({
                    entries: result.entries,
                    error: Boolean(result.error),
                    strings: result.strings || this._strings
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
            width: Math.max(240, Math.round(this.bounds.width)),
            height: Math.max(POPUP_MIN_H, Math.round(this.bounds.height))
        });
        this._raiseAboveStreams(win);
    }

    _sendRender(payload) {
        const win = this.overlayWindow;
        if (!win || win.isDestroyed()) return;
        win.webContents.send("wifi-reconnect-overlay:render", {
            visible: true,
            title: String(payload.title || this._strings.title || "Appareils Wi‑Fi connus"),
            strings: { ...this._strings, ...(payload.strings || {}) },
            entries: payload.entries,
            loading: Boolean(payload.loading),
            error: Boolean(payload.error),
            statusText: payload.statusText || null
        });
    }

    async show(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        this._strings = { ...(payload.strings || {}) };
        this.anchor = {
            x: Number(payload.x) || Number(payload.anchor?.x) || 0,
            y: Number(payload.y) || Number(payload.anchor?.y) || 0,
            width: Number(payload.width) || Number(payload.anchor?.width) || 40,
            height: Number(payload.height) || Number(payload.anchor?.height) || 40
        };
        this.bounds.width = POPUP_W;
        this.bounds.height = Math.max(POPUP_MIN_H, 220);
        this._placeNearAnchor();
        this.visible = true;

        const win = await this._ensureWindow();
        this._syncBounds();
        this._sendRender({
            title: this._strings.title,
            strings: this._strings,
            loading: payload.loading !== false && !payload.entries,
            entries: payload.entries || null,
            error: Boolean(payload.error),
            statusText: payload.statusText || null
        });
        this._raiseAboveStreams(win);
        setTimeout(() => this._raiseAboveStreams(win), 0);
        setTimeout(() => this._raiseAboveStreams(win), 50);
        return true;
    }

    async update(payload = {}) {
        if (!this.visible) return false;
        if (payload.strings) this._strings = { ...this._strings, ...payload.strings };
        if (payload.x != null || payload.anchor) {
            this.anchor = {
                x: Number(payload.x) || Number(payload.anchor?.x) || this.anchor?.x || 0,
                y: Number(payload.y) || Number(payload.anchor?.y) || this.anchor?.y || 0,
                width: Number(payload.width) || Number(payload.anchor?.width) || this.anchor?.width || 40,
                height: Number(payload.height) || Number(payload.anchor?.height) || this.anchor?.height || 40
            };
            this._placeNearAnchor();
            this._syncBounds();
        }

        const hasContentUpdate =
            payload.loading != null
            || payload.error != null
            || payload.entries !== undefined
            || payload.statusText != null
            || payload.strings;

        if (hasContentUpdate) {
            this._sendRender({
                title: this._strings.title,
                strings: this._strings,
                loading: Boolean(payload.loading),
                entries: payload.entries,
                error: Boolean(payload.error),
                statusText: payload.statusText || null
            });
        }

        const win = this.overlayWindow;
        if (win && !win.isDestroyed()) this._raiseAboveStreams(win);
        return true;
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.anchor = null;
        const win = this.overlayWindow;
        if (win && !win.isDestroyed()) {
            win.webContents.send("wifi-reconnect-overlay:render", { visible: false });
            try {
                win.setAlwaysOnTop(false);
            } catch (_err) {
                // noop
            }
            win.hide();
        }
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            void this.mainWindow.webContents.executeJavaScript(
                `window.__wifiReconnectHost?.onOverlayHidden?.()`
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
            "wifi-reconnect-overlay:show",
            "wifi-reconnect-overlay:update",
            "wifi-reconnect-overlay:hide",
            "wifi-reconnect-overlay:is-open",
            "wifi-reconnect-overlay:reconnect",
            "wifi-reconnect-overlay:report-size"
        ].forEach((channel) => {
            try {
                ipcMain.removeHandler(channel);
            } catch (_err) {
                // noop
            }
        });
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
        }
        this.overlayWindow = null;
    }
}

module.exports = { WifiReconnectOverlayManager };
