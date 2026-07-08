function registerAppMetadataHandlers(deps) {
    const { ipcMain, getAppMetadataManager, getWindow } = deps;

    ipcMain.handle("app-metadata:resolve", async (_event, payload = {}) => {
        const manager = getAppMetadataManager();
        if (!manager) {
            return { success: false, error: "Metadonnees apps indisponibles." };
        }

        const { deviceId, packageName, userId = null, appNameHint = null } = payload;
        if (!deviceId || !packageName) {
            return { success: false, error: "deviceId et packageName requis." };
        }

        try {
            const metadata = await manager.resolveOne(deviceId, packageName, userId, { appNameHint });
            return { success: true, metadata };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("app-metadata:prefetch", (_event, payload = {}) => {
        const manager = getAppMetadataManager();
        if (!manager) {
            return { success: false, error: "Metadonnees apps indisponibles." };
        }

        const { deviceId, apps = [], maxCount } = payload;
        if (!deviceId || !Array.isArray(apps) || !apps.length) {
            return { success: false, error: "deviceId et apps requis." };
        }

        manager.queuePrefetch(deviceId, apps, {
            maxCount: Number.isInteger(maxCount) ? maxCount : undefined
        });
        return { success: true };
    });
}

function attachAppMetadataPrefetch(deviceManager, appMetadataManager) {
    if (!deviceManager || !appMetadataManager) return;

    const originalGetInstalledAppsWithDetails = deviceManager.getInstalledAppsWithDetails.bind(deviceManager);

    deviceManager.getInstalledAppsWithDetails = async (serial) => {
        const apps = await originalGetInstalledAppsWithDetails(serial);
        return await appMetadataManager.enrichApps(serial, apps);
    };
}

module.exports = { registerAppMetadataHandlers, attachAppMetadataPrefetch };
