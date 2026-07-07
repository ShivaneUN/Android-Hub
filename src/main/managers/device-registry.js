const { DEFAULT_WIFI_PORT } = require("./wifi-devices-manager");

class DeviceRegistry {
    constructor({
        deviceManager,
        wifiDevicesManager,
        wifiAdbService,
        getConnectedDevicesFallback,
        getConnectedDevicesSimpleFallback
    }) {
        this.deviceManager = deviceManager;
        this.wifiDevicesManager = wifiDevicesManager;
        this.wifiAdbService = wifiAdbService;
        this.getConnectedDevicesFallback = getConnectedDevicesFallback;
        this.getConnectedDevicesSimpleFallback = getConnectedDevicesSimpleFallback;
    }

    async getRawAdbDevices() {
        let connected = [];
        try {
            connected = await this.deviceManager.getConnectedDevices();
        } catch (err) {
            console.warn("[DeviceRegistry] DeviceManager error:", err.message);
        }

        if (!Array.isArray(connected) || connected.length === 0) {
            try {
                connected = await this.getConnectedDevicesFallback();
            } catch (err) {
                console.warn("[DeviceRegistry] fallback adb error:", err.message);
                connected = [];
            }
        }

        if (!Array.isArray(connected) || connected.length === 0) {
            try {
                connected = await this.getConnectedDevicesSimpleFallback();
            } catch (err) {
                console.warn("[DeviceRegistry] simple adb fallback error:", err.message);
                connected = [];
            }
        }

        return Array.isArray(connected) ? connected : [];
    }

    async attachStableIds(rawDevices) {
        const enriched = await Promise.all(
            rawDevices.map(async (device) => {
                if (!device?.serial || device.connected === false) {
                    return { ...device, deviceId: device?.serial || null };
                }
                const deviceId = await this.wifiAdbService.getStableDeviceId(device.serial);
                const configFallback = deviceId
                    ? null
                    : this.wifiAdbService.findConfigByWifiSerial(device.serial);
                return {
                    ...device,
                    deviceId: deviceId || configFallback?.deviceId || device.serial,
                    isWifiTransport: this.wifiAdbService.isWifiSerial(device.serial)
                };
            })
        );
        return enriched;
    }

    mergeByDeviceId(devicesWithIds) {
        /** @type {Map<string, object>} */
        const merged = new Map();

        for (const device of devicesWithIds) {
            if (!device?.connected) continue;

            let deviceId = device.deviceId || device.serial;
            if (!deviceId) continue;

            if (this.wifiAdbService.isWifiSerial(device.serial)) {
                const configMatch = this.wifiAdbService.findConfigByWifiSerial(device.serial);
                if (configMatch?.deviceId) {
                    deviceId = configMatch.deviceId;
                }
            }

            const existing = merged.get(deviceId) || {
                deviceId,
                usbSerial: null,
                wifiSerial: null,
                usbDevice: null,
                wifiDevice: null
            };

            if (device.isWifiTransport) {
                existing.wifiSerial = device.serial;
                existing.wifiDevice = device;
            } else {
                existing.usbSerial = device.serial;
                existing.usbDevice = device;
            }

            merged.set(deviceId, existing);
        }

        return merged;
    }

    findWifiConfigForGroup(group, configById, wifiConfigs) {
        const direct = configById.get(group.deviceId);
        if (direct) return direct;

        if (group.wifiSerial) {
            const bySerial = this.wifiAdbService.findConfigByWifiSerial(group.wifiSerial);
            if (bySerial) return bySerial;
        }

        return wifiConfigs.find((entry) => entry.deviceId === group.deviceId) || null;
    }

    reconcileGroupDeviceId(group, wifiConfig) {
        if (!wifiConfig?.deviceId || wifiConfig.deviceId === group.deviceId) {
            return group;
        }
        return { ...group, deviceId: wifiConfig.deviceId };
    }

    resolveEffectiveTransport(group, wifiConfig) {
        const wifiEnabled = Boolean(wifiConfig?.wifiEnabled);
        const usbOnline = Boolean(group.usbDevice?.connected && group.usbDevice?.status === "green");
        const wifiOnline = Boolean(group.wifiDevice?.connected && group.wifiDevice?.status === "green");

        if (wifiEnabled && wifiOnline) {
            return {
                serial: group.wifiSerial,
                transport: "wifi",
                transportLabel: "WiFi connecté",
                usbAvailable: usbOnline,
                wifiAvailable: true
            };
        }

        if (usbOnline) {
            return {
                serial: group.usbSerial,
                transport: "usb",
                transportLabel: "USB",
                usbAvailable: true,
                wifiAvailable: wifiOnline
            };
        }

        if (wifiOnline) {
            return {
                serial: group.wifiSerial,
                transport: "wifi",
                transportLabel: "WiFi connecté",
                usbAvailable: false,
                wifiAvailable: true
            };
        }

        const fallbackSerial = group.usbSerial || group.wifiSerial;
        return {
            serial: fallbackSerial,
            transport: group.usbSerial ? "usb" : "wifi",
            transportLabel: group.usbSerial ? "USB" : "WiFi",
            usbAvailable: false,
            wifiAvailable: false
        };
    }

    buildUnifiedEntry(group, wifiConfig) {
        const resolved = this.resolveEffectiveTransport(group, wifiConfig);
        const effectiveDevice = resolved.transport === "wifi"
            ? group.wifiDevice
            : group.usbDevice;
        const baseDevice = effectiveDevice || group.usbDevice || group.wifiDevice || {};
        const name = wifiConfig?.name || baseDevice.name || group.deviceId;
        const isOnline = Boolean(
            effectiveDevice?.connected !== false && effectiveDevice?.status === "green"
        );
        const wifiStoredEnabled = Boolean(wifiConfig?.wifiEnabled);
        const wifiActive = wifiStoredEnabled
            && resolved.transport === "wifi"
            && isOnline;

        return {
            deviceId: wifiConfig?.deviceId || group.deviceId,
            serial: resolved.serial,
            usbSerial: group.usbSerial,
            wifiSerial: group.wifiSerial,
            transport: resolved.transport,
            transportLabel: resolved.transportLabel,
            wifiEnabled: wifiStoredEnabled,
            wifiActive,
            wifiConfigured: Boolean(wifiConfig),
            wifiIp: wifiConfig?.ip || null,
            wifiPort: wifiConfig?.port || DEFAULT_WIFI_PORT,
            status: isOnline ? "green" : (baseDevice.status || "red"),
            name,
            connected: isOnline,
            usbAvailable: resolved.usbAvailable,
            wifiAvailable: resolved.wifiAvailable
        };
    }

    async listUnifiedDevices() {
        const raw = await this.getRawAdbDevices();
        await this.importDiscoveredWifiDevices(raw);
        const withIds = await this.attachStableIds(raw.filter((d) => d?.connected !== false));
        const groups = this.mergeByDeviceId(withIds);
        const wifiConfigs = this.wifiDevicesManager.list();
        const configById = new Map(wifiConfigs.map((entry) => [entry.deviceId, entry]));

        const unified = [];

        for (const group of groups.values()) {
            const wifiConfig = this.findWifiConfigForGroup(group, configById, wifiConfigs);
            const reconciledGroup = this.reconcileGroupDeviceId(group, wifiConfig);
            unified.push(this.buildUnifiedEntry(reconciledGroup, wifiConfig));
            if (wifiConfig?.deviceId) {
                configById.delete(wifiConfig.deviceId);
            } else {
                configById.delete(group.deviceId);
            }
        }

        for (const wifiConfig of configById.values()) {
            if (!wifiConfig.wifiEnabled) continue;

            const wifiSerial = this.wifiAdbService.buildWifiSerial(
                wifiConfig.ip,
                wifiConfig.port || DEFAULT_WIFI_PORT
            );
            const rawWifi = raw.find((d) => d.serial === wifiSerial && d.connected !== false);
            const wifiOnline = Boolean(rawWifi && rawWifi.status === "green");

            unified.push({
                deviceId: wifiConfig.deviceId,
                serial: rawWifi?.serial || wifiSerial,
                usbSerial: null,
                wifiSerial: rawWifi?.serial || wifiSerial,
                transport: wifiOnline ? "wifi" : "wifi",
                transportLabel: wifiOnline ? "WiFi connecté" : "WiFi (hors ligne)",
                wifiEnabled: true,
                wifiActive: wifiOnline,
                wifiConfigured: true,
                wifiIp: wifiConfig.ip,
                wifiPort: wifiConfig.port || DEFAULT_WIFI_PORT,
                status: rawWifi?.status || "red",
                name: wifiConfig.name || wifiConfig.deviceId,
                connected: Boolean(rawWifi),
                usbAvailable: false,
                wifiAvailable: Boolean(rawWifi)
            });
        }

        return unified;
    }

    /**
     * Importe dans wifi-devices.json les appareils WiFi déjà connectés via adb connect
     * hors flow Hub (absents du JSON local).
     */
    async importDiscoveredWifiDevices(rawDevices) {
        if (!Array.isArray(rawDevices) || rawDevices.length === 0) return 0;

        const now = new Date().toISOString();
        let imported = 0;
        let defaultNameIndex = this.wifiDevicesManager.list().length;

        for (const device of rawDevices) {
            if (!device?.serial || device.connected === false || device.status !== "green") {
                continue;
            }
            if (!this.wifiAdbService.isWifiSerial(device.serial)) {
                continue;
            }
            if (this.wifiAdbService.findConfigByWifiSerial(device.serial)) {
                continue;
            }

            const parsed = this.wifiAdbService.parseWifiSerial(device.serial);
            if (!parsed?.ip) continue;

            let deviceId = await this.wifiAdbService.resolveStableDeviceId(device.serial);
            if (!deviceId) {
                deviceId = device.serial;
            }

            const existingById = this.wifiDevicesManager.getByDeviceId(deviceId);
            if (existingById) {
                this.wifiDevicesManager.upsert({
                    ...existingById,
                    ip: parsed.ip,
                    port: parsed.port,
                    wifiEnabled: true,
                    lastSeen: now
                });
                continue;
            }

            defaultNameIndex += 1;
            const modelName = device.name && device.name !== device.serial ? device.name : null;
            const defaultName = modelName || deviceId || `Appareil WiFi ${defaultNameIndex}`;

            this.wifiDevicesManager.upsert({
                deviceId,
                name: defaultName,
                ip: parsed.ip,
                port: parsed.port,
                wifiEnabled: true,
                lastSeen: now,
                usbSerialHint: null
            });

            console.log(
                `[DeviceRegistry] WiFi manuel importé: ${device.serial} → deviceId=${deviceId}, name="${defaultName}"`
            );
            imported += 1;
        }

        return imported;
    }

    /**
     * Scan ADB : importe les WiFi manuels, retourne les appareils nouvellement détectés.
     */
    async discoverNewDevices(history = {}) {
        const knownIds = new Set();

        for (const [key, entry] of Object.entries(history || {})) {
            if (key) knownIds.add(key);
            if (entry?.deviceId) knownIds.add(entry.deviceId);
        }

        for (const config of this.wifiDevicesManager.list()) {
            if (config?.deviceId) knownIds.add(config.deviceId);
        }

        let raw = await this.getRawAdbDevices();
        const wifiImported = await this.importDiscoveredWifiDevices(raw);
        raw = await this.getRawAdbDevices();
        const unified = await this.listUnifiedDevices();
        const connectedOnline = unified.filter(
            (device) => device?.connected !== false && device?.status === "green"
        );

        const newDevices = [];
        for (const device of connectedOnline) {
            const deviceId = device?.deviceId;
            if (!deviceId || knownIds.has(deviceId)) continue;
            newDevices.push({
                deviceId,
                name: device.name || deviceId,
                serial: device.serial,
                transport: device.transport,
                transportLabel: device.transportLabel
            });
            knownIds.add(deviceId);
        }

        return {
            connectedCount: connectedOnline.length,
            wifiImported,
            newCount: newDevices.length,
            newDevices
        };
    }

    /**
     * Résout le serial USB ADB actuellement online pour un deviceId logique.
     * Re-scan adb devices — ne fait pas confiance au cache renderer / usbSerialHint seul.
     */
    async resolveLiveUsbSerial({ deviceId = null, preferredSerial = null } = {}) {
        const raw = await this.getRawAdbDevices();
        const usbOnline = raw.filter((device) =>
            device?.serial
            && device.connected !== false
            && device.status === "green"
            && !this.wifiAdbService.isWifiSerial(device.serial)
        );

        if (usbOnline.length === 0) return null;

        const matchesDeviceId = async (usbSerial) => {
            if (!deviceId) return true;
            if (usbSerial === deviceId) return true;
            const stableId = await this.wifiAdbService.resolveStableDeviceId(usbSerial);
            return stableId === deviceId;
        };

        for (const device of usbOnline) {
            if (await matchesDeviceId(device.serial)) {
                return device.serial;
            }
        }

        if (!deviceId && usbOnline.length === 1) {
            return usbOnline[0].serial;
        }

        if (preferredSerial) {
            const preferred = usbOnline.find((device) => device.serial === preferredSerial);
            if (preferred && await matchesDeviceId(preferred.serial)) {
                return preferred.serial;
            }
        }

        const config = deviceId ? this.wifiDevicesManager.getByDeviceId(deviceId) : null;
        if (config?.usbSerialHint) {
            const hinted = usbOnline.find((device) => device.serial === config.usbSerialHint);
            if (hinted && await matchesDeviceId(hinted.serial)) {
                return hinted.serial;
            }
        }

        return null;
    }

    resolveAdbSerial({ deviceId, serial } = {}) {
        if (serial) return serial;
        const config = deviceId ? this.wifiDevicesManager.getByDeviceId(deviceId) : null;
        if (config?.wifiEnabled && config.ip) {
            return this.wifiAdbService.buildWifiSerial(config.ip, config.port || DEFAULT_WIFI_PORT);
        }
        return null;
    }

    /**
     * Résout un identifiant transport (USB / ip:port) ou stable → serial ADB effectif actuel.
     */
    async resolveEffectiveAdbSerial({ deviceId, serial } = {}) {
        const unified = await this.listUnifiedDevices();
        const pickLiveSerial = (device) => {
            if (!device || device.connected === false) return null;
            return device.serial || device.wifiSerial || device.usbSerial || null;
        };

        const findByTransport = (transportId) => {
            if (!transportId) return null;
            const id = String(transportId).trim();
            return unified.find((device) =>
                device.deviceId === id
                || device.serial === id
                || device.usbSerial === id
                || device.wifiSerial === id
            ) || null;
        };

        if (deviceId) {
            const byStable = unified.find((device) => device.deviceId === deviceId);
            const live = pickLiveSerial(byStable);
            if (live) return live;
        }

        if (serial) {
            const byTransport = findByTransport(serial);
            const live = pickLiveSerial(byTransport);
            if (live) return live;

            if (this.wifiAdbService.isWifiSerial(serial)) {
                return serial;
            }
        }

        if (deviceId) {
            const fallback = this.resolveAdbSerial({ deviceId });
            if (fallback) return fallback;
        }

        return serial || null;
    }

    /**
     * Transport ADB ou clé historique → deviceId stable (ro.serialno / config WiFi).
     */
    async resolveStableDeviceIdFromTransport(transportId) {
        const id = String(transportId || "").trim();
        if (!id) return null;

        const unified = await this.listUnifiedDevices();
        const match = unified.find((device) =>
            device.deviceId === id
            || device.serial === id
            || device.usbSerial === id
            || device.wifiSerial === id
        );
        if (match?.deviceId) return match.deviceId;

        if (this.wifiAdbService.isWifiSerial(id)) {
            const config = this.wifiAdbService.findConfigByWifiSerial(id);
            if (config?.deviceId) return config.deviceId;
            const stable = await this.wifiAdbService.resolveStableDeviceId(id);
            if (stable) return stable;
        }

        const configById = this.wifiDevicesManager.getByDeviceId(id);
        if (configById?.deviceId) return configById.deviceId;

        return id;
    }

    async startupAutoConnect() {
        const configs = this.wifiDevicesManager.list().filter((entry) => entry.wifiEnabled && entry.ip);
        for (const config of configs) {
            try {
                const liveUsbSerial = await this.resolveLiveUsbSerial({
                    deviceId: config.deviceId,
                    preferredSerial: config.usbSerialHint
                });
                const wifiSerial = await this.wifiAdbService.reconnectSaved(config.deviceId, {
                    usbSerial: liveUsbSerial || undefined
                });
                console.log(`[DeviceRegistry] Auto-connect WiFi OK ${config.deviceId} → ${wifiSerial}`);
                this.wifiDevicesManager.touchLastSeen(config.deviceId);
            } catch (err) {
                console.warn(`[DeviceRegistry] Auto-connect WiFi échec ${config.deviceId}:`, err.message);
            }
        }
    }

    /**
     * Données panneau Appareils : USB (serials USB réels, 1 ligne / deviceId) + WiFi (configs).
     */
    async buildDevicesPanelData(history = {}) {
        const raw = await this.getRawAdbDevices();
        const unified = await this.listUnifiedDevices();
        const wifiConfigs = this.wifiDevicesManager.list();
        /** @type {Map<string, object>} */
        const usbByDeviceId = new Map();

        const upsertUsb = (deviceId, patch) => {
            if (!deviceId) return;
            const usbSerial = patch.usbSerial;
            if (!usbSerial || this.wifiAdbService.isWifiSerial(usbSerial)) return;

            const existing = usbByDeviceId.get(deviceId) || { deviceId };
            usbByDeviceId.set(deviceId, {
                deviceId,
                name: patch.name || existing.name || deviceId,
                serial: usbSerial,
                usbSerial,
                lastSeen: patch.lastSeen || existing.lastSeen || null,
                wifiConfigured: patch.wifiConfigured ?? existing.wifiConfigured ?? false
            });
        };

        for (const device of unified) {
            if (device.usbSerial) {
                upsertUsb(device.deviceId, {
                    name: device.name,
                    usbSerial: device.usbSerial,
                    lastSeen: new Date().toISOString(),
                    wifiConfigured: device.wifiConfigured
                });
            }
        }

        for (const [key, entry] of Object.entries(history || {})) {
            if (!entry || typeof entry !== "object") continue;

            if (this.wifiAdbService.isWifiSerial(key) || this.wifiAdbService.isWifiSerial(entry.serial)) {
                continue;
            }

            const deviceId = entry.deviceId || key;
            const usbSerial = entry.usbSerial || entry.serial || key;
            if (this.wifiAdbService.isWifiSerial(usbSerial)) continue;

            const config = this.wifiDevicesManager.getByDeviceId(deviceId);
            upsertUsb(deviceId, {
                name: entry.name,
                usbSerial,
                lastSeen: entry.lastUsbSeen || entry.lastSeen,
                wifiConfigured: Boolean(config)
            });
        }

        const usbEntries = Array.from(usbByDeviceId.values()).map((entry) => {
            const connected = raw.some(
                (d) => d.serial === entry.usbSerial && d.connected !== false && d.status === "green"
            );
            return {
                ...entry,
                connected,
                statusLabel: connected ? "Connecté" : "Hors ligne"
            };
        });

        const wifiEntries = await Promise.all(
            wifiConfigs.map(async (config) => {
                const adbTarget = this.wifiAdbService.buildWifiSerial(
                    config.ip,
                    config.port || DEFAULT_WIFI_PORT
                );
                let adbState = "offline";
                try {
                    const state = await this.wifiAdbService.getAdbState(adbTarget);
                    adbState = state === "device" ? "connected" : (state || "offline");
                } catch (_err) {
                    adbState = "offline";
                }
                return {
                    ...config,
                    adbTarget,
                    adbState,
                    statusLabel: adbState === "connected" ? "Connecté" : "Hors ligne"
                };
            })
        );

        return { usb: usbEntries, wifi: wifiEntries };
    }

    /**
     * Map serial ADB effectif (USB ou ip:port) → deviceId stable pour couleurs / noms.
     */
    async buildAdbSerialToDeviceIdMap() {
        const map = new Map();
        const unified = await this.listUnifiedDevices();

        for (const device of unified) {
            const stableId = device.deviceId;
            if (!stableId) continue;

            for (const serial of [device.serial, device.wifiSerial, device.usbSerial]) {
                if (serial) map.set(serial, stableId);
            }
        }

        for (const config of this.wifiDevicesManager.list()) {
            if (!config.deviceId) continue;
            const wifiSerial = this.wifiAdbService.buildWifiSerial(
                config.ip,
                config.port || DEFAULT_WIFI_PORT
            );
            map.set(wifiSerial, config.deviceId);
        }

        return map;
    }
}

module.exports = { DeviceRegistry };
