const fs = require("fs");
const path = require("path");

const DEFAULT_WIFI_PORT = 5555;

class WifiDevicesManager {
    constructor(userDataPath) {
        this.filePath = path.join(userDataPath, "wifi-devices.json");
        /** @type {Array<object>} */
        this.devices = [];
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                this.devices = [];
                return;
            }
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            this.devices = Array.isArray(parsed) ? parsed.filter((entry) => entry?.deviceId) : [];
        } catch (err) {
            console.error("[WifiDevicesManager] Erreur lecture:", err.message);
            this.devices = [];
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.devices, null, 2), "utf-8");
        } catch (err) {
            console.error("[WifiDevicesManager] Erreur écriture:", err.message);
        }
    }

    list() {
        return this.devices.map((entry) => ({ ...entry }));
    }

    getByDeviceId(deviceId) {
        if (!deviceId) return null;
        const entry = this.devices.find((d) => d.deviceId === deviceId);
        return entry ? { ...entry } : null;
    }

    upsert(record) {
        if (!record?.deviceId) {
            return { success: false, error: "deviceId requis." };
        }

        const now = new Date().toISOString();
        const index = this.devices.findIndex((d) => d.deviceId === record.deviceId);
        const merged = {
            deviceId: record.deviceId,
            name: record.name || record.deviceId,
            ip: record.ip,
            port: Number.isInteger(record.port) ? record.port : DEFAULT_WIFI_PORT,
            wifiEnabled: Boolean(record.wifiEnabled),
            lastSeen: record.lastSeen || now,
            usbSerialHint: record.usbSerialHint || null
        };

        if (index === -1) {
            this.devices.push(merged);
        } else {
            this.devices[index] = { ...this.devices[index], ...merged };
        }

        this.save();
        return { success: true, entry: { ...merged } };
    }

    setWifiEnabled(deviceId, wifiEnabled) {
        const entry = this.getByDeviceId(deviceId);
        if (!entry) {
            return { success: false, error: "Appareil WiFi introuvable." };
        }
        return this.upsert({ ...entry, wifiEnabled: Boolean(wifiEnabled) });
    }

    rename(deviceId, name) {
        const entry = this.getByDeviceId(deviceId);
        if (!entry) {
            return { success: false, error: "Appareil WiFi introuvable." };
        }
        return this.upsert({ ...entry, name: String(name || entry.name).trim() || entry.name });
    }

    remove(deviceId) {
        const before = this.devices.length;
        this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
        if (this.devices.length === before) {
            return { success: false, error: "Appareil WiFi introuvable." };
        }
        this.save();
        return { success: true };
    }

    touchLastSeen(deviceId) {
        const entry = this.getByDeviceId(deviceId);
        if (!entry) return;
        this.upsert({ ...entry, lastSeen: new Date().toISOString() });
    }
}

module.exports = { WifiDevicesManager, DEFAULT_WIFI_PORT };
