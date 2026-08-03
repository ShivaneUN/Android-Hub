const { ipcMain } = require("electron");

function restoreActiveSessionInputFocus() {
    try {
        const bvm = global.browserViewManager;
        const sessionId = bvm?.getActiveSessionId?.();
        if (!sessionId || typeof bvm._focusSessionInput !== "function") return;
        // Remet le focus canvas session — l'audio ne doit jamais laisser le focus sur le main.
        bvm._focusSessionInput(sessionId);
    } catch (_err) {
        // ignore
    }
}

function broadcastGlobalAudioState(manager, getMainWindow) {
    const payload = manager.getState();
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
        // IPC seulement — pas d'executeJavaScript (volait le focus des BrowserViews).
        win.webContents.send("audio:global-state-changed", payload);
    }

    const browserViewManager = global.browserViewManager;
    if (browserViewManager?.views) {
        for (const sessionId of browserViewManager.views.keys()) {
            browserViewManager.sendToSessionView(sessionId, "audio:global-state-changed", payload);
        }
    }

    // Clone dock hover : mettre à jour l'icône audio si l'overlay est visible.
    try {
        global.dockHoverOverlayManager?.syncGlobalAudioState?.(payload);
    } catch (_err) {
        // ignore
    }

    restoreActiveSessionInputFocus();
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

module.exports = { registerAudioHandlers, broadcastGlobalAudioState };
