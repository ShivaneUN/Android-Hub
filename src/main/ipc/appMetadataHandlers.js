function registerAppMetadataHandlers(deps) {
    const {
        ipcMain,
        getAppMetadataManager,
        getAppsWorkerBridge,
        resolveAppListDeviceContext
    } = deps;

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

    ipcMain.handle("app-metadata:prefetch", async (_event, payload = {}) => {
        const manager = getAppMetadataManager();
        if (!manager) {
            return { success: false, error: "Metadonnees apps indisponibles." };
        }

        const { deviceId, apps = [], maxCount, priority } = payload;
        if (!deviceId || !Array.isArray(apps) || !apps.length) {
            return { success: false, error: "deviceId et apps requis." };
        }

        const prefetchOptions = {
            maxCount: Number.isInteger(maxCount) ? maxCount : undefined,
            priority: priority === "high" ? "high" : "normal"
        };

        try {
            const bridge = typeof getAppsWorkerBridge === "function" ? getAppsWorkerBridge() : null;
            if (bridge && !bridge.useFallback) {
                const ctx = typeof resolveAppListDeviceContext === "function"
                    ? await resolveAppListDeviceContext(deviceId)
                    : {
                        transportSerial: deviceId,
                        cacheDeviceId: deviceId,
                        adbSerial: deviceId
                    };
                await bridge.prefetchAppMetadata(ctx, apps, prefetchOptions);
                return { success: true };
            }

            manager.queuePrefetch(deviceId, apps, prefetchOptions);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
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
