const fs = require("fs");
const path = require("path");
const {
    DEVICE_COLORS,
    getDeviceColorById,
    isValidDeviceColorId
} = require("../../shared/device-colors");

class DeviceColorsManager {
    constructor(userDataPath) {
        this.filePath = path.join(userDataPath, "device-colors.json");
        this.data = { devices: {}, roundRobinIndex: 0 };
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) return;

            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            this.data = {
                devices: parsed.devices && typeof parsed.devices === "object" ? parsed.devices : {},
                roundRobinIndex: Number.isInteger(parsed.roundRobinIndex) ? parsed.roundRobinIndex : 0
            };
        } catch (err) {
            console.error("[DeviceColorsManager] Erreur lecture:", err.message);
            this.data = { devices: {}, roundRobinIndex: 0 };
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
        } catch (err) {
            console.error("[DeviceColorsManager] Erreur écriture:", err.message);
        }
    }

    buildColorInfo(record) {
        if (!record || !isValidDeviceColorId(record.colorId)) return null;
        const color = getDeviceColorById(record.colorId);
        return {
            colorId: color.id,
            hex: color.hex,
            name: color.name,
            mode: record.mode === "manual" ? "manual" : "auto"
        };
    }

    getDeviceRecord(deviceId) {
        if (!deviceId) return null;
        return this.data.devices[deviceId] || null;
    }

    getColorForDevice(deviceId) {
        const record = this.getDeviceRecord(deviceId);
        return record ? this.buildColorInfo(record) : null;
    }

    getUsedColorIds(connectedDeviceIds, excludeDeviceId = null) {
        const used = new Set();
        for (const id of connectedDeviceIds) {
            if (!id || id === excludeDeviceId) continue;
            const record = this.getDeviceRecord(id);
            if (record && isValidDeviceColorId(record.colorId)) {
                used.add(record.colorId);
            }
        }
        return used;
    }

    pickFreeColorId(connectedDeviceIds, excludeDeviceId = null) {
        const used = this.getUsedColorIds(connectedDeviceIds, excludeDeviceId);

        for (const color of DEVICE_COLORS) {
            if (!used.has(color.id)) return color.id;
        }

        const colorId = DEVICE_COLORS[this.data.roundRobinIndex % DEVICE_COLORS.length].id;
        this.data.roundRobinIndex = (this.data.roundRobinIndex + 1) % DEVICE_COLORS.length;
        return colorId;
    }

    ensureColorOnConnect(deviceId, connectedDeviceIds = []) {
        if (!deviceId) return null;

        let record = this.getDeviceRecord(deviceId);
        if (!record || !isValidDeviceColorId(record.colorId)) {
            const colorId = this.pickFreeColorId(connectedDeviceIds, deviceId);
            record = { colorId, mode: "auto", updatedAt: Date.now() };
            this.data.devices[deviceId] = record;
            this.save();
        }

        return this.buildColorInfo(record);
    }

    setManualColor(deviceId, colorId) {
        if (!deviceId || !isValidDeviceColorId(colorId)) {
            return { success: false, error: "Paramètres invalides." };
        }

        this.data.devices[deviceId] = {
            colorId,
            mode: "manual",
            updatedAt: Date.now()
        };
        this.save();
        return { success: true, deviceColor: this.buildColorInfo(this.data.devices[deviceId]) };
    }

    setAutoMode(deviceId, connectedDeviceIds = []) {
        if (!deviceId) {
            return { success: false, error: "Paramètres invalides." };
        }

        const colorId = this.pickFreeColorId(connectedDeviceIds, deviceId);
        this.data.devices[deviceId] = {
            colorId,
            mode: "auto",
            updatedAt: Date.now()
        };
        this.save();
        return { success: true, deviceColor: this.buildColorInfo(this.data.devices[deviceId]) };
    }

    applyDeviceColors(devices) {
        if (!Array.isArray(devices)) return devices;

        const connectedIds = devices
            .filter((device) => device?.serial && device.connected !== false)
            .map((device) => device.serial);

        return devices.map((device) => {
            if (!device?.serial || device.connected === false) return device;

            const deviceColor = this.ensureColorOnConnect(device.serial, connectedIds);
            return deviceColor ? { ...device, deviceColor } : device;
        });
    }

    applySessionColors(sessions) {
        if (!Array.isArray(sessions)) return sessions;

        const connectedIds = sessions
            .map((session) => session?.deviceId)
            .filter(Boolean);

        return sessions.map((session) => {
            if (!session?.deviceId) return session;
            const deviceColor = this.getColorForDevice(session.deviceId)
                || this.ensureColorOnConnect(session.deviceId, connectedIds);
            return deviceColor ? { ...session, deviceColor } : session;
        });
    }
}

module.exports = { DeviceColorsManager };
