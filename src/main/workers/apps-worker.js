const { LaunchHistoryManager } = require("../managers/launch-history-manager");
const { DeviceManager } = require("../managers/device-manager");
const { AppMetadataManager } = require("../managers/app-metadata-manager");

/** @type {LaunchHistoryManager|null} */
let historyManager = null;
/** @type {DeviceManager|null} */
let deviceManager = null;
/** @type {AppMetadataManager|null} */
let appMetadataManager = null;
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

function ensureDeviceManager() {
    if (!deviceManager) {
        throw new Error("DeviceManager worker non initialise (INIT requis).");
    }
    return deviceManager;
}

function ensureAppMetadataManager() {
    if (!appMetadataManager) {
        throw new Error("AppMetadataManager worker non initialise (INIT requis).");
    }
    return appMetadataManager;
}

function normalizeAppListPayload(payload = {}) {
    const transportSerial = String(payload.transportSerial || payload.serial || "").trim();
    const cacheDeviceId = String(payload.cacheDeviceId || transportSerial).trim();
    const adbSerial = String(payload.adbSerial || transportSerial).trim();
    if (!transportSerial) {
        throw new Error("transportSerial requis pour GET_APP_LIST.");
    }
    if (!adbSerial) {
        throw new Error("adbSerial requis pour GET_APP_LIST.");
    }
    return { transportSerial, cacheDeviceId, adbSerial };
}

function normalizeEnrichAppsPayload(payload = {}) {
    const transportSerial = String(payload.transportSerial || payload.serial || "").trim();
    const cacheDeviceId = String(payload.cacheDeviceId || transportSerial).trim();
    if (!transportSerial) {
        throw new Error("transportSerial requis pour ENRICH_APPS.");
    }
    return { transportSerial, cacheDeviceId };
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
                if (!payload.adbPath) {
                    throw new Error("adbPath requis pour INIT.");
                }
                historyManager = new LaunchHistoryManager(payload.userDataPath, {
                    getActiveTypeBKeys,
                    enablePruneTimer: false
                });
                deviceManager = new DeviceManager(payload.adbPath);
                appMetadataManager = new AppMetadataManager(payload.userDataPath, payload.adbPath);
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

            case "GET_APP_LIST": {
                const { transportSerial, cacheDeviceId, adbSerial } = normalizeAppListPayload(payload);
                const listed = await ensureDeviceManager().getInstalledAppsWithDetails(adbSerial);
                const enriched = await ensureAppMetadataManager().enrichApps(transportSerial, listed, {
                    cacheDeviceId,
                    transportSerial
                });
                result = { apps: enriched };
                break;
            }

            case "ENRICH_APPS": {
                const { transportSerial, cacheDeviceId } = normalizeEnrichAppsPayload(payload);
                const apps = Array.isArray(payload.apps) ? payload.apps : [];
                result = {
                    apps: await ensureAppMetadataManager().enrichApps(transportSerial, apps, {
                        cacheDeviceId,
                        transportSerial
                    })
                };
                break;
            }

            case "PREFETCH_APP_METADATA": {
                const { transportSerial, cacheDeviceId, adbSerial } = normalizeAppListPayload(payload);
                const apps = Array.isArray(payload.apps) ? payload.apps : [];
                const maxCount = Number.isInteger(payload.maxCount) && payload.maxCount > 0
                    ? payload.maxCount
                    : undefined;
                const priority = payload.priority === "high" ? "high" : "normal";
                await ensureAppMetadataManager().queuePrefetch(transportSerial, apps, {
                    maxCount,
                    priority,
                    cacheDeviceId,
                    transportSerial,
                    adbSerial,
                    onUpdate: (data) => {
                        process.send?.({ type: "METADATA_UPDATED", payload: data });
                    }
                });
                result = { ok: true, queued: apps.length };
                break;
            }

            case "SHUTDOWN": {
                if (historyManager) {
                    historyManager.destroy();
                    historyManager = null;
                }
                if (appMetadataManager && typeof appMetadataManager.flushIndex === "function") {
                    appMetadataManager.flushIndex();
                }
                deviceManager = null;
                appMetadataManager = null;
                result = { ok: true };
                process.send?.({ id, ok: true, result });
                setImmediate(() => process.exit(0));
                return;
            }

            // TEMP DEBUG - à retirer avant release
            case "DEBUG_CRASH": {
                setImmediate(() => process.exit(1));
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
    if (appMetadataManager && typeof appMetadataManager.flushIndex === "function") {
        appMetadataManager.flushIndex();
    }
    deviceManager = null;
    appMetadataManager = null;
    process.exit(0);
});
