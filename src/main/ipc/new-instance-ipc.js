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
        try {
            await manager.routeInputToSession(payload.sessionId, payload);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    manager.on("video-codec-meta", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:video-codec-meta", data);
    });

    manager.on("video-packet", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:video-packet", data);
    });

    manager.on("video-error", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:video-error", data);
    });

    manager.on("state", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:state", data);
    });
}

module.exports = { registerNewInstanceIpc };
