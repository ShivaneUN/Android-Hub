const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

class DockHoverOverlayManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.overlayWindow = null;
        this.visible = false;
        this.bounds = { x: 0, y: 0, width: 280, height: 46 };

        this._onMainMove = () => this._syncBounds();
        this._onMainResize = () => this.hide();
        this._onMainMinimize = () => this.hide();
        this._onMainClose = () => this.destroy();

        mainWindow.on("move", this._onMainMove);
        mainWindow.on("resize", this._onMainResize);
        mainWindow.on("minimize", this._onMainMinimize);
        mainWindow.on("closed", this._onMainClose);

        ipcMain.removeHandler("dock-hover:show");
        ipcMain.handle("dock-hover:show", async (_event, payload = {}) => this.show(payload));

        ipcMain.removeHandler("dock-hover:invoke-click");
        ipcMain.handle("dock-hover:invoke-click", async (_event, buttonId) => {
            if (!buttonId || !this.mainWindow || this.mainWindow.isDestroyed()) return { ok: false };
            const id = String(buttonId).replace(/[^a-zA-Z0-9_-]/g, "");
            if (!id) return { ok: false };
            try {
                const result = await this.mainWindow.webContents.executeJavaScript(`
                    (async () => {
                        const el = document.getElementById(${JSON.stringify(id)});
                        if (!el) return { ok: false };
                        const item = el.classList.contains("sidebar-item")
                            ? el
                            : el.closest(".sidebar-item");
                        if (!item || item.classList.contains("disabled")) return { ok: false };
                        item.click();
                        const start = Date.now();
                        while (item.classList.contains("pending") && Date.now() - start < 3500) {
                            await new Promise((r) => setTimeout(r, 40));
                        }
                        await new Promise((r) => setTimeout(r, 20));
                        const dock = document.getElementById("quick-actions-dock");
                        if (!dock) return { ok: true, html: "" };
                        const clone = dock.cloneNode(true);
                        clone.classList.remove("dock-covered");
                        clone.querySelectorAll("[title]").forEach((node) => node.removeAttribute("title"));
                        return { ok: true, html: clone.outerHTML };
                    })()
                `);

                // Un clic (ex. Accueil) peut avoir fermé l'overlay : ne pas re-couvrir le dock.
                if (!this.visible) {
                    this._uncoverMainDock();
                    return result || { ok: false };
                }

                if (result?.html && this.overlayWindow && !this.overlayWindow.isDestroyed()) {
                    await this.mainWindow.webContents.executeJavaScript(
                        `document.getElementById("quick-actions-dock")?.classList.add("dock-covered")`
                    );
                    this.overlayWindow.webContents.send("dock-hover:render", { html: result.html });
                }
                return result || { ok: false };
            } catch (_err) {
                this._uncoverMainDock();
                return { ok: false };
            }
        });

        ipcMain.removeHandler("dock-hover:hide");
        ipcMain.handle("dock-hover:hide", async () => {
            this.hide();
            return true;
        });

        ipcMain.removeHandler("dock-hover:show-tip");
        ipcMain.handle("dock-hover:show-tip", async (_event, payload = {}) => this.showTip(payload));

        ipcMain.removeHandler("dock-hover:hide-tip");
        ipcMain.handle("dock-hover:hide-tip", async () => {
            this.hideTip();
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
                preload: path.join(__dirname, "../../preload/dockOverlayPreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        // Enfant de la fenêtre principale uniquement (reste dans l'app, pas above other Windows apps).
        await this.overlayWindow.loadFile(
            path.join(__dirname, "../../renderer/dock-hover/dock-overlay.html")
        );
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
            width: Math.max(120, Math.round(this.bounds.width)),
            height: Math.max(32, Math.round(this.bounds.height))
        });
    }

    _uncoverMainDock() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        void this.mainWindow.webContents.executeJavaScript(
            `document.getElementById("quick-actions-dock")?.classList.remove("dock-covered")`
        );
    }

    async show({ x, y, width, height, html }) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        this.bounds = {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height)
        };
        this.visible = true;

        const win = await this._ensureWindow();
        this._syncBounds();
        win.webContents.send("dock-hover:render", { html: String(html || "") });

        if (!win.isVisible()) win.showInactive();
        return true;
    }

    hide() {
        const wasVisible = this.visible;
        this.visible = false;
        this.hideTip();
        this._uncoverMainDock();
        const win = this.overlayWindow;
        if (wasVisible && win && !win.isDestroyed()) win.hide();
    }

    async showTip(payload = {}) {
        const bubble = global.hubBubbleOverlayManager;
        if (!bubble || !this.visible || !this.overlayWindow || this.overlayWindow.isDestroyed()) {
            return false;
        }
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

        const overlayBounds = this.overlayWindow.getBounds();
        const contentBounds = this.mainWindow.getContentBounds();
        const localX = Number(payload.x) || 0;
        const localY = Number(payload.y) || 0;
        return bubble.showTip({
            text: payload.text,
            placement: payload.placement || "above",
            width: Number(payload.width) || 0,
            height: Number(payload.height) || 0,
            x: overlayBounds.x - contentBounds.x + localX,
            y: overlayBounds.y - contentBounds.y + localY
        });
    }

    hideTip() {
        const bubble = global.hubBubbleOverlayManager;
        if (bubble && bubble.mode === "tip") {
            bubble.hide();
        }
    }

    destroy() {
        this.visible = false;
        this.hideTip();
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        ipcMain.removeHandler("dock-hover:show");
        ipcMain.removeHandler("dock-hover:invoke-click");
        ipcMain.removeHandler("dock-hover:hide");
        ipcMain.removeHandler("dock-hover:show-tip");
        ipcMain.removeHandler("dock-hover:hide-tip");
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
        }
        this.overlayWindow = null;
    }
}

module.exports = { DockHoverOverlayManager };
