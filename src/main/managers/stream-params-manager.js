const {
    cloneParams,
    validateParams,
    toScrcpyOptions,
    fromScrcpyOptions,
    normalizeParams,
    normalizeOrientation,
    getOrientationFromScrcpyOptions,
    withOrientation,
    toggleOrientationValue,
    applyCaptureOrientationToOptions,
    DEFAULT_STREAM_PARAMS
} = require("../../shared/stream-params");

const RESTART_TIMEOUT_MS = 45000;

/**
 * Applique réellement les paramètres de flux en redémarrant scrcpy
 * via le pont renderer (Type A) ou NewInstanceManager (Type B).
 */
class StreamParamsManager {
    constructor(deps = {}) {
        this.getBrowserViewManager = deps.getBrowserViewManager;
        this.getNewInstanceManager = deps.getNewInstanceManager;
        this.getRegistry = deps.getRegistry;
        this.getMainWindow = deps.getMainWindow;
        this.waitForRendererRestart = deps.waitForRendererRestart;
        this.stopVideoStream = deps.stopVideoStream;
        this.startVideoStream = deps.startVideoStream;
        this.getVideoClient = deps.getVideoClient;
        this.getGlobalAudioOutputManager = deps.getGlobalAudioOutputManager;
        this.setInputControllerOrientation = deps.setInputControllerOrientation;
        this.getDeviceDimensions = deps.getDeviceDimensions;
        this.applyPhysicalOrientation = deps.applyPhysicalOrientation;
    }

    _resolveOrientation(sessionId, entry) {
        if (entry?.captureOrientation) {
            return normalizeOrientation(entry.captureOrientation);
        }
        const live = this._getLiveScrcpyOptions(sessionId, entry?.type);
        return getOrientationFromScrcpyOptions(live || entry?.scrcpyOptions || {});
    }

    _buildScrcpyOptions(sessionId, entry, type, params, orientation, deviceDims = null) {
        const base = withOrientation(toScrcpyOptions(params, type), orientation);
        if (Number.isInteger(entry.userId)) {
            base.userId = entry.userId;
        }

        const dims = deviceDims || this.getDeviceDimensions?.(entry.deviceId) || null;
        applyCaptureOrientationToOptions(
            base,
            orientation,
            dims?.width,
            dims?.height
        );

        const live = this._getLiveScrcpyOptions(sessionId, type);
        if (!live) return base;

        const merged = {
            ...live,
            bitRate: base.bitRate,
            maxFps: base.maxFps,
            iFrameInterval: base.iFrameInterval,
            orientation: base.orientation,
            userId: base.userId,
            captureOrientationLock: base.captureOrientationLock,
            captureRotation: base.captureRotation
        };

        if (type === "B") {
            if (base.newDisplay) {
                merged.newDisplay = base.newDisplay;
                delete merged.displayId;
            } else if (live.displayId !== undefined) {
                merged.displayId = live.displayId;
                delete merged.newDisplay;
            }
        } else {
            merged.maxSize = base.maxSize;
        }

        if (base.orientation) {
            merged.orientation = base.orientation;
        } else {
            delete merged.orientation;
        }
        if (base.captureOrientationLock) {
            merged.captureOrientationLock = base.captureOrientationLock;
        } else {
            delete merged.captureOrientationLock;
        }
        merged.captureRotation = base.captureRotation || 0;

        return merged;
    }

    _notifyOrientationChanged(sessionId, orientation) {
        const manager = this._manager();
        manager?.sendToSessionView(sessionId, "session:orientation-changed", { sessionId, orientation });

        const win = this.getMainWindow?.();
        if (win && !win.isDestroyed()) {
            win.webContents.send("session:orientation-changed", { sessionId, orientation });
        }

        if (typeof this.setInputControllerOrientation === "function") {
            this.setInputControllerOrientation(sessionId, orientation);
        }
    }

    _manager() {
        return this.getBrowserViewManager?.() || null;
    }

    _registry() {
        return this.getRegistry?.() || null;
    }

    _syncRegistryFromEntry(sessionId, entry) {
        const registry = this._registry();
        if (!registry || !entry) return;
        registry.syncFromBrowserViewEntry(sessionId, entry);
    }

    _notifyStreamRestarting(sessionId) {
        const manager = this._manager();
        manager?.sendToSessionView(sessionId, "stream-restarting", { sessionId });

        const win = this.getMainWindow?.();
        if (win && !win.isDestroyed()) {
            win.webContents.send("stream-restarting", { sessionId });
        }
    }

    notifySessionListChanged() {
        const win = this.getMainWindow?.();
        if (win && !win.isDestroyed()) {
            win.webContents.send("session:list-changed");
        }
    }

    getSessionContext(sessionId) {
        const manager = this._manager();
        if (!manager) {
            return { success: false, error: "Gestionnaire de sessions indisponible" };
        }

        const entry = manager.getSessionEntry(sessionId);
        if (!entry) {
            return { success: false, error: "Session introuvable" };
        }

        this._syncRegistryFromEntry(sessionId, entry);

        const registry = this._registry();
        const record = registry?.get(sessionId);
        const liveOptions = this._getLiveScrcpyOptions(sessionId, entry.type);
        let params = cloneParams(entry.streamParams);

        if (liveOptions) {
            params = normalizeParams(fromScrcpyOptions(liveOptions, entry.type));
            entry.streamParams = cloneParams(params);
            entry.scrcpyOptions = { ...liveOptions };
            registry?.setScrcpyOptions(sessionId, liveOptions);
        } else if (record?.streamParams) {
            params = cloneParams(record.streamParams);
        }

        return {
            success: true,
            entry,
            type: entry.type,
            label: entry.label,
            deviceId: entry.deviceId,
            packageName: entry.packageName,
            userId: entry.userId,
            params,
            originalParams: cloneParams(entry.originalStreamParams)
        };
    }

    _getLiveScrcpyOptions(sessionId, type) {
        if (type === "B") {
            const nim = this.getNewInstanceManager?.();
            const session = nim?.getNewInstanceSession?.(sessionId);
            return session?.streamOptions || null;
        }

        const entry = this._manager()?.getSessionEntry(sessionId);
        return entry?.scrcpyOptions || null;
    }

    getParams(sessionId) {
        const ctx = this.getSessionContext(sessionId);
        if (!ctx.success) return ctx;

        return {
            success: true,
            sessionId,
            type: ctx.type,
            label: ctx.label,
            params: normalizeParams(ctx.params),
            originalParams: normalizeParams(ctx.originalParams)
        };
    }

    async applyParams(sessionId, rawParams) {
        const validation = validateParams(rawParams);
        if (!validation.valid) {
            return { success: false, error: validation.errors.join(" · ") };
        }

        const ctx = this.getSessionContext(sessionId);
        if (!ctx.success) return ctx;

        const { entry, type } = ctx;
        const params = validation.params;

        const orientation = this._resolveOrientation(sessionId, entry);
        const scrcpyOptions = this._buildScrcpyOptions(sessionId, entry, type, params, orientation);

        try {
            this._notifyStreamRestarting(sessionId);

            let restartResult;
            if (type === "B") {
                restartResult = await this._restartTypeB(sessionId, entry, scrcpyOptions);
            } else {
                restartResult = await this._restartTypeA(sessionId, entry, scrcpyOptions);
            }

            if (!restartResult?.success) {
                return restartResult;
            }

            const manager = this._manager();
            manager.setSessionStreamParams(sessionId, params);
            manager.setSessionScrcpyOptions(sessionId, scrcpyOptions);
            manager.setSessionCaptureOrientation(sessionId, orientation, {
                captureRotation: scrcpyOptions.captureRotation || 0
            });
            this._registry()?.setScrcpyOptions(sessionId, scrcpyOptions);

            return {
                success: true,
                sessionId,
                params,
                message: "Paramètres appliqués. Le flux a été redémarré avec les nouvelles valeurs."
            };
        } catch (err) {
            return { success: false, error: err.message || "Impossible d'appliquer les paramètres" };
        }
    }

    getActiveSessionOrientation() {
        const manager = this._manager();
        const sessionId = manager?.getActiveSessionId();
        if (!sessionId) {
            return { success: false, error: "Aucune session active" };
        }
        return this.getOrientation(sessionId);
    }

    getOrientation(sessionId) {
        const ctx = this.getSessionContext(sessionId);
        if (!ctx.success) return ctx;

        const orientation = this._resolveOrientation(sessionId, ctx.entry);
        const manager = this._manager();

        return {
            success: true,
            sessionId,
            type: ctx.type,
            orientation,
            active: sessionId === manager?.getActiveSessionId()
        };
    }

    async setOrientation(sessionId, orientation) {
        const normalized = normalizeOrientation(orientation);
        const ctx = this.getSessionContext(sessionId);
        if (!ctx.success) return ctx;

        const current = this._resolveOrientation(sessionId, ctx.entry);
        if (current === normalized) {
            return {
                success: true,
                sessionId,
                orientation: normalized,
                restarted: false,
                message: "Orientation déjà appliquée."
            };
        }

        const deviceDims = this.getDeviceDimensions?.(ctx.entry.deviceId) || null;
        const scrcpyOptions = this._buildScrcpyOptions(
            sessionId,
            ctx.entry,
            ctx.type,
            ctx.params,
            normalized,
            deviceDims
        );

        let physicalResult = { success: false, physical: false };
        if (typeof this.applyPhysicalOrientation === "function" && ctx.entry.deviceId) {
            physicalResult = await this.applyPhysicalOrientation(
                ctx.entry.deviceId,
                normalized,
                deviceDims
            );
            if (physicalResult?.success) {
                await sleep(350);
            }
        }

        const manager = this._manager();
        manager.setSessionCaptureOrientation(sessionId, normalized, {
            captureRotation: 0
        });

        const priorOptions = ctx.entry.scrcpyOptions ? { ...ctx.entry.scrcpyOptions } : {};
        if (scrcpyOptions.orientation) {
            priorOptions.orientation = scrcpyOptions.orientation;
        } else {
            delete priorOptions.orientation;
        }
        delete priorOptions.captureOrientationLock;
        priorOptions.captureRotation = 0;
        manager.setSessionScrcpyOptions(sessionId, priorOptions);
        this._registry()?.setScrcpyOptions(sessionId, priorOptions);
        this._notifyOrientationChanged(sessionId, normalized);

        const physicalOk = physicalResult?.success === true;
        return {
            success: true,
            sessionId,
            orientation: normalized,
            restarted: false,
            physical: physicalOk,
            message: physicalOk
                ? "Orientation appliquée (écran appareil et affichage)."
                : `Affichage mis à jour. Écran appareil non modifié${physicalResult?.error ? `: ${physicalResult.error}` : ""}.`
        };
    }

    async toggleOrientation(sessionId) {
        const manager = this._manager();
        const targetId = sessionId || manager?.getActiveSessionId();
        if (!targetId) {
            return { success: false, error: "Aucune session active" };
        }

        const entry = manager?.getSessionEntry(targetId);
        if (!entry) {
            return { success: false, error: "Session introuvable" };
        }

        const next = toggleOrientationValue(this._resolveOrientation(targetId, entry));
        return this.setOrientation(targetId, next);
    }

    async resetParams(sessionId) {
        const ctx = this.getSessionContext(sessionId);
        if (!ctx.success) return ctx;
        return this.applyParams(sessionId, ctx.originalParams);
    }

    _hasActiveStream(sessionId, type) {
        if (type === "B") {
            const session = this.getNewInstanceManager?.()?.getNewInstanceSession?.(sessionId);
            return Boolean(session?.client);
        }
        return Boolean(this.getVideoClient?.(sessionId));
    }

    _buildGlobalAudioRefreshOptions(sessionId, entry, type) {
        const orientation = this._resolveOrientation(sessionId, entry);
        const params = entry.streamParams || DEFAULT_STREAM_PARAMS;
        const baseOptions = this._buildScrcpyOptions(sessionId, entry, type, params, orientation);
        const audioManager = this.getGlobalAudioOutputManager?.();
        const withAudio = audioManager && typeof audioManager.applySocketScrcpyOptions === "function"
            ? audioManager.applySocketScrcpyOptions(baseOptions)
            : baseOptions;

        withAudio.skipPackageLaunch = true;
        return withAudio;
    }

    async refreshSessionForGlobalAudio(sessionId) {
        const ctx = this.getSessionContext(sessionId);
        if (!ctx.success) return ctx;

        const { entry, type } = ctx;
        if (!entry.deviceId) {
            return { success: false, error: "Aucun appareil associé à cette session" };
        }
        if (!this._hasActiveStream(sessionId, type)) {
            return { success: true, sessionId, skipped: true };
        }

        const scrcpyOptions = this._buildGlobalAudioRefreshOptions(sessionId, entry, type);

        try {
            this._notifyStreamRestarting(sessionId);

            let restartResult;
            if (type === "B") {
                restartResult = await this._restartTypeB(sessionId, entry, scrcpyOptions);
            } else {
                restartResult = await this._restartTypeA(sessionId, entry, scrcpyOptions);
            }

            if (!restartResult?.success) {
                return restartResult;
            }

            const manager = this._manager();
            manager.setSessionScrcpyOptions(sessionId, scrcpyOptions);
            this._registry()?.setScrcpyOptions(sessionId, scrcpyOptions);

            return { success: true, sessionId };
        } catch (err) {
            return { success: false, error: err.message || "Impossible de rafraîchir la session" };
        }
    }

    async refreshAllSessionsForGlobalAudio() {
        const manager = this._manager();
        if (!manager) return [];

        const sessions = manager.getAllSessions();
        const results = await Promise.allSettled(
            sessions.map((session) => this.refreshSessionForGlobalAudio(session.sessionId))
        );

        return results.map((result, index) => {
            if (result.status === "fulfilled") {
                return result.value;
            }
            return {
                success: false,
                sessionId: sessions[index]?.sessionId,
                error: result.reason?.message || String(result.reason)
            };
        });
    }

    async _restartTypeA(sessionId, entry, scrcpyOptions) {
        if (!entry.deviceId) {
            return { success: false, error: "Aucun appareil associé à cette session" };
        }

        const win = this.getMainWindow?.();
        if (!win || win.isDestroyed()) {
            return { success: false, error: "Fenêtre principale indisponible" };
        }

        // Redémarrage direct côté main (flux BrowserView) — fiable pour le panneau Contrôle
        await this.stopVideoStream(sessionId);
        await sleep(500);

        const result = await this.startVideoStream(
            entry.deviceId,
            sessionId,
            entry.packageName || null,
            scrcpyOptions,
            { force: true }
        );

        if (!result?.success) {
            return { success: false, error: result?.error || "Échec du redémarrage du flux vidéo" };
        }

        return { success: true };
    }

    async _restartTypeB(sessionId, entry, scrcpyOptions) {
        const newInstanceManager = this.getNewInstanceManager?.();
        if (!newInstanceManager) {
            return { success: false, error: "Gestionnaire de nouvelles instances indisponible" };
        }

        const session = newInstanceManager.getNewInstanceSession(sessionId);
        if (!session) {
            return { success: false, error: "Session Type B introuvable dans le gestionnaire de flux" };
        }

        try {
            await newInstanceManager.restartWithStreamOptions(sessionId, scrcpyOptions, {
                userId: entry.userId
            });

            const win = this.getMainWindow?.();
            if (win && !win.isDestroyed()) {
                win.webContents.send("stream-restarting", { sessionId });
            }

            return { success: true };
        } catch (err) {
            return { success: false, error: err.message || "Échec redémarrage session Type B" };
        }
    }

    initSessionParams(sessionId, initialParams, { asOriginal = true } = {}) {
        const manager = this._manager();
        if (!manager) return;
        const params = cloneParams(initialParams || DEFAULT_STREAM_PARAMS);
        manager.setSessionStreamParams(sessionId, params, { asOriginal });
        this._registry()?.register({ sessionId, streamParams: params, originalStreamParams: params });
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { StreamParamsManager };
