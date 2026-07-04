const {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    getPublicState
} = require("../auto-updater");

function registerUpdateHandlers(ipcMain) {
    ipcMain.handle("update:getStatus", () => getPublicState());

    ipcMain.handle("update:check", async () => {
        return checkForUpdates({ manual: true });
    });

    ipcMain.handle("update:download", async () => {
        try {
            return { success: true, ...(await downloadUpdate()) };
        } catch (err) {
            return { success: false, error: err.message, ...getPublicState() };
        }
    });

    ipcMain.handle("update:install", () => {
        try {
            quitAndInstall();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
}

module.exports = { registerUpdateHandlers };
