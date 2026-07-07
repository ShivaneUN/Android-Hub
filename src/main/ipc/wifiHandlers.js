const { collectDeviceAliasKeys } = require("./namesHandlers");

function enrichPanelEntries(entries, { namesManager, colorsManager } = {}) {
    if (!Array.isArray(entries)) return [];

    let list = entries.map((entry) => ({
        ...entry,
        serial: entry.usbSerial || entry.serial || entry.deviceId,
        deviceId: entry.deviceId || entry.serial
    }));

    if (namesManager?.applyDeviceNames) {
        list = namesManager.applyDeviceNames(list);
    }

    if (colorsManager?.getColorForDevice) {
        list = list.map((entry) => ({
            ...entry,
            deviceColor: colorsManager.getColorForDevice(entry.deviceId) || null
        }));
    }

    return list;
}

function registerWifiHandlers(deps) {
    const {
        ipcMain,
        getDeviceRegistry,
        getWifiAdbService,
        getWifiDevicesManager,
        getCustomNamesManager,
        getMainWindow,
        loadHistory,
        removeDeviceFromHistory,
        refreshDeviceList,
        syncDevicesForUi
    } = deps;

    ipcMain.handle("wifi:list-config", async () => {
        const manager = getWifiDevicesManager();
        const registry = getDeviceRegistry();
        const raw = await registry.getRawAdbDevices();
        const configs = manager.list();

        const usbHistory = configs.map((config) => {
            const usbSeen = raw.some((d) => {
                return !getWifiAdbService().isWifiSerial(d.serial) && d.serial;
            });
            return {
                ...config,
                type: "wifi",
                connected: raw.some((d) => d.serial === getWifiAdbService().buildWifiSerial(config.ip, config.port)),
                adbTarget: getWifiAdbService().buildWifiSerial(config.ip, config.port)
            };
        });

        return { success: true, wifi: usbHistory, usb: [] };
    });

    ipcMain.handle("devices:discover", async () => {
        const registry = getDeviceRegistry();
        if (!registry?.discoverNewDevices) {
            return { success: false, error: "Recherche d'appareils indisponible" };
        }

        try {
            const history = loadHistory?.() || {};
            const discovery = await registry.discoverNewDevices(history);
            if (typeof syncDevicesForUi === "function") {
                await syncDevicesForUi();
            }
            await refreshDeviceList?.();
            return { success: true, ...discovery };
        } catch (err) {
            console.error("[devices:discover]", err.message);
            return { success: false, error: err.message || "Recherche impossible" };
        }
    });

    ipcMain.handle("wifi:panel-data", async () => {
        const registry = getDeviceRegistry();
        if (!registry?.buildDevicesPanelData) {
            return { success: true, wifi: [], usb: [] };
        }

        const history = loadHistory?.() || {};
        const panel = await registry.buildDevicesPanelData(history);
        const namesManager = getCustomNamesManager();
        const colorsManager = global.deviceColorsManager;

        return {
            success: true,
            usb: enrichPanelEntries(panel.usb, { namesManager, colorsManager }),
            wifi: enrichPanelEntries(panel.wifi, { namesManager, colorsManager })
        };
    });

    async function resolveToggleUsbSerial(registry, { deviceId, usbSerial, config } = {}) {
        if (!registry?.resolveLiveUsbSerial) return usbSerial || null;
        const targetDeviceId = deviceId || config?.deviceId || null;
        return registry.resolveLiveUsbSerial({
            deviceId: targetDeviceId,
            preferredSerial: usbSerial || config?.usbSerialHint || null
        });
    }

    async function removeDevicePanelEntry(deviceId) {
        removeDeviceFromHistory?.(deviceId);

        const wifiManager = getWifiDevicesManager();
        const wifiService = getWifiAdbService();
        const entry = wifiManager.getByDeviceId(deviceId);

        if (entry) {
            wifiManager.setWifiEnabled(deviceId, false);
            if (entry.ip) {
                await wifiService.disconnect(
                    wifiService.buildWifiSerial(entry.ip, entry.port || 5555)
                );
            }
            wifiManager.remove(deviceId);
        }

        await refreshDeviceList();
        return { success: true };
    }

    ipcMain.handle("wifi:toggle", async (_event, { deviceId, enabled, usbSerial, name } = {}) => {
        const registry = getDeviceRegistry();
        const wifiService = getWifiAdbService();
        const wifiManager = getWifiDevicesManager();
        const namesManager = getCustomNamesManager();

        if (!deviceId && !usbSerial) {
            return { success: false, error: "Appareil introuvable.", step: "init" };
        }

        const progress = [];

        try {
            if (enabled) {
                let config = deviceId ? wifiManager.getByDeviceId(deviceId) : null;
                let resolvedDeviceId = deviceId || null;

                if (!config) {
                    const liveUsbSerial = await resolveToggleUsbSerial(registry, { deviceId, usbSerial });
                    if (!liveUsbSerial) {
                        return {
                            success: false,
                            error: "Branchez l'appareil en USB pour la première configuration WiFi.",
                            step: "usb"
                        };
                    }

                    const setup = await wifiService.setupFirstConnection(liveUsbSerial, (step, message) => {
                        progress.push({ step, message });
                    });

                    resolvedDeviceId = setup.deviceId;
                    const displayName = name || setup.deviceId;

                    config = wifiManager.upsert({
                        deviceId: setup.deviceId,
                        name: displayName,
                        ip: setup.ip,
                        port: setup.port,
                        wifiEnabled: true,
                        usbSerialHint: liveUsbSerial,
                        lastSeen: new Date().toISOString()
                    }).entry;

                    if (namesManager) {
                        namesManager.ensureDeviceOriginal(resolvedDeviceId, displayName);
                        if (name) {
                            const aliasKeys = collectDeviceAliasKeys(resolvedDeviceId, liveUsbSerial);
                            namesManager.setDeviceCustomName(
                                resolvedDeviceId,
                                displayName,
                                name,
                                aliasKeys
                            );
                        }
                    }

                    await refreshDeviceList();

                    return {
                        success: true,
                        firstSetup: true,
                        deviceId: resolvedDeviceId,
                        ip: setup.ip,
                        progress,
                        message: `Connecté en WiFi — ${setup.ip}`
                    };
                }

                const targetDeviceId = resolvedDeviceId || config.deviceId;
                const liveUsbSerial = await resolveToggleUsbSerial(registry, {
                    deviceId: targetDeviceId,
                    usbSerial,
                    config
                });

                wifiManager.setWifiEnabled(targetDeviceId, true);
                await wifiService.reconnectSaved(targetDeviceId, {
                    usbSerial: liveUsbSerial || undefined
                });
                wifiManager.touchLastSeen(targetDeviceId);
                await refreshDeviceList();

                const updated = wifiManager.getByDeviceId(targetDeviceId);

                return {
                    success: true,
                    deviceId: targetDeviceId,
                    progress: [{ step: "connect", message: "Connexion..." }],
                    message: `Connecté en WiFi — ${updated?.ip || config.ip}`
                };
            }

            if (!deviceId) {
                return { success: false, error: "deviceId requis.", step: "off" };
            }

            const config = wifiManager.getByDeviceId(deviceId);
            if (config) {
                wifiManager.setWifiEnabled(deviceId, false);
                if (config.ip) {
                    await wifiService.disconnect(
                        wifiService.buildWifiSerial(config.ip, config.port || 5555)
                    );
                }
            }

            await refreshDeviceList();
            return {
                success: true,
                deviceId,
                wifiEnabled: false,
                message: "WiFi déconnecté"
            };
        } catch (err) {
            const message = String(err.message || err);
            let step = "unknown";
            if (/tcpip|activer/i.test(message)) step = "tcpip";
            else if (/IP introuvable/i.test(message)) step = "ip";
            else if (/connect|réseau|Timeout/i.test(message)) step = "connect";

            if (deviceId) {
                wifiManager.setWifiEnabled(deviceId, false);
            }

            return { success: false, error: message, step, progress };
        }
    });

    ipcMain.handle("wifi:rename", (_event, { deviceId, name } = {}) => {
        const wifiManager = getWifiDevicesManager();
        const namesManager = getCustomNamesManager();
        const result = wifiManager.rename(deviceId, name);
        if (result.success && namesManager) {
            const entry = wifiManager.getByDeviceId(deviceId);
            const aliasKeys = collectDeviceAliasKeys(deviceId, entry?.usbSerialHint);
            namesManager.setDeviceCustomName(
                deviceId,
                entry?.name || deviceId,
                name,
                aliasKeys
            );
        }
        void refreshDeviceList();
        return result;
    });

    ipcMain.handle("devices:panel-remove", async (_event, { deviceId } = {}) => {
        if (!deviceId) {
            return { success: false, error: "deviceId requis." };
        }

        try {
            return await removeDevicePanelEntry(deviceId);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("wifi:remove", async (_event, { deviceId } = {}) => {
        if (!deviceId) {
            return { success: false, error: "deviceId requis." };
        }

        try {
            return await removeDevicePanelEntry(deviceId);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("wifi:reconnect", async (_event, { deviceId } = {}) => {
        const registry = getDeviceRegistry();
        const wifiService = getWifiAdbService();
        const wifiManager = getWifiDevicesManager();
        const config = wifiManager.getByDeviceId(deviceId);

        if (!config) {
            return { success: false, error: "Configuration WiFi introuvable." };
        }

        try {
            const liveUsbSerial = await resolveToggleUsbSerial(registry, {
                deviceId,
                config
            });

            wifiManager.setWifiEnabled(deviceId, true);
            const wifiSerial = await wifiService.reconnectSaved(deviceId, {
                usbSerial: liveUsbSerial || undefined
            });
            wifiManager.touchLastSeen(deviceId);
            await refreshDeviceList();

            return {
                success: true,
                wifiSerial,
                message: `Connecté en WiFi — ${wifiManager.getByDeviceId(deviceId)?.ip || config.ip}`
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("device:resolve-serial", (_event, { deviceId, serial } = {}) => {
        const registry = getDeviceRegistry();
        const resolved = registry.resolveAdbSerial({ deviceId, serial });
        return { success: Boolean(resolved), serial: resolved };
    });
}

module.exports = { registerWifiHandlers };
