const { ipcMain } = require("electron");

function registerLaunchHistoryHandlers(deps) {
    const getBridge = deps.getAppsWorkerBridge;
    const getFacade = deps.getLaunchHistoryManager;

    async function resolveHistoryEntries() {
        const bridge = getBridge?.();
        if (bridge) {
            return bridge.listHistory();
        }
        const manager = getFacade?.();
        return manager?.list?.() || [];
    }

    ipcMain.handle("launch-history:list", async () => {
        try {
            const entries = await resolveHistoryEntries();
            const metadataManager = deps.getAppMetadataManager?.();
            const enrichedEntries = metadataManager
                ? await metadataManager.enrichHistoryEntries(entries)
                : entries;
            console.log("[LaunchHistory] list IPC", enrichedEntries.length, "entrée(s)");
            return { success: true, entries: enrichedEntries };
        } catch (err) {
            console.warn("[LaunchHistory] list IPC:", err.message);
            return { success: false, error: err.message, entries: [] };
        }
    });

    ipcMain.handle("launch-history:record", async (_event, payload = {}) => {
        try {
            const bridge = getBridge?.();
            if (bridge) {
                return await bridge.recordLaunch(payload);
            }
            const manager = getFacade?.();
            if (!manager) {
                return { success: false, error: "Historique indisponible." };
            }
            return manager.recordLaunch(payload);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("launch-history:remove", async (_event, payload = {}) => {
        try {
            const bridge = getBridge?.();
            if (bridge) {
                return await bridge.remove(payload);
            }
            const manager = getFacade?.();
            if (!manager) {
                return { success: false, error: "Historique indisponible." };
            }
            return manager.remove(payload);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
}

module.exports = { registerLaunchHistoryHandlers };
