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

    collectDeviceLookupKeys(device) {
        const keys = [];
        const add = (value) => {
            const key = String(value || "").trim();
            if (key && !keys.includes(key)) keys.push(key);
        };
        if (typeof device === "string") {
            add(device);
            return keys;
        }
        add(device?.deviceId);
        add(device?.serial);
        add(device?.usbSerial);
        add(device?.wifiSerial);
        add(device?.adbTarget);
        return keys;
    }

    findDeviceRecord(deviceOrKeys, fallbackKey = null) {
        const keys = Array.isArray(deviceOrKeys)
            ? deviceOrKeys
            : this.collectDeviceLookupKeys(deviceOrKeys);
        if (fallbackKey && !keys.includes(fallbackKey)) {
            keys.unshift(fallbackKey);
        }

        let fallbackMatch = { key: keys[0] || fallbackKey || null, record: null, keys };

        for (const key of keys) {
            const record = this.data.devices[key];
            if (!record) continue;
            if (record.customName) {
                return { key, record, keys };
            }
            if (!fallbackMatch.record) {
                fallbackMatch = { key, record, keys };
            }
        }

        return fallbackMatch;
    }

    consolidateDeviceRecord(stableId, originalName, aliasKeys = []) {
        const stableKey = String(stableId || "").trim();
        if (!stableKey) return false;

        const keys = [stableKey, ...aliasKeys].filter(Boolean);
        const uniqueKeys = [...new Set(keys)];
        const { record: existingRecord } = this.findDeviceRecord(uniqueKeys);

        this.ensureDeviceOriginal(
            stableKey,
            existingRecord?.originalName || originalName || stableKey
        );

        if (existingRecord?.customName) {
            this.data.devices[stableKey].customName = existingRecord.customName;
        }

        let changed = false;
        for (const key of uniqueKeys) {
            if (key !== stableKey && this.data.devices[key]) {
                delete this.data.devices[key];
                changed = true;
            }
        }

        if (changed) {
            this.save();
        }
        return changed;
    }

    hasDeviceCustomName(serial, aliasKeys = []) {
        const { record } = this.findDeviceRecord([serial, ...aliasKeys], serial);
        return Boolean(record?.customName);
    }

    setDeviceCustomName(stableId, originalName, customName, aliasKeys = []) {
        this.consolidateDeviceRecord(stableId, originalName, aliasKeys);
        this.data.devices[stableId].customName = customName;
        this.save();
    }

    resetDeviceName(stableId, aliasKeys = []) {
        const keys = [stableId, ...aliasKeys].filter(Boolean);
        const uniqueKeys = [...new Set(keys)];
        let original = null;

        for (const key of uniqueKeys) {
            const record = this.data.devices[key];
            if (!record) continue;
            original = original || record.originalName;
            if (key !== stableId) {
                delete this.data.devices[key];
            }
        }

        if (!this.data.devices[stableId] && !original) {
            return null;
        }

        this.ensureDeviceOriginal(stableId, original || stableId);
        original = this.data.devices[stableId].originalName || original;
        this.data.devices[stableId].customName = null;
        this.save();
        return original;
    }

    buildSessionKey(entry) {
        if (!entry) return null;
        const type = String(entry.type || "").toUpperCase();
        const { sessionId, packageName, userId } = entry;
        const stableId = this.resolveSessionStableDeviceId(entry);
        if (type === "A" && stableId) return `mirror:${stableId}`;
        if (type === "B" && stableId && packageName) {
            return `instance:${stableId}:${packageName}:${Number.isInteger(userId) ? userId : 0}`;
        }
        return `session:${sessionId}`;
    }

    resolveSessionStableDeviceId(entry) {
        if (!entry) return null;
        if (entry.stableDeviceId) return entry.stableDeviceId;

        const transportId = String(entry.deviceId || "").trim();
        if (!transportId) return null;

        const wifiManager = global.wifiDevicesManager;
        const wifiService = global.wifiAdbService;

        const configById = wifiManager?.getByDeviceId?.(transportId);
        if (configById?.deviceId) return configById.deviceId;

        if (wifiService?.isWifiSerial?.(transportId)) {
            const configByWifi = wifiService.findConfigByWifiSerial?.(transportId);
            if (configByWifi?.deviceId) return configByWifi.deviceId;
        }

        return transportId;
    }

    collectSessionAliasKeys(entry) {
        if (!entry) return [];
        const type = String(entry.type || "").toUpperCase();
        const stableId = this.resolveSessionStableDeviceId(entry);
        const transportId = String(entry.deviceId || "").trim();
        const keys = [];

        const addMirror = (id) => {
            const key = String(id || "").trim();
            if (key) keys.push(`mirror:${key}`);
        };
        const addInstance = (id) => {
            const key = String(id || "").trim();
            if (!key || !entry.packageName) return;
            const uid = Number.isInteger(entry.userId) ? entry.userId : 0;
            keys.push(`instance:${key}:${entry.packageName}:${uid}`);
        };

        if (type === "A") {
            addMirror(stableId);
            if (transportId && transportId !== stableId) addMirror(transportId);
        } else if (type === "B") {
            addInstance(stableId);
            if (transportId && transportId !== stableId) addInstance(transportId);
        }

        return [...new Set(keys)];
    }

    findSessionRecord(aliasKeys, fallbackKey = null) {
        const keys = Array.isArray(aliasKeys) ? [...aliasKeys] : [];
        if (fallbackKey && !keys.includes(fallbackKey)) {
            keys.unshift(fallbackKey);
        }

        let fallbackMatch = { key: keys[0] || fallbackKey || null, record: null, keys };

        for (const key of keys) {
            const record = this.data.sessions[key];
            if (!record) continue;
            if (record.customName) {
                return { key, record, keys };
            }
            if (!fallbackMatch.record) {
                fallbackMatch = { key, record, keys };
            }
        }

        return fallbackMatch;
    }

    consolidateSessionRecord(stableKey, originalName, aliasKeys = []) {
        const canonicalKey = String(stableKey || "").trim();
        if (!canonicalKey) return false;

        const keys = [canonicalKey, ...aliasKeys].filter(Boolean);
        const uniqueKeys = [...new Set(keys)];
        const { record: existingRecord } = this.findSessionRecord(uniqueKeys);

        this.ensureSessionOriginal(
            canonicalKey,
            existingRecord?.originalName || originalName || canonicalKey
        );

        if (existingRecord?.customName) {
            this.data.sessions[canonicalKey].customName = existingRecord.customName;
        }

        let changed = false;
        for (const key of uniqueKeys) {
            if (key !== canonicalKey && this.data.sessions[key]) {
                delete this.data.sessions[key];
                changed = true;
            }
        }

        if (changed) {
            this.save();
        }
        return changed;
    }

    buildSessionKeyFromMeta(meta) {
        return this.buildSessionKey({
            sessionId: meta.sessionId,
            type: meta.type,
            deviceId: meta.deviceId,
            stableDeviceId: meta.stableDeviceId,
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

    hasSessionCustomName(sessionKey, aliasKeys = []) {
        const keys = aliasKeys.length ? aliasKeys : [sessionKey];
        const { record } = this.findSessionRecord(keys, sessionKey);
        return Boolean(record?.customName);
    }

    setSessionCustomName(sessionKey, originalName, customName, aliasKeys = []) {
        this.consolidateSessionRecord(sessionKey, originalName, aliasKeys);
        this.data.sessions[sessionKey].customName = customName;
        this.save();
        console.log("[CustomNamesManager] session renommée", sessionKey, customName);
    }

    resetSessionName(sessionKey, aliasKeys = []) {
        const keys = [sessionKey, ...aliasKeys].filter(Boolean);
        const uniqueKeys = [...new Set(keys)];
        let original = null;

        for (const key of uniqueKeys) {
            const record = this.data.sessions[key];
            if (!record) continue;
            original = original || record.originalName;
            if (key !== sessionKey) {
                delete this.data.sessions[key];
            }
        }

        if (!this.data.sessions[sessionKey] && !original) {
            return null;
        }

        this.ensureSessionOriginal(sessionKey, original || sessionKey);
        original = this.data.sessions[sessionKey].originalName || original;
        this.data.sessions[sessionKey].customName = null;
        this.save();
        return original;
    }

    applyDeviceNames(devices) {
        if (!Array.isArray(devices)) return devices;
        return devices.map((device) => {
            const stableId = device.deviceId || device.serial;
            if (!stableId) return device;

            const lookupKeys = this.collectDeviceLookupKeys(device);
            this.consolidateDeviceRecord(stableId, device.name || device.serial, lookupKeys);

            const adbName = device.name || device.serial || stableId;
            this.ensureDeviceOriginal(stableId, adbName);
            const originalName = this.getDeviceOriginalName(stableId, adbName);
            const displayName = this.getDeviceDisplayName(stableId, adbName);
            return {
                ...device,
                name: displayName,
                originalName,
                hasCustomName: this.hasDeviceCustomName(stableId, lookupKeys)
            };
        });
    }

    resolveSessionLabel(entry) {
        const sessionKey = this.buildSessionKey(entry);
        const aliasKeys = this.collectSessionAliasKeys(entry);
        const fallback = entry.originalLabel || entry.label || entry.sessionId;
        if (!sessionKey) return entry.label || fallback;

        this.consolidateSessionRecord(sessionKey, fallback, aliasKeys);
        this.ensureSessionOriginal(sessionKey, fallback);
        const display = this.getSessionDisplayName(sessionKey, fallback);
        console.log("[CustomNamesManager] resolveSessionLabel", sessionKey, display);
        return display;
    }

    applySessionNames(sessions) {
        if (!Array.isArray(sessions)) return sessions;
        return sessions.map((session) => {
            const sessionKey = this.buildSessionKey(session);
            const aliasKeys = this.collectSessionAliasKeys(session);
            const originalLabel = session.originalLabel || session.label || session.sessionId;

            if (sessionKey) {
                this.consolidateSessionRecord(sessionKey, originalLabel, aliasKeys);
                this.ensureSessionOriginal(sessionKey, originalLabel);
            }

            const label = sessionKey
                ? this.getSessionDisplayName(sessionKey, originalLabel)
                : (session.label || session.sessionId);
            return {
                ...session,
                label,
                originalName: sessionKey ? this.getSessionOriginalName(sessionKey, originalLabel) : originalLabel,
                hasCustomName: sessionKey ? this.hasSessionCustomName(sessionKey, aliasKeys) : false,
                sessionKey
            };
        });
    }
}

module.exports = { CustomNamesManager, MAX_NAME_LENGTH };
