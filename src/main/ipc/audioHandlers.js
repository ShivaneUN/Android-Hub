const { ipcMain } = require("electron");

function broadcastGlobalAudioState(manager, getMainWindow) {
    const payload = manager.getState();
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
        win.webContents.send("audio:global-state-changed", payload);
    }

    const browserViewManager = global.browserViewManager;
    if (browserViewManager?.views) {
        for (const sessionId of browserViewManager.views.keys()) {
            browserViewManager.sendToSessionView(sessionId, "audio:global-state-changed", payload);
        }
    }
}

function registerAudioHandlers(getMainWindow, manager) {
    ipcMain.handle("audio:getGlobalState", () => manager.getState());

    ipcMain.handle("audio:setGlobalMuted", async (_event, { muted } = {}) => {
        const result = await manager.setGlobalMuted(Boolean(muted));
        broadcastGlobalAudioState(manager, getMainWindow);
        return result;
    });

    ipcMain.handle("audio:toggleGlobalMuted", async () => {
        const result = await manager.toggleGlobalMuted();
        broadcastGlobalAudioState(manager, getMainWindow);
        return result;
    });

    ipcMain.handle("audio:setDeviceMuted", async (_event, { deviceKey, muted } = {}) => {
        const result = await manager.setDeviceMuted(deviceKey, Boolean(muted));
        broadcastGlobalAudioState(manager, getMainWindow);
        return result;
    });

    ipcMain.handle("audio:toggleDeviceMuted", async (_event, { deviceKey } = {}) => {
        const result = await manager.toggleDeviceMuted(deviceKey);
        broadcastGlobalAudioState(manager, getMainWindow);
        return result;
    });
}

module.exports = { registerAudioHandlers };
