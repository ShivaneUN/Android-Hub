const { LaunchHistoryManager } = require("../managers/launch-history-manager");

/** @type {LaunchHistoryManager|null} */
let historyManager = null;
/** @type {Set<string>} */
let activeTypeBKeys = new Set();

function getActiveTypeBKeys() {
    return activeTypeBKeys;
}

function setActiveTypeBKeys(keys) {
    activeTypeBKeys = new Set(Array.isArray(keys) ? keys : []);
}

function ensureHistoryManager() {
    if (!historyManager) {
        throw new Error("AppsWorker non initialise (INIT requis).");
    }
    return historyManager;
}

async function handleMessage(message) {
    const { id, type, payload = {} } = message;

    try {
        let result;

        switch (type) {
            case "INIT": {
                if (historyManager) {
                    historyManager.destroy();
                }
                if (!payload.userDataPath) {
                    throw new Error("userDataPath requis pour INIT.");
                }
                historyManager = new LaunchHistoryManager(payload.userDataPath, {
                    getActiveTypeBKeys,
                    enablePruneTimer: false
                });
                result = { ready: true };
                break;
            }

            case "GET_HISTORY": {
                setActiveTypeBKeys(payload.activeKeys);
                result = { entries: ensureHistoryManager().list() };
                break;
            }

            case "ADD_HISTORY_ENTRY": {
                result = ensureHistoryManager().recordLaunch(payload);
                break;
            }

            case "REMOVE_HISTORY_ENTRY": {
                result = ensureHistoryManager().remove(payload);
                break;
            }

            case "PURGE_HISTORY_OLDER_THAN": {
                setActiveTypeBKeys(payload.activeKeys);
                result = ensureHistoryManager().purgeOlderThan(payload.cutoff, {
                    dryRun: payload.dryRun === true
                });
                break;
            }

            case "SHUTDOWN": {
                if (historyManager) {
                    historyManager.destroy();
                    historyManager = null;
                }
                result = { ok: true };
                process.send?.({ id, ok: true, result });
                setImmediate(() => process.exit(0));
                return;
            }

            default:
                throw new Error(`Type message worker inconnu: ${type}`);
        }

        process.send?.({ id, ok: true, result });
    } catch (err) {
        process.send?.({ id, ok: false, error: err?.message || String(err) });
    }
}

process.on("message", (message) => {
    void handleMessage(message);
});

process.on("disconnect", () => {
    if (historyManager) {
        historyManager.destroy();
        historyManager = null;
    }
    process.exit(0);
});
