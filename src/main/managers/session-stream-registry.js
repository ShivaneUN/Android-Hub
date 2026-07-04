const { cloneParams, fromScrcpyOptions, DEFAULT_STREAM_PARAMS } = require("../../shared/stream-params");

/**
 * Registre central des sessions vidéo actives côté processus principal.
 * Source de vérité pour les paramètres de flux et les métadonnées de redémarrage.
 */
class SessionStreamRegistry {
    constructor() {
        /** @type {Map<string, object>} */
        this.sessions = new Map();
    }

    register(sessionId, data = {}) {
        const existing = this.sessions.get(sessionId) || {};
        const streamParams = cloneParams(data.streamParams || existing.streamParams || DEFAULT_STREAM_PARAMS);
        const originalStreamParams = cloneParams(
            data.originalStreamParams || existing.originalStreamParams || streamParams
        );

        const record = {
            sessionId,
            type: data.type || existing.type || "A",
            label: data.label || existing.label || sessionId,
            serial: data.serial || data.deviceId || existing.serial || null,
            deviceId: data.deviceId || data.serial || existing.deviceId || null,
            packageName: data.packageName !== undefined ? data.packageName : (existing.packageName ?? null),
            userId: Number.isInteger(data.userId) ? data.userId : (existing.userId ?? null),
            streamParams,
            originalStreamParams,
            scrcpyOptions: data.scrcpyOptions || existing.scrcpyOptions || null,
            state: data.state || existing.state || "registered"
        };

        this.sessions.set(sessionId, record);
        return record;
    }

    syncFromBrowserViewEntry(sessionId, entry) {
        if (!entry) return null;
        return this.register({
            sessionId,
            type: entry.type,
            label: entry.label,
            deviceId: entry.deviceId,
            serial: entry.deviceId,
            packageName: entry.packageName,
            userId: entry.userId,
            streamParams: entry.streamParams,
            originalStreamParams: entry.originalStreamParams,
            scrcpyOptions: entry.scrcpyOptions,
            state: "active"
        });
    }

    get(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    has(sessionId) {
        return this.sessions.has(sessionId);
    }

    remove(sessionId) {
        this.sessions.delete(sessionId);
    }

    list() {
        return Array.from(this.sessions.values()).map((record) => ({
            sessionId: record.sessionId,
            type: record.type,
            label: record.label,
            deviceId: record.deviceId,
            streamParams: cloneParams(record.streamParams)
        }));
    }

    setStreamParams(sessionId, params, { asOriginal = false } = {}) {
        const record = this.sessions.get(sessionId);
        if (!record) return false;
        record.streamParams = cloneParams(params);
        if (asOriginal) {
            record.originalStreamParams = cloneParams(params);
        }
        return true;
    }

    setScrcpyOptions(sessionId, scrcpyOptions, { asOriginal = false } = {}) {
        const record = this.sessions.get(sessionId);
        if (!record) return false;
        record.scrcpyOptions = { ...scrcpyOptions };
        const params = fromScrcpyOptions(scrcpyOptions, record.type);
        record.streamParams = params;
        if (asOriginal) {
            record.originalStreamParams = cloneParams(params);
        }
        return true;
    }

    getStreamParams(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record) return null;
        return cloneParams(record.streamParams);
    }

    getOriginalStreamParams(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record) return null;
        return cloneParams(record.originalStreamParams);
    }
}

module.exports = { SessionStreamRegistry };
