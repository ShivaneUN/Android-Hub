const { ipcMain } = require("electron");

function notifyNamesUpdated(mainWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("names:updated");
    }
}

function performDeviceRename(manager, mainWindow, { serial, name, originalName }) {
    if (!manager || !serial) {
        return { success: false, error: "Paramètres invalides." };
    }

    const validation = manager.validateName(name);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    manager.setDeviceCustomName(serial, originalName, validation.name);
    if (global.wifiDevicesManager?.getByDeviceId?.(serial)) {
        global.wifiDevicesManager.rename(serial, validation.name);
    }
    notifyNamesUpdated(mainWindow);
    return { success: true, name: validation.name };
}

function performSessionRename(manager, bvm, mainWindow, { sessionId, name }) {
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

    const sessionMeta = {
        sessionId,
        type: entry.type,
        deviceId: entry.deviceId,
        packageName: entry.packageName,
        userId: entry.userId
    };
    const sessionKey = manager.buildSessionKey(sessionMeta);
    const originalName = manager.getSessionOriginalName(
        sessionKey,
        entry.originalLabel || entry.label
    );

    console.log("[Names] renameSession", { sessionId, sessionKey, originalName, name: validation.name });

    manager.setSessionCustomName(sessionKey, originalName, validation.name);
    bvm.updateSessionMetadata(sessionId, { label: validation.name });

    notifyNamesUpdated(mainWindow);
    return { success: true, name: validation.name, sessionKey };
}

function registerNamesHandlers(deps) {
    const getManager = deps.getCustomNamesManager;
    const getBrowserViewManager = deps.getBrowserViewManager;
    const getMainWindow = deps.getMainWindow;
    const getRenameDialogManager = deps.getRenameDialogManager;

    ipcMain.handle("names:renameDevice", (_event, payload) => {
        return performDeviceRename(getManager(), getMainWindow(), payload);
    });

    ipcMain.handle("names:resetDevice", (_event, { serial }) => {
        const manager = getManager();
        if (!manager || !serial) {
            return { success: false, error: "Paramètres invalides." };
        }

        const original = manager.resetDeviceName(serial);
        notifyNamesUpdated(getMainWindow());
        return { success: true, name: original };
    });

    ipcMain.handle("names:renameSession", (_event, payload) => {
        return performSessionRename(getManager(), getBrowserViewManager(), getMainWindow(), payload);
    });

    ipcMain.handle("names:resetSession", (_event, { sessionId }) => {
        const manager = getManager();
        const bvm = getBrowserViewManager();
        if (!manager || !bvm || !sessionId) {
            return { success: false, error: "Paramètres invalides." };
        }

        const entry = bvm.getSessionEntry(sessionId);
        if (!entry) {
            return { success: false, error: "Session introuvable." };
        }

        const sessionKey = manager.buildSessionKey({
            sessionId,
            type: entry.type,
            deviceId: entry.deviceId,
            packageName: entry.packageName,
            userId: entry.userId
        });
        const original = manager.resetSessionName(sessionKey)
            || entry.originalLabel
            || entry.label;
        bvm.updateSessionMetadata(sessionId, { label: original });

        console.log("[Names] resetSession", { sessionId, sessionKey, original });

        notifyNamesUpdated(getMainWindow());
        return { success: true, name: original };
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

    ipcMain.handle("names:submitRenameDialog", (_event, { name }) => {
        const dialogManager = getRenameDialogManager?.();
        const pending = dialogManager?.getPending?.();
        if (!pending) {
            console.warn("[Names] submitRenameDialog sans contexte pending");
            return { success: false, error: "Aucun renommage en cours." };
        }

        console.log("[Names] submitRenameDialog", { pending, name });

        let result;
        if (pending.kind === "device") {
            result = performDeviceRename(getManager(), getMainWindow(), {
                serial: pending.serial,
                name,
                originalName: pending.originalName
            });
        } else if (pending.kind === "session") {
            result = performSessionRename(
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

    ipcMain.handle("names:getDeviceInfo", (_event, { serial, fallbackName }) => {
        const manager = getManager();
        if (!manager || !serial) {
            return { success: false, error: "Paramètres invalides." };
        }
        manager.ensureDeviceOriginal(serial, fallbackName);
        return {
            success: true,
            name: manager.getDeviceDisplayName(serial, fallbackName),
            originalName: manager.getDeviceOriginalName(serial, fallbackName),
            hasCustomName: manager.hasDeviceCustomName(serial)
        };
    });

    ipcMain.handle("names:getSessionInfo", (_event, { sessionId }) => {
        const manager = getManager();
        const bvm = getBrowserViewManager();
        if (!manager || !bvm || !sessionId) {
            return { success: false, error: "Paramètres invalides." };
        }

        const entry = bvm.getSessionEntry(sessionId);
        if (!entry) {
            return { success: false, error: "Session introuvable." };
        }

        const sessionKey = manager.buildSessionKey({
            sessionId,
            type: entry.type,
            deviceId: entry.deviceId,
            packageName: entry.packageName,
            userId: entry.userId
        });
        manager.ensureSessionOriginal(sessionKey, entry.originalLabel || entry.label);

        return {
            success: true,
            name: manager.getSessionDisplayName(sessionKey, entry.originalLabel || entry.label),
            originalName: manager.getSessionOriginalName(sessionKey, entry.originalLabel || entry.label),
            hasCustomName: manager.hasSessionCustomName(sessionKey),
            sessionKey
        };
    });
}

module.exports = { registerNamesHandlers };
