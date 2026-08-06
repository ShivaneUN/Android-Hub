const { ipcMain } = require("electron");

/** @type {Promise<{ success: boolean, entries?: Array, error?: string }>|null} */
let listInFlight = null;
let listEpoch = 0;
let listInFlightEpoch = -1;

/** Après record/remove : ne plus rejoindre un list IPC stale. */
function invalidateLaunchHistoryListCoalesce() {
    listEpoch += 1;
    listInFlight = null;
}

function applyCustomInstanceAppNames(entries, namesManager) {
    if (!namesManager || !Array.isArray(entries)) return entries;
    return entries.map((entry) => {
        const resolved = namesManager.resolveInstanceDisplayName(
            entry,
            entry?.appName || entry?.packageName || ""
        );
        if (!resolved || resolved === entry.appName) return entry;
        return { ...entry, appName: resolved };
    });
}

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
        if (listInFlight && listInFlightEpoch === listEpoch) {
            return listInFlight;
        }

        const epoch = listEpoch;
        listInFlightEpoch = epoch;
        listInFlight = (async () => {
            try {
                const entries = await resolveHistoryEntries();
                const metadataManager = deps.getAppMetadataManager?.();
                const enrichedEntries = metadataManager
                    ? await metadataManager.enrichHistoryEntries(entries)
                    : entries;
                const namedEntries = applyCustomInstanceAppNames(
                    enrichedEntries,
                    deps.getCustomNamesManager?.()
                );
                console.log("[LaunchHistory] list IPC", namedEntries.length, "entrée(s)");
                return { success: true, entries: namedEntries };
            } catch (err) {
                console.warn("[LaunchHistory] list IPC:", err.message);
                return { success: false, error: err.message, entries: [] };
            } finally {
                if (listInFlightEpoch === epoch) {
                    listInFlight = null;
                }
            }
        })();

        return listInFlight;
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

module.exports = {
    registerLaunchHistoryHandlers,
    invalidateLaunchHistoryListCoalesce
};
