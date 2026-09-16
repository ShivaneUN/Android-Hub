const { ipcMain } = require("electron");

function registerHubLogHandlers(getLog) {
    ipcMain.handle("hub-log:list", () => {
        const log = getLog?.();
        return { success: true, entries: log?.list?.() || [] };
    });

    ipcMain.handle("hub-log:clear", () => {
        const log = getLog?.();
        log?.clear?.();
        return { success: true };
    });

    ipcMain.on("hub-log:append", (_event, partial) => {
        getLog?.()?.append?.(partial || {});
    });
}

module.exports = { registerHubLogHandlers };
