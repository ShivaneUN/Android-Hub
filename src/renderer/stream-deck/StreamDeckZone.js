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
                    <div class="stream-deck-tile-chrome" title="${escapeHtml(st("streamDeck.dragToReorder"))}">
                        <span class="stream-deck-tile-grip" aria-hidden="true"></span>
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
        const zone = getZone();
        if (zone?.classList.contains("is-reordering")) return syncQueue;

        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
        }

        syncDebounceTimer = setTimeout(() => {
            syncDebounceTimer = null;
            if (getZone()?.classList.contains("is-reordering")) return;
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
        if (typeof updateDeviceSpeakerToggle === "function") updateDeviceSpeakerToggle();
        if (typeof updateOrientationToggle === "function") updateOrientationToggle();
        scheduleLayoutSync();
    }

    function bindZoneClicks() {
        const zone = getZone();
        if (!zone || zone.dataset.clicksBound === "1") return;
        zone.dataset.clicksBound = "1";

        zone.addEventListener("click", (event) => {
            if (ignoreNextTileActivate) {
                ignoreNextTileActivate = false;
                return;
            }
            if (draggingTile) return;

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

    let draggingTile = null;
    let dragTargetTile = null;
    let dragContainer = null;
    let dragLayout = null;
    let ignoreNextTileActivate = false;
    let viewsHiddenForDrag = false;
    let dragPointerId = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragActivated = false;
    let dragSourceId = null;
    const DRAG_THRESHOLD_PX = 4;

    function getDragContainer(layout) {
        const zone = getZone();
        if (!zone) return null;
        if (layout === "grid") return zone.querySelector(".stream-deck-grid");
        if (layout === "focus") return zone.querySelector(".stream-deck-focus-rail");
        if (layout === "duo") return zone.querySelector(".stream-deck-duo-row");
        return null;
    }

    function isTileDragHandle(target) {
        return Boolean(
            target?.closest?.(".stream-deck-tile-chrome")
            || target?.closest?.(".stream-deck-tile-accent")
            || target?.closest?.(".stream-deck-tile-grip")
        );
    }

    let hideViewsPromise = null;

    async function hideViewsForDrag() {
        if (viewsHiddenForDrag) return;
        if (hideViewsPromise) return hideViewsPromise;

        hideViewsPromise = (async () => {
            lastMultiBoundsKey = "";
            try {
                if (window.sessionAPI?.suppressView) {
                    await window.sessionAPI.suppressView();
                }
                if (window.sessionAPI?.setLayoutBounds) {
                    await window.sessionAPI.setLayoutBounds({});
                }
                viewsHiddenForDrag = true;
            } catch (_err) {
                viewsHiddenForDrag = true;
            } finally {
                hideViewsPromise = null;
            }
        })();

        return hideViewsPromise;
    }

    async function restoreViewsAfterDrag() {
        try {
            if (hideViewsPromise) await hideViewsPromise;
            if (window.sessionAPI?.restoreView) {
                await window.sessionAPI.restoreView();
            }
        } catch (_err) {
            // noop
        }
        viewsHiddenForDrag = false;
        hideViewsPromise = null;
    }

    function collectContainerSessionIds(container) {
        if (!container) return [];
        return Array.from(container.querySelectorAll(".stream-deck-tile[data-session-id]"))
            .map((tile) => tile.dataset.sessionId)
            .filter(Boolean);
    }

    function findTileAtPoint(container, clientX, clientY, excludeTile = null) {
        if (!container) return null;
        const tiles = container.querySelectorAll(".stream-deck-tile[data-session-id]");
        for (const tile of tiles) {
            if (tile === excludeTile) continue;
            const rect = tile.getBoundingClientRect();
            if (
                clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom
            ) {
                return tile;
            }
        }
        return null;
    }

    function setDropTarget(tile) {
        if (dragTargetTile === tile) return;
        if (dragTargetTile) dragTargetTile.classList.remove("is-drop-target");
        dragTargetTile = tile || null;
        if (dragTargetTile) dragTargetTile.classList.add("is-drop-target");
    }

    function swapIds(orderedIds, fromId, toId) {
        const next = orderedIds.slice();
        const fromIndex = next.indexOf(fromId);
        const toIndex = next.indexOf(toId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
        const tmp = next[fromIndex];
        next[fromIndex] = next[toIndex];
        next[toIndex] = tmp;
        return next;
    }

    async function commitTileSwap(layout, fromId, toId) {
        if (!fromId || !toId || fromId === toId) {
            lastSessionsKey = "";
            lastMultiBoundsKey = "";
            scheduleLayoutSync();
            return;
        }

        if (layout === "duo") {
            const ids = collectContainerSessionIds(dragContainer);
            const swapped = swapIds(ids, fromId, toId);
            if (swapped?.length >= 2 && typeof window.setDuoDeviceIds === "function") {
                window.setDuoDeviceIds([swapped[0], swapped[1]], { persist: true, notify: true });
            }
            lastSessionsKey = "";
            lastMultiBoundsKey = "";
            scheduleLayoutSync();
            return;
        }

        if (!window.sessionAPI?.reorder || !window.sessionAPI?.list) {
            lastSessionsKey = "";
            lastMultiBoundsKey = "";
            scheduleLayoutSync();
            return;
        }

        let orderedIds = null;
        if (layout === "grid") {
            const sessions = await window.sessionAPI.list();
            orderedIds = swapIds(
                sessions.map((session) => session.sessionId),
                fromId,
                toId
            );
        } else if (layout === "focus") {
            const sessions = await window.sessionAPI.list();
            const focusedId = window.getFocusedDeviceId?.()
                || sessions.find((s) => s.active)?.sessionId
                || sessions[0]?.sessionId
                || null;
            const railIds = collectContainerSessionIds(dragContainer);
            const swappedRail = swapIds(railIds, fromId, toId) || railIds;
            let railIndex = 0;
            orderedIds = sessions.map((session) => {
                if (session.sessionId === focusedId) return focusedId;
                return swappedRail[railIndex++] || session.sessionId;
            }).filter(Boolean);
        }

        if (!orderedIds?.length) {
            lastSessionsKey = "";
            lastMultiBoundsKey = "";
            scheduleLayoutSync();
            return;
        }

        try {
            await window.sessionAPI.reorder(orderedIds);
        } catch (err) {
            console.error("[StreamDeckZone] swap tiles:", err);
        }
        lastSessionsKey = "";
        lastMultiBoundsKey = "";
        scheduleLayoutSync();
    }

    function bindTileDragReorder() {
        const zone = getZone();
        if (!zone || zone.dataset.tileDragBound === "1") return;
        zone.dataset.tileDragBound = "1";

        const onPointerMove = (event) => {
            if (dragPointerId == null || event.pointerId !== dragPointerId || !draggingTile) return;
            if (!viewsHiddenForDrag) return;

            const dx = event.clientX - dragStartX;
            const dy = event.clientY - dragStartY;
            if (!dragActivated) {
                if ((dx * dx) + (dy * dy) < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
                dragActivated = true;
                ignoreNextTileActivate = true;
                draggingTile.classList.add("is-dragging");
                zone.classList.add("is-reordering");
            }

            event.preventDefault();
            const over = findTileAtPoint(dragContainer, event.clientX, event.clientY, draggingTile);
            setDropTarget(over);
        };

        const onPointerUp = async (event) => {
            if (dragPointerId == null || event.pointerId !== dragPointerId) return;

            document.removeEventListener("pointermove", onPointerMove, true);
            document.removeEventListener("pointerup", onPointerUp, true);
            document.removeEventListener("pointercancel", onPointerUp, true);

            // Attendre que les BrowserViews soient bien masqués avant le hit-test final.
            await hideViewsForDrag();

            const layout = dragLayout || (window.getDisplayLayout?.() || "grid");
            const fromId = dragSourceId;
            const target = dragTargetTile || findTileAtPoint(
                dragContainer,
                event.clientX,
                event.clientY,
                draggingTile
            );
            const toId = target?.dataset?.sessionId || null;
            const shouldSwap = Boolean(fromId && toId && fromId !== toId);

            if (draggingTile) draggingTile.classList.remove("is-dragging");
            setDropTarget(null);
            zone.classList.remove("is-reordering");
            draggingTile = null;
            dragPointerId = null;
            dragActivated = false;
            dragSourceId = null;

            if (!shouldSwap) {
                dragContainer = null;
                dragLayout = null;
                await restoreViewsAfterDrag();
                lastSessionsKey = "";
                lastMultiBoundsKey = "";
                scheduleLayoutSync();
                return;
            }

            ignoreNextTileActivate = true;
            try {
                await commitTileSwap(layout, fromId, toId);
                await restoreViewsAfterDrag();
                lastSessionsKey = "";
                lastMultiBoundsKey = "";
                scheduleLayoutSync();
            } finally {
                dragContainer = null;
                dragLayout = null;
                window.setTimeout(() => {
                    ignoreNextTileActivate = false;
                }, 80);
            }
        };

        zone.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            if (draggingTile) return;
            if (!isTileDragHandle(event.target)) return;

            const tile = event.target.closest(".stream-deck-tile[data-session-id]");
            if (!tile || !zone.contains(tile)) return;

            const layout = window.getDisplayLayout?.() || "grid";
            if (layout === "focus" && tile.classList.contains("stream-deck-tile--focus-main")) return;
            if (layout !== "grid" && layout !== "focus" && layout !== "duo") return;

            const container = getDragContainer(layout);
            if (!container || container.querySelectorAll(".stream-deck-tile[data-session-id]").length < 2) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            draggingTile = tile;
            dragTargetTile = null;
            dragContainer = container;
            dragLayout = layout;
            dragSourceId = tile.dataset.sessionId || null;
            dragPointerId = event.pointerId;
            dragStartX = event.clientX;
            dragStartY = event.clientY;
            dragActivated = false;
            ignoreNextTileActivate = true;

            zone.classList.add("is-reordering");
            tile.classList.add("is-dragging");

            document.addEventListener("pointermove", onPointerMove, true);
            document.addEventListener("pointerup", onPointerUp, true);
            document.addEventListener("pointercancel", onPointerUp, true);

            // Masquer synchrone côté UX : dès le clic, les vues disparaissent
            // pour que gauche↔droite / haut↔bas reçoivent bien les events.
            void hideViewsForDrag().then(() => {
                if (dragPointerId == null || !draggingTile) return;
                dragActivated = true;
            });
        });
    }

    function bindResizeObserver() {
        const zone = getZone();
        if (!zone || typeof ResizeObserver === "undefined") return;
        if (resizeObserver) resizeObserver.disconnect();

        resizeObserver = new ResizeObserver(() => {
            if (!isStreamDeckActive() || isRenderingZone) return;
            if (getZone()?.classList.contains("is-reordering")) return;
            scheduleLayoutSync();
        });
        resizeObserver.observe(zone);
    }

    function init() {
        bindZoneClicks();
        bindTileDragReorder();
        bindResizeObserver();

        window.onDisplayLayoutChange?.(() => {
            lastSessionsKey = "";
            lastMultiBoundsKey = "";
            scheduleLayoutSync();
        });

        globalThis.HubI18n?.onChange?.(() => {
            lastSessionsKey = "";
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
