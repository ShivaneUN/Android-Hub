const { ipcMain } = require("electron");

function registerLaunchHistoryHandlers(deps) {
    const getManager = deps.getLaunchHistoryManager;

    ipcMain.handle("launch-history:list", async () => {
        const manager = getManager();
        if (!manager) {
            return { success: false, error: "Historique indisponible.", entries: [] };
        }
        const entries = manager.list();
        const metadataManager = deps.getAppMetadataManager?.();
        const enrichedEntries = metadataManager
            ? await metadataManager.enrichHistoryEntries(entries)
            : entries;
        console.log("[LaunchHistory] list IPC", enrichedEntries.length, "entrée(s)");
        return { success: true, entries: enrichedEntries };
    });

    ipcMain.handle("launch-history:record", (_event, payload = {}) => {
        const manager = getManager();
        if (!manager) {
            return { success: false, error: "Historique indisponible." };
        }
        return manager.recordLaunch(payload);
    });

    ipcMain.handle("launch-history:remove", (_event, payload = {}) => {
        const manager = getManager();
        if (!manager) {
            return { success: false, error: "Historique indisponible." };
        }
        return manager.remove(payload);
    });
}

module.exports = { registerLaunchHistoryHandlers };
