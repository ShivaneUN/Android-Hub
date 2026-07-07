(function initDisplayLayoutState() {
    const STORAGE_KEYS = {
        streamDeckMode: "androidHub.streamDeckMode",
        displayLayout: "androidHub.displayLayout",
        focusedDeviceId: "androidHub.focusedDeviceId",
        duoDeviceIds: "androidHub.duoDeviceIds"
    };

    const LAYOUTS = ["grid", "focus", "duo"];
    const listeners = new Set();

    let streamDeckMode = false;
    let displayLayout = "grid";
    let focusedDeviceId = null;
    let duoDeviceIds = [null, null];

    function notifyChange() {
        for (const listener of listeners) {
            try {
                listener({
                    streamDeckMode,
                    displayLayout,
                    focusedDeviceId,
                    duoDeviceIds: [...duoDeviceIds]
                });
            } catch (err) {
                console.warn("[DisplayLayoutState] listener error:", err);
            }
        }
    }

    function normalizeDuoSlots(ids) {
        const slots = [null, null];
        if (!Array.isArray(ids)) return slots;
        if (typeof ids[0] === "string") slots[0] = ids[0];
        if (typeof ids[1] === "string") slots[1] = ids[1];
        return slots;
    }

    function readLocalStreamDeckMode() {
        return localStorage.getItem(STORAGE_KEYS.streamDeckMode) === "true";
    }

    function readLocalDisplayLayout() {
        const raw = localStorage.getItem(STORAGE_KEYS.displayLayout);
        return LAYOUTS.includes(raw) ? raw : "grid";
    }

    function readLocalFocusedDeviceId() {
        const raw = localStorage.getItem(STORAGE_KEYS.focusedDeviceId);
        return raw || null;
    }

    function readLocalDuoDeviceIds() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.duoDeviceIds);
            if (!raw) return [null, null];
            return normalizeDuoSlots(JSON.parse(raw));
        } catch {
            return [null, null];
        }
    }

    async function loadPersistedState() {
        if (window.uiPreferencesAPI?.getPreferences) {
            try {
                const prefs = await window.uiPreferencesAPI.getPreferences();
                if (prefs) {
                    if (LAYOUTS.includes(prefs.displayLayout)) {
                        displayLayout = prefs.displayLayout;
                    }
                    if (typeof prefs.focusedDeviceId === "string" || prefs.focusedDeviceId === null) {
                        focusedDeviceId = prefs.focusedDeviceId;
                    }
                    if (Array.isArray(prefs.duoDeviceIds)) {
                        duoDeviceIds = normalizeDuoSlots(prefs.duoDeviceIds);
                    }
                }
            } catch (err) {
                console.warn("[DisplayLayoutState] getPreferences failed:", err);
            }
        } else {
            displayLayout = readLocalDisplayLayout();
            focusedDeviceId = readLocalFocusedDeviceId();
            duoDeviceIds = readLocalDuoDeviceIds();
        }

        // Toujours démarrer hors mode Stream Deck — activation manuelle via la sidebar.
        streamDeckMode = false;
    }

    async function persistState() {
        localStorage.setItem(STORAGE_KEYS.streamDeckMode, streamDeckMode ? "true" : "false");
        localStorage.setItem(STORAGE_KEYS.displayLayout, displayLayout);
        if (focusedDeviceId) {
            localStorage.setItem(STORAGE_KEYS.focusedDeviceId, focusedDeviceId);
        } else {
            localStorage.removeItem(STORAGE_KEYS.focusedDeviceId);
        }
        localStorage.setItem(STORAGE_KEYS.duoDeviceIds, JSON.stringify(duoDeviceIds));

        if (window.uiPreferencesAPI?.setDisplayPreferences) {
            try {
                await window.uiPreferencesAPI.setDisplayPreferences({
                    streamDeckMode,
                    displayLayout,
                    focusedDeviceId,
                    duoDeviceIds
                });
            } catch (err) {
                console.warn("[DisplayLayoutState] setDisplayPreferences failed:", err);
            }
        }
    }

    function ensureFocusedSessionExists(sessions = []) {
        if (!sessions.length) {
            focusedDeviceId = null;
            return;
        }
        const ids = sessions.map((s) => s.sessionId);
        if (!focusedDeviceId || !ids.includes(focusedDeviceId)) {
            const active = sessions.find((s) => s.active);
            focusedDeviceId = active?.sessionId || sessions[0].sessionId;
        }
    }

    function ensureDuoSessionsExist(sessions = []) {
        normalizeDuoSlotsForSessions(sessions, { autoFill: true, persist: false, notify: false });
    }

    function normalizeDuoSlotsForSessions(sessions = [], options = {}) {
        const { autoFill = true, persist = false, notify = false } = options;
        const ids = sessions.map((s) => s.sessionId);
        const idSet = new Set(ids);
        const slots = normalizeDuoSlots(duoDeviceIds);

        slots[0] = slots[0] && idSet.has(slots[0]) ? slots[0] : null;
        slots[1] = slots[1] && idSet.has(slots[1]) ? slots[1] : null;

        if (slots[0] && slots[1] && slots[0] === slots[1]) {
            slots[1] = null;
        }

        if (autoFill && sessions.length > 0) {
            const activeId = sessions.find((s) => s.active)?.sessionId || null;
            const pickNext = (exclude = []) => {
                if (activeId && idSet.has(activeId) && !exclude.includes(activeId)) return activeId;
                return ids.find((id) => !exclude.includes(id)) || null;
            };

            if (!slots[0]) {
                slots[0] = pickNext(slots[1] ? [slots[1]] : []);
            }
            if (!slots[1]) {
                slots[1] = pickNext(slots[0] ? [slots[0]] : []);
            }
        }

        const unchanged = slots[0] === duoDeviceIds[0] && slots[1] === duoDeviceIds[1];
        duoDeviceIds = slots;

        if (!unchanged) {
            if (persist) void persistState();
            if (notify) notifyChange();
        }

        return !unchanged;
    }

    function syncSessionAnchors(sessions = []) {
        ensureFocusedSessionExists(sessions);
        if (displayLayout === "duo") {
            normalizeDuoSlotsForSessions(sessions, { autoFill: true, persist: false, notify: false });
        } else {
            ensureDuoSessionsExist(sessions);
        }
    }

    function setStreamDeckMode(enabled, options = {}) {
        const { persist = true, notify = true } = options;
        const next = Boolean(enabled);
        if (streamDeckMode === next) return streamDeckMode;

        streamDeckMode = next;
        if (persist) void persistState();
        if (typeof window.invalidateVideoLayoutBoundsCache === "function") {
            window.invalidateVideoLayoutBoundsCache();
        }
        if (notify) notifyChange();

        return streamDeckMode;
    }

    function toggleStreamDeckMode(options = {}) {
        return setStreamDeckMode(!streamDeckMode, options);
    }

    function setDisplayLayout(layout, options = {}) {
        const { persist = true, notify = true } = options;
        if (!LAYOUTS.includes(layout)) return false;
        if (displayLayout === layout) return true;

        displayLayout = layout;
        if (persist) void persistState();
        if (notify) notifyChange();

        if (layout === "duo" && window.sessionAPI?.list) {
            void window.sessionAPI.list().then((sessions) => {
                const changed = normalizeDuoSlotsForSessions(sessions, {
                    autoFill: true,
                    persist: true,
                    notify: true
                });
                if (changed && typeof window.refreshStreamDeckZone === "function") {
                    window.refreshStreamDeckZone();
                }
            });
        }

        return true;
    }

    function setFocusedDeviceId(sessionId, options = {}) {
        const { persist = true, notify = true } = options;
        focusedDeviceId = sessionId || null;
        if (persist) void persistState();
        if (notify) notifyChange();
    }

    function setDuoDeviceIds(ids = [], options = {}) {
        const { persist = true, notify = true } = options;
        const normalized = normalizeDuoSlots(ids);
        const unchanged = normalized[0] === duoDeviceIds[0] && normalized[1] === duoDeviceIds[1];
        duoDeviceIds = normalized;
        if (persist) void persistState();
        if (notify && !unchanged) notifyChange();
    }

    function setDuoSlot(index, sessionId, options = {}) {
        const slots = normalizeDuoSlots(duoDeviceIds);
        if (index === 0 || index === 1) {
            slots[index] = sessionId || null;
        }
        setDuoDeviceIds(slots, options);
    }

    function cycleDisplayLayout(direction = "next") {
        if (!streamDeckMode) return displayLayout;
        const idx = LAYOUTS.indexOf(displayLayout);
        const nextIdx = direction === "prev"
            ? (idx - 1 + LAYOUTS.length) % LAYOUTS.length
            : (idx + 1) % LAYOUTS.length;
        setDisplayLayout(LAYOUTS[nextIdx]);
        return displayLayout;
    }

    function onDisplayLayoutChange(listener) {
        if (typeof listener !== "function") return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    async function init() {
        await loadPersistedState();
        localStorage.setItem(STORAGE_KEYS.streamDeckMode, "false");
        if (window.sessionAPI?.list) {
            try {
                const sessions = await window.sessionAPI.list();
                syncSessionAnchors(sessions);
            } catch (_err) {
                // noop
            }
        }
        notifyChange();
    }

    window.getStreamDeckMode = () => streamDeckMode;
    window.setStreamDeckMode = setStreamDeckMode;
    window.toggleStreamDeckMode = toggleStreamDeckMode;
    window.getDisplayLayout = () => displayLayout;
    window.setDisplayLayout = setDisplayLayout;
    window.getFocusedDeviceId = () => focusedDeviceId;
    window.setFocusedDeviceId = setFocusedDeviceId;
    window.getDuoDeviceIds = () => normalizeDuoSlots(duoDeviceIds);
    window.setDuoDeviceIds = setDuoDeviceIds;
    window.setDuoSlot = setDuoSlot;
    window.cycleDisplayLayout = cycleDisplayLayout;
    window.syncDisplayLayoutSessions = syncSessionAnchors;
    window.normalizeDuoSlotsForSessions = normalizeDuoSlotsForSessions;
    window.onDisplayLayoutChange = onDisplayLayoutChange;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            void init();
        });
    } else {
        void init();
    }
})();
