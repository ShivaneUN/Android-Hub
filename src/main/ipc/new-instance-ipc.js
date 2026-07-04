function registerNewInstanceIpc({ ipcMain, manager, getWindow }) {
    ipcMain.handle("new-instance:create", async (_event, payload = {}) => {
        try {
            const session = manager.createNewInstanceSession(payload);
            return { success: true, session };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("new-instance:start", async (_event, { sessionId }) => {
        try {
            const session = await manager.startNewInstanceSession(sessionId);
            if (global.launchHistoryManager && session?.serial && session?.packageName) {
                let iconPath = null;
                if (global.appMetadataManager) {
                    const cached = global.appMetadataManager.getCachedEntry(
                        session.serial,
                        session.packageName,
                        session.userId
                    );
                    iconPath = cached?.iconPath || null;
                }
                global.launchHistoryManager.recordLaunch({
                    deviceId: session.serial,
                    packageName: session.packageName,
                    appName: session.tabLabel || session.packageName,
                    iconPath,
                    userId: session.userId
                });
            }
            if (global.browserViewManager && session?.streamOptions) {
                const entry = global.browserViewManager.getSessionEntry(sessionId);
                if (entry) {
                    const { fromScrcpyOptions } = require("../../shared/stream-params");
                    const isFirst = !entry._streamInitialized;
                    const params = fromScrcpyOptions(session.streamOptions, "B");
                    global.browserViewManager.setSessionStreamParams(sessionId, params, { asOriginal: isFirst });
                    global.browserViewManager.setSessionScrcpyOptions(sessionId, session.streamOptions);
                    if (global.sessionStreamRegistry) {
                        global.sessionStreamRegistry.syncFromBrowserViewEntry(sessionId, entry);
                        global.sessionStreamRegistry.setScrcpyOptions(sessionId, session.streamOptions, { asOriginal: isFirst });
                    }
                }
            }

            if (session?.serial) {
                const startAudio = global.startSessionAudioPlayback;
                if (typeof startAudio === "function") {
                    void startAudio(sessionId, {
                        serial: session.serial,
                        displayId: session.displayId
                    });
                }
            }

            return {
                success: true,
                session: {
                    sessionId: session.sessionId,
                    serial: session.serial,
                    packageName: session.packageName,
                    state: session.state,
                    displayId: session.displayId
                }
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("new-instance:stop", async (_event, { sessionId }) => {
        try {
            await manager.stopNewInstanceSession(sessionId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("new-instance:list", async () => {
        try {
            return { success: true, sessions: manager.listNewInstanceSessions() };
        } catch (err) {
            return { success: false, error: err.message, sessions: [] };
        }
    });

    ipcMain.handle("new-instance:send-input", async (_event, payload = {}) => {
        if (!payload.sessionId) {
            return { success: false, error: "sessionId manquant pour new-instance:send-input" };
        }
        try {
            await manager.routeInputToSession(payload.sessionId, payload);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    manager.on("state", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:state", data);
    });

    manager.on("scrcpy-closed", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:scrcpy-closed", data);
    });
}

module.exports = { registerNewInstanceIpc };
