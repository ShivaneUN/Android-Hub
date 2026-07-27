const { BrowserView } = require("electron");
const path = require("path");
const { attachTabCycleHandler } = require("../ipc/sessionHandlers");
const { cloneParams, DEFAULT_STREAM_PARAMS, normalizeOrientation } = require("../../shared/stream-params");

const MAX_PENDING_PACKETS = 60;

class BrowserViewManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.views = new Map();
        this.activeSessionId = null;
        this.contentBounds = null;
        this.layoutMode = "single";
        this.multiSessionBounds = new Map();
        this.viewSuppressed = false;
        this.navSidebarWidth = 208;
        this.titlebarHeight = 40;
        this.sessionBarHeight = 40;
        this.earlyEvents = new Map();
        /** Luminosité UI des flux (0.4–1), alignée sur le Hub. */
        this.uiBrightnessFactor = 1;

        const onWindowMetricsChange = () => this._updateActiveBounds();
        this.mainWindow.on("resize", onWindowMetricsChange);
        this.mainWindow.on("maximize", onWindowMetricsChange);
        this.mainWindow.on("unmaximize", onWindowMetricsChange);
    }

    _boundsEqual(a, b) {
        if (!a || !b) return false;
        return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    }

    _multiBoundsMapsEqual(left, right) {
        if (left.size !== right.size) return false;
        for (const [sessionId, bounds] of right) {
            if (!this._boundsEqual(left.get(sessionId), bounds)) return false;
        }
        return true;
    }

    setContentBounds(bounds) {
        if (!bounds || typeof bounds !== "object") return;
        const { x, y, width, height } = bounds;
        if (![x, y, width, height].every((v) => Number.isFinite(v))) return;

        const normalized = {
            x: Math.max(0, Math.round(x)),
            y: Math.max(0, Math.round(y)),
            width: Math.max(0, Math.round(width)),
            height: Math.max(0, Math.round(height))
        };

        if (
            this.layoutMode === "single"
            && this.multiSessionBounds.size === 0
            && this.contentBounds
            && this._boundsEqual(this.contentBounds, normalized)
        ) {
            return;
        }

        this.layoutMode = "single";
        this.multiSessionBounds.clear();
        this.contentBounds = normalized;
        this._updateActiveBounds();
    }

    setLayoutMode(mode) {
        const next = mode === "multi" ? "multi" : "single";
        if (next === this.layoutMode) return;
        this.layoutMode = next;
        // Un layout explicite doit toujours réafficher les vues (sortie Accueil / Stream Deck).
        this.viewSuppressed = false;
        if (next === "single") {
            this.multiSessionBounds.clear();
            this._updateActiveBounds();
        } else {
            this._applyMultiLayoutBounds();
        }
    }

    setMultiSessionBounds(boundsMap = {}) {
        const nextMap = new Map();

        for (const [sessionId, bounds] of Object.entries(boundsMap)) {
            if (!bounds || typeof bounds !== "object") continue;
            const { x, y, width, height } = bounds;
            if (![x, y, width, height].every((v) => Number.isFinite(v))) continue;
            if (width <= 0 || height <= 0) continue;
            nextMap.set(sessionId, {
                x: Math.max(0, Math.round(x)),
                y: Math.max(0, Math.round(y)),
                width: Math.max(0, Math.round(width)),
                height: Math.max(0, Math.round(height))
            });
        }

        // Même carte de bounds : il faut quand même lever suppress (retour Accueil → Stream Deck).
        this.viewSuppressed = false;

        if (this.layoutMode === "multi" && this._multiBoundsMapsEqual(this.multiSessionBounds, nextMap)) {
            this._applyMultiLayoutBounds();
            return;
        }

        this.layoutMode = "multi";
        this.multiSessionBounds = nextMap;
        this._applyMultiLayoutBounds();
    }

    suppressActiveView() {
        console.log("[BrowserViewManager] suppressActiveView", this.activeSessionId);
        this.viewSuppressed = true;
        this.views.forEach(({ view }) => {
            if (!view.webContents.isDestroyed()) {
                view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
            }
        });
    }

    restoreActiveView() {
        console.log("[BrowserViewManager] restoreActiveView", this.activeSessionId, this.layoutMode);
        this.viewSuppressed = false;
        if (this.layoutMode === "multi" && this.multiSessionBounds.size > 0) {
            this._applyMultiLayoutBounds();
            return;
        }
        if (!this.activeSessionId) return;
        this._updateActiveBounds();
    }

    createSessionView(sessionId, type, extraQuery = {}) {
        const existing = this.views.get(sessionId);
        if (existing) {
            console.warn(`[BrowserViewManager] Session ${sessionId} existe déjà`);
            return existing.view;
        }

        const view = new BrowserView({
            webPreferences: {
                preload: path.join(__dirname, "../../preload/sessionPreload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        this.mainWindow.addBrowserView(view);
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

        const entry = {
            view,
            type,
            label: extraQuery.label || sessionId,
            originalLabel: extraQuery.label || sessionId,
            deviceId: extraQuery.deviceId || extraQuery.serial || null,
            stableDeviceId: extraQuery.stableDeviceId || null,
            packageName: extraQuery.packageName || null,
            userId: Number.isInteger(extraQuery.userId) ? extraQuery.userId : null,
            screenOff: Boolean(extraQuery.screenOff),
            stayAwakeActive: Boolean(extraQuery.stayAwakeActive),
            captureOrientation: type === "B"
                ? normalizeOrientation("landscape")
                : normalizeOrientation(extraQuery.captureOrientation || "landscape"),
            streamParams: cloneParams(extraQuery.streamParams || DEFAULT_STREAM_PARAMS),
            originalStreamParams: cloneParams(extraQuery.streamParams || DEFAULT_STREAM_PARAMS),
            scrcpyOptions: null,
            ready: false,
            pendingEvents: []
        };

        entry.readyPromise = new Promise((resolve) => {
            const markReady = () => {
                if (entry.ready) return;
                entry.ready = true;
                global.launchLatencyTracker?.mark?.({ sessionId, stage: "browserViewReady" });
                this._flushPendingEvents(sessionId);
                if (this.activeSessionId === sessionId) {
                    this._focusSessionInput(sessionId);
                }
                resolve(true);
            };

            if (view.webContents.isLoading()) {
                view.webContents.once("did-finish-load", () => {
                    markReady();
                    this._applyBrightnessToView(view);
                });
            } else {
                markReady();
                this._applyBrightnessToView(view);
            }
        });

        this.views.set(sessionId, entry);
        attachTabCycleHandler(view.webContents);
        this._replayEarlyEvents(sessionId);
        console.log("[BrowserViewManager] session view created (stream continues in BrowserView)", sessionId, type);

        const query = {
            sessionId,
            type,
            deviceId: extraQuery.deviceId || extraQuery.serial || undefined,
            label: extraQuery.label || undefined,
            packageName: extraQuery.packageName || undefined,
            userId: Number.isInteger(extraQuery.userId) ? extraQuery.userId : undefined,
            orientation: type === "B" ? "landscape" : entry.captureOrientation,
            captureRotation: entry.captureRotation || 0
        };
        Object.keys(query).forEach((key) => {
            if (query[key] === undefined) delete query[key];
        });

        const loadSessionPage = (uiTheme = "classic") => {
            query.uiTheme = uiTheme === "tablet" ? "tablet" : "classic";
            view.webContents.loadFile(
                path.join(__dirname, "../../renderer/session/session.html"),
                { query }
            );
        };

        this.mainWindow.webContents
            .executeJavaScript(
                `(() => {
                    try {
                        const theme = localStorage.getItem('androidHub.uiTheme') || 'classic';
                        const brightnessRaw = localStorage.getItem('androidHub.uiBrightness');
                        const brightness = brightnessRaw == null || brightnessRaw === ''
                            ? 100
                            : Math.min(100, Math.max(40, Math.round(Number(brightnessRaw) || 100)));
                        return { theme, brightness };
                    } catch (_err) {
                        return { theme: 'classic', brightness: 100 };
                    }
                })()`
            )
            .then((prefs) => {
                const theme = prefs?.theme || "classic";
                const brightness = Number(prefs?.brightness);
                if (Number.isFinite(brightness)) {
                    this.setUiBrightness(brightness, { apply: false });
                }
                loadSessionPage(theme);
            })
            .catch(() => loadSessionPage(extraQuery.uiTheme || "classic"));

        console.log(`[BrowserViewManager] Session ${sessionId} (type ${type}) créée`);
        return view;
    }

    async registerSessionView(sessionId, type, extraQuery = {}) {
        global.launchLatencyTracker?.mark?.({ sessionId, stage: "registerViewStart" });
        if (!this.views.has(sessionId)) {
            this.createSessionView(sessionId, type, extraQuery);
        } else {
            const patch = { ...extraQuery };
            delete patch.label;
            this.updateSessionMetadata(sessionId, patch);
        }

        const entry = this.views.get(sessionId);
        if (!entry) return false;

        await entry.readyPromise;
        return this.switchToSession(sessionId);
    }

    updateSessionMetadata(sessionId, extraQuery = {}) {
        const entry = this.views.get(sessionId);
        if (!entry) return false;

        if (extraQuery.label) entry.label = extraQuery.label;
        if (extraQuery.originalLabel) entry.originalLabel = extraQuery.originalLabel;
        if (extraQuery.deviceId || extraQuery.serial) {
            entry.deviceId = extraQuery.deviceId || extraQuery.serial;
        }
        if (extraQuery.stableDeviceId) {
            entry.stableDeviceId = extraQuery.stableDeviceId;
        }
        if (extraQuery.packageName !== undefined) entry.packageName = extraQuery.packageName;
        if (Number.isInteger(extraQuery.userId)) entry.userId = extraQuery.userId;
        if (extraQuery.streamParams) {
            entry.streamParams = cloneParams(extraQuery.streamParams);
            if (!entry._streamInitialized) {
                entry.originalStreamParams = cloneParams(extraQuery.streamParams);
            }
        }
        return true;
    }

    async _ensureSessionInputReady(sessionId) {
        const entry = this.views.get(sessionId);
        if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) {
            return;
        }

        let inputReady = false;
        try {
            inputReady = await entry.view.webContents.executeJavaScript("Boolean(window.__sessionInputReady)");
        } catch (_err) {
            inputReady = false;
        }

        if (!inputReady && entry.view.webContents.isLoading()) {
            try {
                await entry.readyPromise;
                inputReady = await entry.view.webContents.executeJavaScript("Boolean(window.__sessionInputReady)");
            } catch (_err) {
                inputReady = false;
            }
        }

        if (inputReady) return;

        console.log("[BrowserViewManager] Rechargement vue session (handlers input absents):", sessionId);
        entry.ready = false;
        entry.readyPromise = new Promise((resolve) => {
            const markReady = () => {
                entry.ready = true;
                this._flushPendingEvents(sessionId);
                if (this.activeSessionId === sessionId) {
                    this._focusSessionInput(sessionId);
                }
                resolve(true);
            };
            if (entry.view.webContents.isLoading()) {
                entry.view.webContents.once("did-finish-load", markReady);
            } else {
                markReady();
            }
        });

        entry.view.webContents.reload();
        await entry.readyPromise;
    }

    _focusSessionInput(sessionId) {
        const entry = this.views.get(sessionId);
        if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) return;

        entry.view.webContents.send("session:input-active", { active: true });
        if (!this.mainWindow.isDestroyed()) {
            this.mainWindow.focus();
        }
        entry.view.webContents.focus();

        void entry.view.webContents.executeJavaScript("window.__sessionFocusCanvas?.()").catch(() => {});
    }

    _notifyMainWindowSessionUi(sessionId) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        this.mainWindow.webContents.send("session:list-changed");
    }

    async switchToSession(sessionId) {
        if (!this.views.has(sessionId)) {
            console.error(`[BrowserViewManager] Session ${sessionId} introuvable`);
            return false;
        }

        await this._ensureSessionInputReady(sessionId);

        const multiLayout = this.layoutMode === "multi" && this.multiSessionBounds.size > 0;

        if (!multiLayout) {
            this.views.forEach(({ view }, id) => {
                if (id !== sessionId) view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
            });
        }

        this.activeSessionId = sessionId;

        const { view } = this.views.get(sessionId);
        this.mainWindow.removeBrowserView(view);
        this.mainWindow.addBrowserView(view);

        if (this.viewSuppressed) {
            this.views.forEach(({ view: sessionView }) => {
                if (!sessionView.webContents.isDestroyed()) {
                    sessionView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
                }
            });
        } else if (multiLayout) {
            this._applyMultiLayoutBounds();
        } else {
            this._updateActiveBounds();
        }

        this.views.forEach(({ view: sessionView }, id) => {
            if (sessionView.webContents.isDestroyed()) return;
            sessionView.webContents.send("session:input-active", { active: id === sessionId });
        });

        this.mainWindow.setTopBrowserView(view);
        if (!this.mainWindow.isDestroyed()) {
            this.mainWindow.focus();
        }
        view.webContents.focus();

        this._focusSessionInput(sessionId);
        this._notifyMainWindowSessionUi(sessionId);

        return true;
    }

    closeSessionView(sessionId) {
        const entry = this.views.get(sessionId);
        if (!entry) return false;

        const { view } = entry;
        try {
            this.mainWindow.removeBrowserView(view);
        } catch (_err) {
            // noop
        }
        try {
            if (view?.webContents && !view.webContents.isDestroyed()) {
                view.webContents.destroy();
            }
        } catch (_err) {
            // noop
        }
        this.views.delete(sessionId);
        this.earlyEvents.delete(sessionId);

        if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
            this.viewSuppressed = false;
        }

        console.log(`[BrowserViewManager] Session ${sessionId} fermée (view destroyed, stream stopped by caller)`);
        this._notifyMainWindowSessionUi();
        return true;
    }

    sendToSessionView(sessionId, channel, payload) {
        const entry = this.views.get(sessionId);
        if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) {
            // Ne pas bufferiser pour une session déjà fermée (évite replay fantôme).
            if (!this.views.has(sessionId)) return;
            this._stashEarlyEvent(sessionId, channel, payload);
            return;
        }

        if (!entry.ready) {
            this._bufferPendingEvent(entry, channel, payload);
            return;
        }

        entry.view.webContents.send(channel, payload);
    }

    _stashEarlyEvent(sessionId, channel, payload) {
        if (!sessionId || !channel) return;

        const isVideo = channel === "video-codec-meta"
            || channel === "new-instance:video-codec-meta"
            || channel === "video-packet"
            || channel === "new-instance:video-packet"
            || channel === "audio-codec-meta"
            || channel === "new-instance:audio-codec-meta"
            || channel === "audio-packet"
            || channel === "new-instance:audio-packet";

        if (!isVideo) return;

        if (!this.earlyEvents.has(sessionId)) {
            this.earlyEvents.set(sessionId, []);
        }

        const queue = this.earlyEvents.get(sessionId);
        if (channel.endsWith("video-codec-meta") || channel.endsWith("audio-codec-meta")) {
            const idx = queue.findIndex((evt) => evt.channel === channel);
            if (idx !== -1) queue.splice(idx, 1);
            queue.unshift({ channel, payload });
            return;
        }

        queue.push({ channel, payload });
        while (queue.length > MAX_PENDING_PACKETS) {
            const dropIndex = queue.findIndex(
                (evt) => evt.channel === "video-packet"
                    || evt.channel === "new-instance:video-packet"
                    || evt.channel === "audio-packet"
                    || evt.channel === "new-instance:audio-packet"
            );
            if (dropIndex === -1) break;
            queue.splice(dropIndex, 1);
        }
    }

    _replayEarlyEvents(sessionId) {
        const queue = this.earlyEvents.get(sessionId);
        if (!queue?.length) return;
        this.earlyEvents.delete(sessionId);
        for (const { channel, payload } of queue) {
            this.sendToSessionView(sessionId, channel, payload);
        }
    }

    _bufferPendingEvent(entry, channel, payload) {
        const isPriorityMeta = channel === "video-codec-meta"
            || channel === "new-instance:video-codec-meta"
            || channel === "audio-codec-meta"
            || channel === "new-instance:audio-codec-meta";

        const isPriorityConfig = false;

        if (isPriorityMeta || isPriorityConfig) {
            entry.pendingEvents = entry.pendingEvents.filter((evt) => evt.channel !== channel);
            entry.pendingEvents.unshift({ channel, payload });
            return;
        }

        entry.pendingEvents.push({ channel, payload });
        while (entry.pendingEvents.length > MAX_PENDING_PACKETS) {
            const dropIndex = entry.pendingEvents.findIndex(
                (evt) => evt.channel === "video-packet"
                    || evt.channel === "new-instance:video-packet"
                    || evt.channel === "audio-packet"
                    || evt.channel === "new-instance:audio-packet"
            );
            if (dropIndex === -1) break;
            entry.pendingEvents.splice(dropIndex, 1);
        }
    }

    _flushPendingEvents(sessionId) {
        const entry = this.views.get(sessionId);
        if (!entry?.ready || !entry.view?.webContents || entry.view.webContents.isDestroyed()) {
            return;
        }

        const events = entry.pendingEvents.splice(0, entry.pendingEvents.length);
        for (const { channel, payload } of events) {
            entry.view.webContents.send(channel, payload);
        }
    }

    _resolveContentBounds() {
        const [winWidth, winHeight] = this.mainWindow.getContentSize();

        if (this.contentBounds) {
            const { x, y, width, height } = this.contentBounds;
            const bx = Math.max(0, Math.round(x));
            const by = Math.max(0, Math.round(y));
            const bw = Math.max(0, Math.round(width));
            const bh = Math.max(0, Math.round(height));

            if (bw > 0 && bh > 0) {
                return {
                    x: bx,
                    y: by,
                    width: Math.min(bw, Math.max(0, winWidth - bx)),
                    height: Math.min(bh, Math.max(0, winHeight - by))
                };
            }

            return {
                x: bx,
                y: by,
                width: Math.max(0, winWidth - bx),
                height: Math.max(0, winHeight - by)
            };
        }

        const topOffset = this.titlebarHeight + this.sessionBarHeight;
        return {
            x: this.navSidebarWidth,
            y: topOffset,
            width: Math.max(0, winWidth - this.navSidebarWidth),
            height: Math.max(0, winHeight - topOffset)
        };
    }

    _applyMultiLayoutBounds() {
        if (this.viewSuppressed) {
            this.views.forEach(({ view }) => {
                if (!view.webContents.isDestroyed()) {
                    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
                }
            });
            return;
        }

        const [winWidth, winHeight] = this.mainWindow.getContentSize();

        this.views.forEach(({ view }, sessionId) => {
            if (view.webContents.isDestroyed()) return;

            const raw = this.multiSessionBounds.get(sessionId);
            if (!raw) {
                view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
                return;
            }

            const bx = Math.max(0, Math.round(raw.x));
            const by = Math.max(0, Math.round(raw.y));
            const bw = Math.max(0, Math.round(raw.width));
            const bh = Math.max(0, Math.round(raw.height));

            view.setBounds({
                x: bx,
                y: by,
                width: Math.min(bw, Math.max(0, winWidth - bx)),
                height: Math.min(bh, Math.max(0, winHeight - by))
            });
        });

        if (this.activeSessionId) {
            const activeEntry = this.views.get(this.activeSessionId);
            if (activeEntry?.view && !activeEntry.view.webContents.isDestroyed()) {
                this.mainWindow.setTopBrowserView(activeEntry.view);
            }
        }
    }

    _updateActiveBounds() {
        if (this.layoutMode === "multi" && this.multiSessionBounds.size > 0) {
            this._applyMultiLayoutBounds();
            return;
        }

        if (!this.activeSessionId) return;
        const entry = this.views.get(this.activeSessionId);
        if (!entry) return;

        if (this.viewSuppressed) {
            console.log("[BrowserViewManager] bounds suppressed (0×0)", this.activeSessionId);
            entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
            return;
        }

        const bounds = this._resolveContentBounds();
        entry.view.setBounds(bounds);
    }

    getSessionEntry(sessionId) {
        return this.views.get(sessionId) || null;
    }

    getActiveSessionId() {
        return this.activeSessionId;
    }

    getActiveTypeASession() {
        if (!this.activeSessionId) return null;
        const entry = this.views.get(this.activeSessionId);
        if (!entry || entry.type !== "A" || !entry.deviceId) return null;
        return {
            sessionId: this.activeSessionId,
            deviceId: entry.deviceId,
            screenOff: Boolean(entry.screenOff),
            stayAwakeActive: Boolean(entry.stayAwakeActive),
            label: entry.label
        };
    }

    setSessionScreenOff(sessionId, screenOff) {
        const entry = this.views.get(sessionId);
        if (!entry) return false;
        entry.screenOff = Boolean(screenOff);
        return true;
    }

    setSessionStayAwake(sessionId, active) {
        const entry = this.views.get(sessionId);
        if (!entry) return false;
        entry.stayAwakeActive = Boolean(active);
        return true;
    }

    setSessionStreamParams(sessionId, params, { asOriginal = false } = {}) {
        const entry = this.views.get(sessionId);
        if (!entry) return false;
        entry.streamParams = cloneParams(params);
        if (asOriginal) {
            entry.originalStreamParams = cloneParams(params);
        }
        return true;
    }

    setSessionScrcpyOptions(sessionId, scrcpyOptions) {
        const entry = this.views.get(sessionId);
        if (!entry) return false;
        entry.scrcpyOptions = scrcpyOptions ? { ...scrcpyOptions } : null;
        if (entry.type === "B") {
            entry.captureOrientation = normalizeOrientation("landscape");
            if (scrcpyOptions?.captureRotation !== undefined) {
                entry.captureRotation = Number(scrcpyOptions.captureRotation) || 0;
            }
        } else if (scrcpyOptions?.orientation === "portrait") {
            entry.captureOrientation = normalizeOrientation("portrait");
        } else if (scrcpyOptions) {
            entry.captureOrientation = normalizeOrientation("landscape");
        }
        entry._streamInitialized = true;
        return true;
    }

    setSessionCaptureOrientation(sessionId, orientation, {
        captureRotation,
        updateCaptureRotation = false
    } = {}) {
        const entry = this.views.get(sessionId);
        if (!entry) return false;
        if (entry.type === "B") {
            entry.captureOrientation = normalizeOrientation("landscape");
            if (updateCaptureRotation) {
                entry.captureRotation = Number.isFinite(Number(captureRotation)) ? Number(captureRotation) : 0;
                this.sendToSessionView(sessionId, "session:capture-rotation-changed", {
                    sessionId,
                    captureRotation: entry.captureRotation
                });
            }
            return true;
        }
        entry.captureOrientation = normalizeOrientation(orientation);
        if (updateCaptureRotation) {
            entry.captureRotation = Number.isFinite(Number(captureRotation)) ? Number(captureRotation) : 0;
            this.sendToSessionView(sessionId, "session:capture-rotation-changed", {
                sessionId,
                captureRotation: entry.captureRotation
            });
        }
        return true;
    }

    getAllSessions() {
        return Array.from(this.views.entries()).map(([sessionId, entry]) => ({
            sessionId,
            type: entry.type,
            label: entry.label,
            originalLabel: entry.originalLabel || entry.label,
            deviceId: entry.deviceId || null,
            stableDeviceId: entry.stableDeviceId || null,
            packageName: entry.packageName || null,
            userId: Number.isInteger(entry.userId) ? entry.userId : null,
            screenOff: Boolean(entry.screenOff),
            captureOrientation: normalizeOrientation(entry.captureOrientation || "landscape"),
            active: sessionId === this.activeSessionId,
            streamParams: cloneParams(entry.streamParams)
        }));
    }

    /**
     * Réordonne les sessions (onglets / Ctrl+Tab / grille) selon orderedIds.
     * Ne recrée pas les BrowserViews — reconstruit uniquement l'ordre de la Map.
     */
    reorderSessions(orderedIds = []) {
        if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
            return { success: false, error: "orderedIds requis" };
        }

        const currentIds = Array.from(this.views.keys());
        if (orderedIds.length !== currentIds.length) {
            return { success: false, error: "nombre d'onglets incohérent" };
        }

        const currentSet = new Set(currentIds);
        const nextSet = new Set(orderedIds);
        if (nextSet.size !== orderedIds.length || orderedIds.some((id) => !currentSet.has(id))) {
            return { success: false, error: "identifiants invalides" };
        }

        const unchanged = orderedIds.every((id, index) => id === currentIds[index]);
        if (unchanged) {
            return { success: true, changed: false };
        }

        const nextViews = new Map();
        for (const sessionId of orderedIds) {
            nextViews.set(sessionId, this.views.get(sessionId));
        }
        this.views = nextViews;
        this._notifyMainWindowSessionUi();
        return { success: true, changed: true };
    }

    async getFrameCountsForAllSessions() {
        const counts = {};

        for (const [sessionId, entry] of this.views.entries()) {
            if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) {
                counts[sessionId] = 0;
                continue;
            }

            try {
                const count = await entry.view.webContents.executeJavaScript(
                    "window.__sessionVideoHandle?.getFrameCount?.() ?? 0",
                    true
                );
                counts[sessionId] = Number.isFinite(count) ? count : 0;
            } catch (_err) {
                counts[sessionId] = 0;
            }
        }

        return counts;
    }

    async capturePreviewFrame(sessionId) {
        const entry = this.views.get(sessionId);
        if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) {
            return { available: false };
        }

        try {
            const dataUrl = await entry.view.webContents.executeJavaScript(
                "window.__sessionVideoHandle?.capturePreviewFrame?.() ?? null",
                true
            );
            if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
                return { available: true, dataUrl };
            }
            return { available: false };
        } catch (_err) {
            return { available: false };
        }
    }

    /**
     * @param {number} percent 40–100
     * @param {{ apply?: boolean }} [options]
     */
    setUiBrightness(percent, options = {}) {
        const apply = options.apply !== false;
        const n = Math.round(Number(percent));
        const clamped = Number.isFinite(n) ? Math.min(100, Math.max(40, n)) : 100;
        this.uiBrightnessFactor = clamped / 100;
        if (apply) {
            this.applyUiBrightnessToAllViews();
        }
        return clamped;
    }

    _applyBrightnessToView(view) {
        if (!view?.webContents || view.webContents.isDestroyed()) return;
        const factor = Number.isFinite(this.uiBrightnessFactor) ? this.uiBrightnessFactor : 1;
        const script = `(function (factor) {
            try {
                const root = document.documentElement;
                if (!root) return false;
                root.style.setProperty("--hub-ui-brightness", String(factor));
                root.style.filter = factor >= 0.995 ? "" : ("brightness(" + factor + ")");
                return true;
            } catch (_err) {
                return false;
            }
        })(${JSON.stringify(factor)})`;
        void view.webContents.executeJavaScript(script, true).catch(() => {});
    }

    applyUiBrightnessToAllViews() {
        for (const entry of this.views.values()) {
            this._applyBrightnessToView(entry?.view);
        }
    }
}

module.exports = BrowserViewManager;
