const { ipcMain } = require("electron");

const DEFAULT_WIFI_PORT = 5555;

function notifyNamesUpdated(mainWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("names:updated");
    }
}

function notifyDeviceViewsUpdated(mainWindow, refreshDeviceList) {
    notifyNamesUpdated(mainWindow);
    if (typeof refreshDeviceList === "function") {
        void refreshDeviceList();
    }
}

async function resolveStableDeviceId(transportSerial) {
    const id = String(transportSerial || "").trim();
    if (!id) return null;

    if (global.deviceRegistry?.resolveStableDeviceIdFromTransport) {
        return global.deviceRegistry.resolveStableDeviceIdFromTransport(id) || id;
    }
    return id;
}

function collectDeviceAliasKeys(stableId, transportSerial) {
    const keys = new Set();
    const add = (value) => {
        const key = String(value || "").trim();
        if (key) keys.add(key);
    };

    add(transportSerial);
    add(stableId);

    const wifiManager = global.wifiDevicesManager;
    const wifiService = global.wifiAdbService;
    const config = wifiManager?.getByDeviceId?.(stableId);

    if (config) {
        if (config.usbSerialHint) add(config.usbSerialHint);
        if (config.ip) {
            add(wifiService?.buildWifiSerial?.(config.ip, config.port || DEFAULT_WIFI_PORT));
        }
    }

    if (wifiService?.isWifiSerial?.(transportSerial)) {
        add(transportSerial);
        const configByWifi = wifiService.findConfigByWifiSerial?.(transportSerial);
        if (configByWifi?.usbSerialHint) add(configByWifi.usbSerialHint);
    }

    return [...keys];
}

async function performDeviceRename(manager, mainWindow, { serial, name, originalName }, refreshDeviceList) {
    if (!manager || !serial) {
        return { success: false, error: "Paramètres invalides." };
    }

    const validation = manager.validateName(name);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    const stableId = await resolveStableDeviceId(serial);
    const aliasKeys = collectDeviceAliasKeys(stableId, serial);

    manager.setDeviceCustomName(stableId, originalName, validation.name, aliasKeys);

    const wifiConfig = global.wifiDevicesManager?.getByDeviceId?.(stableId);
    if (wifiConfig) {
        global.wifiDevicesManager.rename(stableId, validation.name);
    }

    notifyDeviceViewsUpdated(mainWindow, refreshDeviceList);
    return { success: true, name: validation.name, deviceId: stableId };
}

function buildSessionMetaFromEntry(sessionId, entry, stableDeviceId = null) {
    return {
        sessionId,
        type: entry.type,
        deviceId: entry.deviceId,
        stableDeviceId: stableDeviceId || entry.stableDeviceId || null,
        packageName: entry.packageName,
        userId: entry.userId
    };
}

function syncOpenSessionLabels(bvm, manager, sessionMeta, label) {
    if (!bvm || !manager || !sessionMeta || !label) return;

    const targetKey = manager.buildSessionKey(sessionMeta);
    if (!targetKey || targetKey.startsWith("session:")) return;

    for (const session of bvm.getAllSessions()) {
        const meta = buildSessionMetaFromEntry(session.sessionId, {
            type: session.type,
            deviceId: session.deviceId,
            stableDeviceId: session.stableDeviceId,
            packageName: session.packageName,
            userId: session.userId
        });
        if (manager.buildSessionKey(meta) === targetKey) {
            bvm.updateSessionMetadata(session.sessionId, { label });
        }
    }
}

async function performSessionRename(manager, bvm, mainWindow, { sessionId, name }) {
    if (!manager || !bvm || !sessionId) {
        return { success: false, error: "Paramètres invalides." };
    }

    const entry = bvm.getSessionEntry(sessionId);
    if (!entry) {
        return { success: false, error: "Session introuvable." };
    }

    const validation = manager.validateName(name);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    let stableDeviceId = entry.stableDeviceId || null;
    if (!stableDeviceId && entry.deviceId) {
        stableDeviceId = await resolveStableDeviceId(entry.deviceId);
    }

    const sessionMeta = buildSessionMetaFromEntry(sessionId, entry, stableDeviceId);
    const aliasKeys = manager.collectSessionAliasKeys(sessionMeta);
    const sessionKey = manager.buildSessionKey(sessionMeta);
    const fallbackLabel = entry.originalLabel || entry.label;

    manager.consolidateSessionRecord(sessionKey, fallbackLabel, aliasKeys);
    const originalName = manager.getSessionOriginalName(sessionKey, fallbackLabel);

    console.log("[Names] renameSession", { sessionId, sessionKey, originalName, name: validation.name });

    manager.setSessionCustomName(sessionKey, originalName, validation.name, aliasKeys);
    syncOpenSessionLabels(bvm, manager, sessionMeta, validation.name);

    notifyNamesUpdated(mainWindow);
    return { success: true, name: validation.name, sessionKey };
}

async function performSessionReset(manager, bvm, mainWindow, sessionId) {
    const entry = bvm.getSessionEntry(sessionId);
    if (!entry) {
        return { success: false, error: "Session introuvable." };
    }

    let stableDeviceId = entry.stableDeviceId || null;
    if (!stableDeviceId && entry.deviceId) {
        stableDeviceId = await resolveStableDeviceId(entry.deviceId);
    }

    const sessionMeta = buildSessionMetaFromEntry(sessionId, entry, stableDeviceId);
    const aliasKeys = manager.collectSessionAliasKeys(sessionMeta);
    const sessionKey = manager.buildSessionKey(sessionMeta);
    const original = manager.resetSessionName(sessionKey, aliasKeys)
        || entry.originalLabel
        || entry.label;

    syncOpenSessionLabels(bvm, manager, sessionMeta, original);

    console.log("[Names] resetSession", { sessionId, sessionKey, original });

    notifyNamesUpdated(mainWindow);
    return { success: true, name: original };
}

function registerNamesHandlers(deps) {
    const getManager = deps.getCustomNamesManager;
    const getBrowserViewManager = deps.getBrowserViewManager;
    const getMainWindow = deps.getMainWindow;
    const getRenameDialogManager = deps.getRenameDialogManager;
    const refreshDeviceList = deps.refreshDeviceList;

    ipcMain.handle("names:renameDevice", async (_event, payload) => {
        return performDeviceRename(getManager(), getMainWindow(), payload, refreshDeviceList);
    });

    ipcMain.handle("names:resetDevice", async (_event, { serial }) => {
        const manager = getManager();
        if (!manager || !serial) {
            return { success: false, error: "Paramètres invalides." };
        }

        const stableId = await resolveStableDeviceId(serial);
        const aliasKeys = collectDeviceAliasKeys(stableId, serial);
        const original = manager.resetDeviceName(stableId, aliasKeys);

        const wifiConfig = global.wifiDevicesManager?.getByDeviceId?.(stableId);
        if (wifiConfig && original) {
            global.wifiDevicesManager.rename(stableId, original);
        }

        notifyDeviceViewsUpdated(getMainWindow(), refreshDeviceList);
        return { success: true, name: original };
    });

    ipcMain.handle("names:renameSession", async (_event, payload) => {
        return performSessionRename(getManager(), getBrowserViewManager(), getMainWindow(), payload);
    });

    ipcMain.handle("names:resetSession", async (_event, { sessionId }) => {
        const manager = getManager();
        const bvm = getBrowserViewManager();
        if (!manager || !bvm || !sessionId) {
            return { success: false, error: "Paramètres invalides." };
        }

        const entry = bvm.getSessionEntry(sessionId);
        if (!entry) {
            return { success: false, error: "Session introuvable." };
        }

        return performSessionReset(manager, bvm, getMainWindow(), sessionId);
    });

    ipcMain.handle("names:openRenameDialog", async (_event, payload = {}) => {
        const dialogManager = getRenameDialogManager?.();
        if (!dialogManager) {
            return { success: false, error: "Dialogue indisponible." };
        }
        console.log("[Names] openRenameDialog", payload);
        await dialogManager.show(payload);
        return { success: true };
    });

    ipcMain.handle("names:cancelRenameDialog", () => {
        const dialogManager = getRenameDialogManager?.();
        dialogManager?.hide();
        return { success: true };
    });

    ipcMain.handle("names:submitRenameDialog", async (_event, { name }) => {
        const dialogManager = getRenameDialogManager?.();
        const pending = dialogManager?.getPending?.();
        if (!pending) {
            console.warn("[Names] submitRenameDialog sans contexte pending");
            return { success: false, error: "Aucun renommage en cours." };
        }

        console.log("[Names] submitRenameDialog", { pending, name });

        let result;
        if (pending.kind === "device") {
            result = await performDeviceRename(getManager(), getMainWindow(), {
                serial: pending.serial,
                name,
                originalName: pending.originalName
            }, refreshDeviceList);
        } else if (pending.kind === "session") {
            result = await performSessionRename(
                getManager(),
                getBrowserViewManager(),
                getMainWindow(),
                { sessionId: pending.sessionId, name }
            );
        } else {
            result = { success: false, error: "Type de renommage inconnu." };
        }

        if (result?.success) {
            dialogManager.hide();
        }
        return result;
    });

    ipcMain.handle("names:getDeviceInfo", async (_event, { serial, fallbackName }) => {
        const manager = getManager();
        if (!manager || !serial) {
            return { success: false, error: "Paramètres invalides." };
        }

        const stableId = await resolveStableDeviceId(serial);
        const aliasKeys = collectDeviceAliasKeys(stableId, serial);
        manager.consolidateDeviceRecord(stableId, fallbackName, aliasKeys);
        manager.ensureDeviceOriginal(stableId, fallbackName);

        const lookupKeys = [...new Set([stableId, serial, ...aliasKeys].filter(Boolean))];
        const { record } = manager.findDeviceRecord(lookupKeys, stableId);

        return {
            success: true,
            name: manager.getDeviceDisplayName(stableId, fallbackName),
            originalName: manager.getDeviceOriginalName(stableId, fallbackName),
            customName: record?.customName || null,
            hasCustomName: manager.hasDeviceCustomName(stableId, aliasKeys),
            deviceId: stableId
        };
    });

    ipcMain.handle("names:resolveInstanceAppNames", async (_event, items = []) => {
        const manager = getManager();
        if (!manager || !Array.isArray(items)) {
            return { success: false, names: {} };
        }

        const names = {};
        for (const item of items) {
            if (!item?.deviceId || !item?.packageName) continue;
            const userId = item.userId === undefined || item.userId === null || item.userId === ""
                ? 0
                : Number(item.userId);
            const key = `${item.deviceId}::${item.packageName}::${Number.isFinite(userId) ? userId : 0}`;
            const resolved = manager.resolveInstanceDisplayName(item, item.appName || null);
            if (resolved) names[key] = resolved;
        }
        return { success: true, names };
    });

    ipcMain.handle("names:getSessionInfo", async (_event, { sessionId }) => {
        const manager = getManager();
        const bvm = getBrowserViewManager();
        if (!manager || !bvm || !sessionId) {
            return { success: false, error: "Paramètres invalides." };
        }

        const entry = bvm.getSessionEntry(sessionId);
        if (!entry) {
            return { success: false, error: "Session introuvable." };
        }

        let stableDeviceId = entry.stableDeviceId || null;
        if (!stableDeviceId && entry.deviceId) {
            stableDeviceId = await resolveStableDeviceId(entry.deviceId);
        }

        const sessionMeta = buildSessionMetaFromEntry(sessionId, entry, stableDeviceId);
        const aliasKeys = manager.collectSessionAliasKeys(sessionMeta);
        const sessionKey = manager.buildSessionKey(sessionMeta);
        manager.consolidateSessionRecord(sessionKey, entry.originalLabel || entry.label, aliasKeys);
        manager.ensureSessionOriginal(sessionKey, entry.originalLabel || entry.label);

        return {
            success: true,
            name: manager.getSessionDisplayName(sessionKey, entry.originalLabel || entry.label),
            originalName: manager.getSessionOriginalName(sessionKey, entry.originalLabel || entry.label),
            hasCustomName: manager.hasSessionCustomName(sessionKey, aliasKeys),
            sessionKey
        };
    });
}

module.exports = {
    registerNamesHandlers,
    resolveStableDeviceId,
    collectDeviceAliasKeys,
    performSessionReset
};
