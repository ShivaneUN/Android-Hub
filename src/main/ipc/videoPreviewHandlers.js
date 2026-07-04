const { ipcMain } = require("electron");

function registerVideoPreviewHandlers(getManager) {
    ipcMain.handle("video-preview:show", async (_event, payload = {}) => {
        const manager = getManager();
        if (!manager) return { success: false };
        await manager.show(payload);
        return { success: true };
    });

    ipcMain.handle("video-preview:hide", () => {
        const manager = getManager();
        if (!manager) return { success: false };
        manager.hide();
        return { success: true };
    });

    ipcMain.handle("video-preview:setPosition", async (_event, payload = {}) => {
        const manager = getManager();
        if (!manager) return { success: false };
        await manager.setPosition(payload);
        return { success: true };
    });

    ipcMain.handle("video-preview:setState", async (_event, payload = {}) => {
        const manager = getManager();
        if (!manager) return { success: false };
        await manager.setState(payload);
        return { success: true };
    });

    ipcMain.handle("video-preview:setFrame", async (_event, payload = {}) => {
        const manager = getManager();
        if (!manager) return { success: false };
        await manager.setFrame(payload);
        return { success: true };
    });
}

module.exports = { registerVideoPreviewHandlers };
