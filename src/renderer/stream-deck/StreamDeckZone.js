(function initStreamDeckZone() {
    const SHELL_ID = "stream-deck-shell";
    const ZONE_ID = "stream-deck-zone";
    const MIN_TILE_BOUNDS = 48;
    const SYNC_DEBOUNCE_MS = 48;

    let syncQueue = Promise.resolve();
    let resizeObserver = null;
    let lastSessionsKey = "";
    let lastMultiBoundsKey = "";
    let syncDebounceTimer = null;
    let isRenderingZone = false;

    function st(key, vars) {
        return globalThis.HubI18n?.t(key, vars) ?? key;
    }

    function getShell() {
        return document.getElementById(SHELL_ID);
    }

    function getZone() {
        return document.getElementById(ZONE_ID);
    }

    function isStreamDeckActive() {
        return window.getStreamDeckMode?.() === true;
    }

    function computeGridDimensions(count) {
        if (count <= 1) return { cols: 1, rows: 1 };
        if (count <= 2) return { cols: 2, rows: 1 };
        if (count <= 4) return { cols: 2, rows: 2 };
        if (count <= 6) return { cols: 3, rows: 2 };
        if (count <= 9) return { cols: 3, rows: 3 };
        const cols = Math.ceil(Math.sqrt(count));
        return { cols, rows: Math.ceil(count / cols) };
    }

    function sessionsKey(sessions, streamDeckOn) {
        const duo = (window.getDuoDeviceIds?.() || []).join(",");
        return `${streamDeckOn ? 1 : 0}::${sessionsKeyList(sessions)}::${window.getDisplayLayout?.()}::${window.getFocusedDeviceId?.()}::${duo}`;
    }

    function sessionsKeyList(sessions) {
        return sessions.map((s) => `${s.sessionId}:${s.active ? 1 : 0}:${s.label || ""}`).join("|");
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function getDeviceColor(session) {
        return session?.deviceColor?.hex || "#5B8CFF";
    }

    function buildTileHtml(session, { variant = "grid", isFocused = false, isInputActive = false } = {}) {
        const color = getDeviceColor(session);
        const classes = [
            "stream-deck-tile",
            `stream-deck-tile--${variant}`,
            isFocused ? "is-focused" : "",
            isInputActive ? "is-input-active" : ""
        ].filter(Boolean).join(" ");

        return `
            <div class="${classes}"
                 data-session-id="${escapeHtml(session.sessionId)}"
                 data-session-type="${escapeHtml(session.type || "")}"
                 data-device-color="${escapeHtml(color)}"
                 style="--tile-accent:${escapeHtml(color)}"
                 title="${escapeHtml(session.label || session.sessionId)}">
                <div class="stream-deck-tile-accent"></div>
                <div class="stream-deck-tile-body">
                    <div class="stream-deck-tile-chrome">
                        <span class="stream-deck-tile-pill device-color-pill" style="background:${escapeHtml(color)}"></span>
                        <span class="stream-deck-tile-label">${escapeHtml(session.label || session.sessionId)}</span>
                        <span class="stream-deck-tile-badge">${escapeHtml(session.type || "")}</span>
                    </div>
                    <div class="stream-deck-tile-viewport" data-tile-viewport="${escapeHtml(session.sessionId)}"></div>
                </div>
            </div>
        `;
    }

    function buildDisconnectedTileHtml(sessionId, label, { variant = "duo" } = {}) {
        const classes = [
            "stream-deck-tile",
            "stream-deck-tile--disconnected",
            `stream-deck-tile--${variant}`
        ].join(" ");

        return `
            <div class="${classes}"
                 data-disconnected-id="${escapeHtml(sessionId || "")}"
                 title="${escapeHtml(label || sessionId || st("streamDeck.duo.disconnected"))}">
                <div class="stream-deck-tile-accent stream-deck-tile-accent--muted"></div>
                <div class="stream-deck-tile-body">
                    <div class="stream-deck-tile-chrome">
                        <span class="stream-deck-tile-pill stream-deck-tile-pill--muted"></span>
                        <span class="stream-deck-tile-label">${escapeHtml(label || sessionId || "—")}</span>
                    </div>
                    <div class="stream-deck-tile-empty">
                        <span class="stream-deck-tile-empty-icon">⚠</span>
                        <span data-i18n="streamDeck.duo.disconnected">${st("streamDeck.duo.disconnected")}</span>
                    </div>
                </div>
            </div>
        `;
    }

    function resolveDuoSlots(sessions) {
        const slots = window.getDuoDeviceIds?.() || [null, null];
        const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));

        return [0, 1].map((index) => {
            const sessionId = slots[index] || null;
            if (!sessionId) return { type: "empty", index };
            const session = sessionMap.get(sessionId);
            if (session) return { type: "live", index, session };
            return { type: "disconnected", index, sessionId, label: sessionId };
        });
    }

    function renderZoneLayout(sessions) {
        const zone = getZone();
        if (!zone) return;

        isRenderingZone = true;
        try {
            const layout = window.getDisplayLayout?.() || "grid";
            const focusedId = window.getFocusedDeviceId?.() || null;
            const activeSession = sessions.find((s) => s.active);
            const activeId = activeSession?.sessionId || null;

            zone.className = `stream-deck-zone stream-deck-zone--${layout}`;
            zone.dataset.layout = layout;

            if (!sessions.length) {
                zone.innerHTML = `<div class="stream-deck-empty">${escapeHtml(st("streamDeck.empty"))}</div>`;
                return;
            }

            if (layout === "focus") {
                const focusId = focusedId && sessions.some((s) => s.sessionId === focusedId)
                    ? focusedId
                    : (activeId || sessions[0].sessionId);
                const focusSession = sessions.find((s) => s.sessionId === focusId) || sessions[0];
                const others = sessions.filter((s) => s.sessionId !== focusSession.sessionId);

                zone.innerHTML = `
                    <div class="stream-deck-focus-main">
                        ${buildTileHtml(focusSession, {
                            variant: "focus-main",
                            isFocused: true,
                            isInputActive: focusSession.sessionId === activeId
                        })}
                    </div>
                    <div class="stream-deck-focus-rail">
                        ${others.map((session) => buildTileHtml(session, {
                            variant: "focus-mini",
                            isInputActive: session.sessionId === activeId
                        })).join("")}
                    </div>
                `;
                return;
            }

            if (layout === "duo") {
                const duoSlots = resolveDuoSlots(sessions);
                zone.innerHTML = `
                    <div class="stream-deck-duo-row">
                        ${duoSlots.map((slot) => {
                            if (slot.type === "live") {
                                return buildTileHtml(slot.session, {
                                    variant: "duo",
                                    isInputActive: slot.session.sessionId === activeId
                                });
                            }
                            if (slot.type === "disconnected") {
                                return buildDisconnectedTileHtml(slot.sessionId, slot.label, { variant: "duo" });
                            }
                            return buildDisconnectedTileHtml("", st("streamDeck.duo.emptySlot"), { variant: "duo" });
                        }).join("")}
                    </div>
                `;
                return;
            }

            const { cols, rows } = computeGridDimensions(sessions.length);
            zone.style.setProperty("--stream-deck-cols", String(cols));
            zone.style.setProperty("--stream-deck-rows", String(rows));
            zone.innerHTML = `
                <div class="stream-deck-grid">
                    ${sessions.map((session) => buildTileHtml(session, {
                        variant: "grid",
                        isInputActive: session.sessionId === activeId
                    })).join("")}
                </div>
            `;
        } finally {
            requestAnimationFrame(() => {
                isRenderingZone = false;
            });
        }
    }

    function measureTileBounds() {
        const zone = getZone();
        if (!zone) return {};

        const boundsMap = {};
        zone.querySelectorAll(".stream-deck-tile[data-session-id]").forEach((tile) => {
            const sessionId = tile.dataset.sessionId;
            if (!sessionId) return;

            const viewport = tile.querySelector("[data-tile-viewport]") || tile;
            const rect = viewport.getBoundingClientRect();
            const width = Math.round(rect.width);
            const height = Math.round(rect.height);
            if (width < MIN_TILE_BOUNDS || height < MIN_TILE_BOUNDS) return;

            boundsMap[sessionId] = {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width,
                height
            };
        });

        return boundsMap;
    }

    async function syncSingleSessionBounds() {
        if (typeof window.syncVideoWithSidebarModals === "function") {
            await window.syncVideoWithSidebarModals();
        }
    }

    async function syncMultiSessionBounds(boundsMap) {
        if (!window.sessionAPI?.setLayoutMode || !window.sessionAPI?.setLayoutBounds) return;

        const boundsKey = typeof window.serializeBoundsMap === "function"
            ? window.serializeBoundsMap(boundsMap)
            : JSON.stringify(boundsMap);
        if (boundsKey === lastMultiBoundsKey) return;
        lastMultiBoundsKey = boundsKey;

        if (typeof window.invalidateVideoLayoutBoundsCache === "function") {
            window.invalidateVideoLayoutBoundsCache();
        }

        await window.sessionAPI.setLayoutMode("multi");
        await window.sessionAPI.setLayoutBounds(boundsMap);
    }

    async function performLayoutSync() {
        const streamDeckOn = isStreamDeckActive();
        const shell = getShell();
        const content = document.querySelector(".content");

        if (!streamDeckOn) {
            if (shell) shell.classList.add("hidden");
            if (content) content.classList.remove("content--stream-deck");
            lastMultiBoundsKey = "";
            lastSessionsKey = "";
            if (typeof window.invalidateVideoLayoutBoundsCache === "function") {
                window.invalidateVideoLayoutBoundsCache();
            }
            await syncSingleSessionBounds();
            return;
        }

        if (!window.sessionAPI?.list) return;

        const sessions = await window.sessionAPI.list();
        const layout = window.getDisplayLayout?.() || "grid";

        if (layout === "duo" && typeof window.normalizeDuoSlotsForSessions === "function") {
            const duoChanged = window.normalizeDuoSlotsForSessions(sessions, {
                autoFill: true,
                persist: false,
                notify: false
            });
            if (duoChanged) {
                lastSessionsKey = "";
                lastMultiBoundsKey = "";
            }
        }

        window.syncDisplayLayoutSessions?.(sessions);

        const hasSessions = sessions.length > 0;

        if (shell) {
            shell.classList.toggle("hidden", !streamDeckOn);
        }

        if (!hasSessions) {
            if (content) {
                content.classList.toggle("content--stream-deck", streamDeckOn);
            }
            if (streamDeckOn) {
                const zone = getZone();
                if (zone) {
                    zone.innerHTML = `<div class="stream-deck-empty">${escapeHtml(st("streamDeck.empty"))}</div>`;
                }
            } else if (content) {
                content.classList.remove("content--stream-deck");
            }
            lastMultiBoundsKey = "";
            await syncSingleSessionBounds();
            return;
        }

        if (content) {
            content.classList.add("content--stream-deck");
            content.classList.add("content--session-view");
        }

        document.querySelectorAll(".page").forEach((page) => page.classList.add("hidden"));

        const nextKey = sessionsKey(sessions, streamDeckOn);
        if (nextKey !== lastSessionsKey) {
            renderZoneLayout(sessions);
            lastSessionsKey = nextKey;
            lastMultiBoundsKey = "";
        }

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let boundsMap = measureTileBounds();
        let entries = Object.keys(boundsMap);

        if (!entries.length && layout === "duo") {
            if (typeof window.normalizeDuoSlotsForSessions === "function") {
                window.normalizeDuoSlotsForSessions(sessions, {
                    autoFill: true,
                    persist: false,
                    notify: false
                });
            }
            renderZoneLayout(sessions);
            lastSessionsKey = sessionsKey(sessions, streamDeckOn);
            lastMultiBoundsKey = "";
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            boundsMap = measureTileBounds();
            entries = Object.keys(boundsMap);
        }

        await syncMultiSessionBounds(boundsMap);
    }

    function flushLayoutSync() {
        syncQueue = syncQueue
            .then(() => performLayoutSync())
            .catch((err) => console.error("[StreamDeckZone] sync error:", err));
        return syncQueue;
    }

    function scheduleLayoutSync() {
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
        }

        syncDebounceTimer = setTimeout(() => {
            syncDebounceTimer = null;
            flushLayoutSync();
        }, SYNC_DEBOUNCE_MS);

        return syncQueue;
    }

    async function activateTileSession(sessionId) {
        if (!sessionId || !window.sessionAPI?.switchTo) return;

        const layout = window.getDisplayLayout?.() || "grid";

        if (layout === "focus") {
            window.setFocusedDeviceId?.(sessionId, { persist: true, notify: true });
        }

        if (sessionId.startsWith("instance-") && typeof activateInstance === "function") {
            await window.sessionAPI.switchTo(sessionId);
            await activateInstance(sessionId);
        } else if (typeof activateNewInstanceSession === "function") {
            await window.sessionAPI.switchTo(sessionId);
            activateNewInstanceSession(sessionId);
        } else {
            await window.sessionAPI.switchTo(sessionId);
        }

        document.querySelectorAll(".stream-deck-tile[data-session-id]").forEach((tile) => {
            tile.classList.toggle("is-input-active", tile.dataset.sessionId === sessionId);
        });

        if (typeof updateScreenToggle === "function") updateScreenToggle();
        if (typeof updateOrientationToggle === "function") updateOrientationToggle();
        scheduleLayoutSync();
    }

    function bindZoneClicks() {
        const zone = getZone();
        if (!zone || zone.dataset.clicksBound === "1") return;
        zone.dataset.clicksBound = "1";

        zone.addEventListener("click", (event) => {
            const tile = event.target.closest(".stream-deck-tile[data-session-id]");
            if (!tile) return;
            const sessionId = tile.dataset.sessionId;
            if (!sessionId) return;

            const layout = window.getDisplayLayout?.() || "grid";
            if (layout === "focus" && tile.classList.contains("stream-deck-tile--focus-mini")) {
                window.setFocusedDeviceId?.(sessionId);
            }

            void activateTileSession(sessionId);
        });
    }

    function bindResizeObserver() {
        const zone = getZone();
        if (!zone || typeof ResizeObserver === "undefined") return;
        if (resizeObserver) resizeObserver.disconnect();

        resizeObserver = new ResizeObserver(() => {
            if (!isStreamDeckActive() || isRenderingZone) return;
            scheduleLayoutSync();
        });
        resizeObserver.observe(zone);
    }

    function init() {
        bindZoneClicks();
        bindResizeObserver();

        window.onDisplayLayoutChange?.(() => {
            lastSessionsKey = "";
            lastMultiBoundsKey = "";
            scheduleLayoutSync();
        });

        if (window.sessionAPI?.onSessionListChanged) {
            window.sessionAPI.onSessionListChanged(() => {
                if (!isStreamDeckActive()) {
                    const shell = getShell();
                    if (shell) shell.classList.add("hidden");
                    return;
                }
                lastSessionsKey = "";
                lastMultiBoundsKey = "";
                scheduleLayoutSync();
            });
        }

        if (window.sessionAPI?.onSessionActivated) {
            window.sessionAPI.onSessionActivated((data) => {
                if (!isStreamDeckActive() || !data?.sessionId) return;

                if (window.getDisplayLayout?.() === "focus") {
                    window.setFocusedDeviceId?.(data.sessionId, { persist: false, notify: true });
                }

                document.querySelectorAll(".stream-deck-tile[data-session-id]").forEach((tile) => {
                    tile.classList.toggle("is-input-active", tile.dataset.sessionId === data.sessionId);
                });
                scheduleLayoutSync();
            });
        }

        scheduleLayoutSync();
    }

    window.syncStreamDeckLayout = scheduleLayoutSync;
    window.refreshStreamDeckZone = () => {
        lastSessionsKey = "";
        lastMultiBoundsKey = "";
        scheduleLayoutSync();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
