function registerWifiHandlers(deps) {
    const {
        ipcMain,
        getDeviceRegistry,
        getWifiAdbService,
        getWifiDevicesManager,
        getCustomNamesManager,
        getMainWindow,
        refreshDeviceList
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

    ipcMain.handle("wifi:panel-data", async () => {
        const registry = getDeviceRegistry();
        if (!registry?.buildDevicesPanelData) {
            return { success: true, wifi: [], usb: [] };
        }

        const history = deps.loadHistory?.() || {};
        const panel = await registry.buildDevicesPanelData(history);
        return { success: true, wifi: panel.wifi, usb: panel.usb };
    });

    async function resolveToggleUsbSerial(registry, { deviceId, usbSerial, config } = {}) {
        if (!registry?.resolveLiveUsbSerial) return usbSerial || null;
        const targetDeviceId = deviceId || config?.deviceId || null;
        return registry.resolveLiveUsbSerial({
            deviceId: targetDeviceId,
            preferredSerial: usbSerial || config?.usbSerialHint || null
        });
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
                            namesManager.setDeviceCustomName(resolvedDeviceId, displayName, name);
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
            namesManager.setDeviceCustomName(deviceId, entry?.name || deviceId, name);
        }
        void refreshDeviceList();
        return result;
    });

    ipcMain.handle("wifi:remove", async (_event, { deviceId } = {}) => {
        const wifiManager = getWifiDevicesManager();
        const wifiService = getWifiAdbService();
        const entry = wifiManager.getByDeviceId(deviceId);
        if (entry?.ip) {
            await wifiService.disconnect(wifiService.buildWifiSerial(entry.ip, entry.port || 5555));
        }
        const result = wifiManager.remove(deviceId);
        await refreshDeviceList();
        return result;
    });

    ipcMain.handle("wifi:reconnect", async (_event, { deviceId } = {}) => {
        const registry = getDeviceRegistry();
        const wifiService = getWifiAdbService();
        const wifiManager = getWifiDevicesManager();
        const config = wifiManager.getByDeviceId(deviceId);

        try {
            const liveUsbSerial = await resolveToggleUsbSerial(registry, {
                deviceId,
                config
            });
            const wifiSerial = await wifiService.reconnectSaved(deviceId, {
                usbSerial: liveUsbSerial || undefined
            });
            wifiManager.touchLastSeen(deviceId);
            await refreshDeviceList();
            return { success: true, wifiSerial };
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
