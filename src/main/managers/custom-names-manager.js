const fs = require("fs");
const path = require("path");

const MAX_NAME_LENGTH = 50;
const VALID_NAME_PATTERN = /^[\p{L}\p{M}\p{N}\s'.,\-_()+]+$/u;

class CustomNamesManager {
    constructor(userDataPath) {
        this.filePath = path.join(userDataPath, "custom-names.json");
        this.data = { devices: {}, sessions: {} };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
                this.data = {
                    devices: parsed.devices && typeof parsed.devices === "object" ? parsed.devices : {},
                    sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {}
                };
            }
        } catch (err) {
            console.error("[CustomNamesManager] Erreur lecture:", err.message);
            this.data = { devices: {}, sessions: {} };
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
        } catch (err) {
            console.error("[CustomNamesManager] Erreur écriture:", err.message);
        }
    }

    validateName(name) {
        const trimmed = String(name || "").trim();
        if (!trimmed) {
            return { valid: false, error: "Le nom ne peut pas être vide." };
        }
        if (trimmed.length > MAX_NAME_LENGTH) {
            return { valid: false, error: `Maximum ${MAX_NAME_LENGTH} caractères.` };
        }
        if (!VALID_NAME_PATTERN.test(trimmed)) {
            return {
                valid: false,
                error: "Seuls les lettres, chiffres, espaces et caractères accentués sont autorisés."
            };
        }
        return { valid: true, name: trimmed };
    }

    ensureDeviceOriginal(serial, originalName) {
        if (!serial) return;
        if (!this.data.devices[serial]) {
            this.data.devices[serial] = {
                originalName: originalName || serial,
                customName: null
            };
            this.save();
            return;
        }
        if (!this.data.devices[serial].originalName && originalName) {
            this.data.devices[serial].originalName = originalName;
            this.save();
        }
    }

    getDeviceDisplayName(serial, fallbackName) {
        const record = this.data.devices[serial];
        if (record?.customName) return record.customName;
        return record?.originalName || fallbackName || serial;
    }

    getDeviceOriginalName(serial, fallbackName) {
        const record = this.data.devices[serial];
        return record?.originalName || fallbackName || serial;
    }

    hasDeviceCustomName(serial) {
        return Boolean(this.data.devices[serial]?.customName);
    }

    setDeviceCustomName(serial, originalName, customName) {
        this.ensureDeviceOriginal(serial, originalName);
        this.data.devices[serial].customName = customName;
        this.save();
    }

    resetDeviceName(serial) {
        if (!this.data.devices[serial]) return null;
        const original = this.data.devices[serial].originalName;
        this.data.devices[serial].customName = null;
        this.save();
        return original;
    }

    buildSessionKey(entry) {
        if (!entry) return null;
        const type = String(entry.type || "").toUpperCase();
        const { sessionId, deviceId, packageName, userId } = entry;
        if (type === "A" && deviceId) return `mirror:${deviceId}`;
        if (type === "B" && deviceId && packageName) {
            return `instance:${deviceId}:${packageName}:${Number.isInteger(userId) ? userId : 0}`;
        }
        return `session:${sessionId}`;
    }

    buildSessionKeyFromMeta(meta) {
        return this.buildSessionKey({
            sessionId: meta.sessionId,
            type: meta.type,
            deviceId: meta.deviceId,
            packageName: meta.packageName,
            userId: meta.userId
        });
    }

    ensureSessionOriginal(sessionKey, originalName) {
        if (!sessionKey || !originalName) return;
        if (!this.data.sessions[sessionKey]) {
            this.data.sessions[sessionKey] = {
                originalName,
                customName: null
            };
            this.save();
            console.log("[CustomNamesManager] session original enregistré", sessionKey, originalName);
            return;
        }
        const record = this.data.sessions[sessionKey];
        if (!record.originalName) {
            record.originalName = originalName;
            this.save();
        } else if (record.customName && record.originalName === record.customName) {
            record.originalName = originalName;
            this.save();
        }
    }

    getSessionDisplayName(sessionKey, fallbackName) {
        const record = this.data.sessions[sessionKey];
        if (record?.customName) return record.customName;
        return record?.originalName || fallbackName;
    }

    getSessionOriginalName(sessionKey, fallbackName) {
        const record = this.data.sessions[sessionKey];
        return record?.originalName || fallbackName;
    }

    hasSessionCustomName(sessionKey) {
        return Boolean(this.data.sessions[sessionKey]?.customName);
    }

    setSessionCustomName(sessionKey, originalName, customName) {
        this.ensureSessionOriginal(sessionKey, originalName);
        this.data.sessions[sessionKey].customName = customName;
        this.save();
        console.log("[CustomNamesManager] session renommée", sessionKey, customName);
    }

    resetSessionName(sessionKey) {
        if (!this.data.sessions[sessionKey]) return null;
        const original = this.data.sessions[sessionKey].originalName;
        this.data.sessions[sessionKey].customName = null;
        this.save();
        return original;
    }

    applyDeviceNames(devices) {
        if (!Array.isArray(devices)) return devices;
        return devices.map((device) => {
            const serial = device.deviceId || device.serial;
            if (!serial) return device;
            const adbName = device.name || device.serial || serial;
            this.ensureDeviceOriginal(serial, adbName);
            const originalName = this.getDeviceOriginalName(serial, adbName);
            const displayName = this.getDeviceDisplayName(serial, adbName);
            return {
                ...device,
                name: displayName,
                originalName,
                hasCustomName: this.hasDeviceCustomName(serial)
            };
        });
    }

    resolveSessionLabel(entry) {
        const sessionKey = this.buildSessionKey(entry);
        const fallback = entry.originalLabel || entry.label || entry.sessionId;
        if (!sessionKey) return entry.label || fallback;
        this.ensureSessionOriginal(sessionKey, fallback);
        const display = this.getSessionDisplayName(sessionKey, fallback);
        console.log("[CustomNamesManager] resolveSessionLabel", sessionKey, display);
        return display;
    }

    applySessionNames(sessions) {
        if (!Array.isArray(sessions)) return sessions;
        return sessions.map((session) => {
            const sessionKey = this.buildSessionKey(session);
            const originalLabel = session.originalLabel || session.label || session.sessionId;
            if (sessionKey) {
                this.ensureSessionOriginal(sessionKey, originalLabel);
            }
            const label = sessionKey
                ? this.getSessionDisplayName(sessionKey, originalLabel)
                : (session.label || session.sessionId);
            return {
                ...session,
                label,
                originalName: sessionKey ? this.getSessionOriginalName(sessionKey, originalLabel) : originalLabel,
                hasCustomName: sessionKey ? this.hasSessionCustomName(sessionKey) : false,
                sessionKey
            };
        });
    }
}

module.exports = { CustomNamesManager, MAX_NAME_LENGTH };
