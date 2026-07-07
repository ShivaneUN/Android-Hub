const { ipcMain } = require("electron");

function registerStreamDeckDuoPopupHandlers(deps) {
    const getMainWindow = deps.getMainWindow;
    const getStreamDeckDuoPopupManager = deps.getStreamDeckDuoPopupManager;

    ipcMain.handle("duo-popup:open", async (_event, payload = {}) => {
        const manager = getStreamDeckDuoPopupManager?.();
        if (!manager) return { success: false, error: "manager-unavailable" };
        await manager.show(payload);
        return { success: true };
    });

    ipcMain.handle("duo-popup:update", async (_event, payload = {}) => {
        const manager = getStreamDeckDuoPopupManager?.();
        if (!manager) return { success: false, error: "manager-unavailable" };
        await manager.update(payload);
        return { success: true };
    });

    ipcMain.handle("duo-popup:hide", () => {
        getStreamDeckDuoPopupManager?.()?.hide();
        return { success: true };
    });

    ipcMain.on("duo-popup:slots-changed", (_event, slots) => {
        const main = getMainWindow?.();
        if (main && !main.isDestroyed()) {
            main.webContents.send("duo-popup:slots-changed", slots);
        }
    });

    ipcMain.on("duo-popup:close-request", () => {
        getStreamDeckDuoPopupManager?.()?.hide();
        const main = getMainWindow?.();
        if (main && !main.isDestroyed()) {
            main.webContents.send("duo-popup:closed");
        }
    });
}

module.exports = { registerStreamDeckDuoPopupHandlers };
