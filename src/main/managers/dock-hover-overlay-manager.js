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
                        dock.classList.add("dock-covered");
                        const clone = dock.cloneNode(true);
                        clone.classList.remove("dock-covered");
                        return { ok: true, html: clone.outerHTML };
                    })()
                `);
                if (result?.html && this.overlayWindow && !this.overlayWindow.isDestroyed() && this.visible) {
                    this.overlayWindow.webContents.send("dock-hover:render", { html: result.html });
                }
                return result || { ok: false };
            } catch (_err) {
                return { ok: false };
            }
        });

        ipcMain.removeHandler("dock-hover:hide");
        ipcMain.handle("dock-hover:hide", async () => {
            this.hide();
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
            webPreferences: {
                preload: path.join(__dirname, "../../preload/dockOverlayPreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        this.overlayWindow.setAlwaysOnTop(true, "screen-saver");
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
        win.setAlwaysOnTop(true, "screen-saver");
        return true;
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this._uncoverMainDock();
        const win = this.overlayWindow;
        if (win && !win.isDestroyed()) win.hide();
    }

    destroy() {
        this.visible = false;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeListener("move", this._onMainMove);
            this.mainWindow.removeListener("resize", this._onMainResize);
            this.mainWindow.removeListener("minimize", this._onMainMinimize);
            this.mainWindow.removeListener("closed", this._onMainClose);
        }
        ipcMain.removeHandler("dock-hover:show");
        ipcMain.removeHandler("dock-hover:invoke-click");
        ipcMain.removeHandler("dock-hover:hide");
        if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.destroy();
        }
        this.overlayWindow = null;
    }
}

module.exports = { DockHoverOverlayManager };
