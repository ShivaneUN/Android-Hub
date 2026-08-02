function getSessionTabsContainer() {
    return document.getElementById("tabs-bar-track") || document.getElementById("tabs-bar");
}

let ignoreNextTabActivate = false;
let draggingSessionTab = null;

function getOrderedSessionTabIds(tabsBar = getSessionTabsContainer()) {
    if (!tabsBar) return [];
    return Array.from(tabsBar.querySelectorAll(".scrcpy-tab"))
        .map((tab) => tab.dataset.tabId)
        .filter(Boolean);
}

function initSessionTabDragReorder() {
    const tabsBar = getSessionTabsContainer();
    if (!tabsBar || tabsBar.dataset.tabDragBound === "1") return;
    tabsBar.dataset.tabDragBound = "1";

    tabsBar.addEventListener("dragstart", (event) => {
        const tab = event.target.closest(".scrcpy-tab");
        if (!tab || !tabsBar.contains(tab)) return;
        if (event.target.closest(".tab-close")) {
            event.preventDefault();
            return;
        }

        draggingSessionTab = tab;
        tab.classList.add("is-dragging");
        ignoreNextTabActivate = false;

        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", tab.dataset.tabId || "");
            try {
                event.dataTransfer.setDragImage(tab, Math.min(40, tab.offsetWidth / 2), tab.offsetHeight / 2);
            } catch (_err) {
                // noop
            }
        }
    });

    tabsBar.addEventListener("dragover", (event) => {
        if (!draggingSessionTab) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";

        const over = event.target.closest(".scrcpy-tab");
        if (!over || over === draggingSessionTab || !tabsBar.contains(over)) return;

        const rect = over.getBoundingClientRect();
        const placeBefore = event.clientX < rect.left + rect.width / 2;
        const reference = placeBefore ? over : over.nextSibling;
        if (reference === draggingSessionTab || draggingSessionTab.nextSibling === reference) return;
        tabsBar.insertBefore(draggingSessionTab, reference);
    });

    tabsBar.addEventListener("drop", (event) => {
        if (!draggingSessionTab) return;
        event.preventDefault();
    });

    tabsBar.addEventListener("dragend", async () => {
        const tab = draggingSessionTab;
        draggingSessionTab = null;
        if (!tab) return;

        tab.classList.remove("is-dragging");
        ignoreNextTabActivate = true;

        const orderedIds = getOrderedSessionTabIds(tabsBar);
        if (!orderedIds.length || !window.sessionAPI?.reorder) {
            ignoreNextTabActivate = false;
            return;
        }

        try {
            const result = await window.sessionAPI.reorder(orderedIds);
            if (!result?.success) {
                await renderSidebar();
            }
        } catch (err) {
            console.error("[Sidebar] reorder tabs:", err);
            await renderSidebar();
        }

        window.setTimeout(() => {
            ignoreNextTabActivate = false;
        }, 50);
    });
}

function isTypingTarget(element) {
    if (!element) return false;
    const tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return element.isContentEditable;
}

function applyTabColorPill(pill, deviceColor) {
    if (!pill) return;
    if (deviceColor?.hex) {
        pill.style.background = deviceColor.hex;
    } else {
        pill.style.removeProperty("background");
    }
}

const DEFAULT_TAB_APP_ICON_SVG = globalThis.HubAppIconPlaceholder?.APP_ICON_PLACEHOLDER_SVG
    || `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="#3d4f6f"/></svg>`;

const sessionIconCache = new Map();
const sessionIconInFlight = new Set();

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function normalizeUserId(userId) {
    return Number.isInteger(userId) ? userId : 0;
}

function buildSessionIconKey(session = {}) {
    const deviceKey = session.stableDeviceId || session.deviceId;
    const packageName = session.packageName || null;
    if (!deviceKey || !packageName) return null;
    return `${deviceKey}::${packageName}::${normalizeUserId(session.userId)}`;
}

function renderTabAppIcon(iconUrl = null) {
    if (window.HubPerformance && !window.HubPerformance.isEnabled("appLogos")) {
        iconUrl = null;
    }
    if (iconUrl) {
        return `<span class="tab-app-icon"><img src="${escapeHtml(iconUrl)}" alt="" loading="lazy"></span>`;
    }
    if (globalThis.HubAppIconPlaceholder?.wrapTabAppIconPlaceholder) {
        return globalThis.HubAppIconPlaceholder.wrapTabAppIconPlaceholder();
    }
    return `<span class="tab-app-icon is-placeholder">${DEFAULT_TAB_APP_ICON_SVG}</span>`;
}

function updateTabAppIcon(tab, iconUrl = null) {
    if (!tab) return;
    if (window.HubPerformance && !window.HubPerformance.isEnabled("appLogos")) {
        iconUrl = null;
    }
    const iconContainer = tab.querySelector(".tab-app-icon");
    if (!iconContainer) return;
    iconContainer.classList.toggle("is-placeholder", !iconUrl);
    iconContainer.innerHTML = iconUrl
        ? `<img src="${escapeHtml(iconUrl)}" alt="" loading="lazy">`
        : (globalThis.HubAppIconPlaceholder?.APP_ICON_PLACEHOLDER_SVG || DEFAULT_TAB_APP_ICON_SVG);
}

function hydrateTabsWithIcon(iconKey, iconUrl) {
    const tabsBar = getSessionTabsContainer();
    if (!tabsBar || !iconKey || !iconUrl) return;
    if (window.HubPerformance && !window.HubPerformance.isEnabled("appLogos")) return;
    tabsBar.querySelectorAll(".scrcpy-tab").forEach((tab) => {
        const tabIconKey = tab.dataset.iconKey;
        if (tabIconKey === iconKey) {
            updateTabAppIcon(tab, iconUrl);
        }
    });
}

async function resolveSessionTabIcon(session = {}) {
    const iconKey = buildSessionIconKey(session);
    if (!iconKey || sessionIconCache.has(iconKey) || sessionIconInFlight.has(iconKey)) return;
    if (!window.electronAPI?.resolveAppMetadata) return;

    sessionIconInFlight.add(iconKey);
    try {
        const payload = {
            deviceId: session.stableDeviceId || session.deviceId,
            packageName: session.packageName,
            userId: Number.isInteger(session.userId) ? session.userId : null,
            appNameHint: session.label || session.packageName
        };
        const result = await window.electronAPI.resolveAppMetadata(payload);
        if (result?.success && result.metadata?.iconUrl) {
            sessionIconCache.set(iconKey, result.metadata.iconUrl);
            hydrateTabsWithIcon(iconKey, result.metadata.iconUrl);
        }
    } catch (_err) {
        // noop
    } finally {
        sessionIconInFlight.delete(iconKey);
    }
}

function createSessionTabElement({ sessionId, type, active, label, hasCustomName, deviceColor, packageName, userId, deviceId, stableDeviceId }) {
    const tab = document.createElement("div");
    tab.className = `scrcpy-tab ${active ? "active" : ""}`;
    tab.draggable = true;
    tab.dataset.tabId = sessionId;
    tab.dataset.sessionType = type;
    const iconKey = buildSessionIconKey({ stableDeviceId, deviceId, packageName, userId });
    const iconUrl = iconKey ? (sessionIconCache.get(iconKey) || null) : null;
    tab.dataset.iconKey = iconKey || "";
    tab.dataset.packageName = packageName || "";
    tab.dataset.deviceKey = stableDeviceId || deviceId || "";
    tab.dataset.userId = String(normalizeUserId(userId));
    const displayLabel = label || sessionId;
    const colorStyle = deviceColor?.hex ? ` style="background:${deviceColor.hex}"` : "";
    tab.innerHTML = `
        <span class="tab-icon device-color-pill"${colorStyle}></span>
        ${renderTabAppIcon(iconUrl)}
        <span class="tab-label">
            <span class="session-type-badge">${type}</span>
            ${displayLabel}
        </span>
        <span class="tab-fps" data-session-id="${sessionId}">— fps</span>
        <span class="tab-close">&#10005;</span>
    `;

    tab.addEventListener("click", async (e) => {
        if (e.target.classList.contains("tab-close")) return;
        if (ignoreNextTabActivate || draggingSessionTab) {
            ignoreNextTabActivate = false;
            return;
        }
        await activateSessionTab(sessionId);
    });

    tab.querySelector(".tab-close").addEventListener("click", async (e) => {
        e.stopPropagation();
        console.warn(`[Sidebar] tab-close click session=${sessionId}`);
        if (sessionId.startsWith("instance-") && typeof closeInstance === "function") {
            await closeInstance(sessionId);
        } else if (typeof closeNewInstanceSession === "function") {
            await closeNewInstanceSession(sessionId, "tab-close");
        } else {
            await window.sessionAPI.close(sessionId);
            if (typeof renderSidebar === "function") renderSidebar();
        }
    });

    const previewHook = window.videoPreviewHook;
    if (previewHook?.attach) {
        previewHook.attach(tab, sessionId);
    }

    if (window.renameActions?.attachSessionContextMenu) {
        window.renameActions.attachSessionContextMenu(tab, sessionId, displayLabel, hasCustomName);
    }

    return tab;
}

function updateSessionFocusChrome(sessionId) {
    const tabsBar = getSessionTabsContainer();
    if (tabsBar) {
        tabsBar.querySelectorAll(".scrcpy-tab").forEach((tab) => {
            tab.classList.toggle("active", Boolean(sessionId) && tab.dataset.tabId === sessionId);
        });
    }

    const content = document.querySelector(".content");
    if (content) {
        content.classList.toggle("content--session-focused", Boolean(sessionId));
    }
}

function setActiveSessionTab(sessionId) {
    updateSessionFocusChrome(sessionId);
}

function upsertSessionTab(session, { updateOnly = false } = {}) {
    const { sessionId, type, active, label, hasCustomName, deviceColor } = session;
    const tabsBar = getSessionTabsContainer();
    if (!tabsBar || !sessionId) return;

    const existing = tabsBar.querySelector(`[data-tab-id="${sessionId}"]`);
    if (existing) {
        if (label) {
            const labelEl = existing.querySelector(".tab-label");
            if (labelEl) {
                labelEl.innerHTML = `
                    <span class="session-type-badge">${type || existing.dataset.sessionType}</span>
                    ${label}
                `;
            }
        }
        if (deviceColor !== undefined) {
            applyTabColorPill(existing.querySelector(".tab-icon.device-color-pill"), deviceColor);
        }
        const iconKey = buildSessionIconKey(session);
        existing.dataset.iconKey = iconKey || "";
        existing.dataset.packageName = session.packageName || "";
        existing.dataset.deviceKey = session.stableDeviceId || session.deviceId || "";
        existing.dataset.userId = String(normalizeUserId(session.userId));
        updateTabAppIcon(existing, iconKey ? (sessionIconCache.get(iconKey) || null) : null);
        resolveSessionTabIcon(session).catch(() => {});
        if (active) {
            setActiveSessionTab(sessionId);
        }
        return existing;
    }

    if (updateOnly) return null;

    if (active) {
        tabsBar.querySelectorAll(".scrcpy-tab").forEach((tab) => tab.classList.remove("active"));
    }

    const tab = createSessionTabElement({
        sessionId,
        type,
        active: Boolean(active),
        label,
        hasCustomName,
        deviceColor,
        packageName: session.packageName,
        userId: session.userId,
        deviceId: session.deviceId,
        stableDeviceId: session.stableDeviceId
    });
    tabsBar.appendChild(tab);
    resolveSessionTabIcon(session).catch(() => {});
    return tab;
}

async function refreshSessionTabColors() {
    if (!window.sessionAPI?.list) return;

    const sessions = await window.sessionAPI.list();
    const tabsBar = getSessionTabsContainer();
    if (!tabsBar) return;

    for (const session of sessions) {
        const tab = tabsBar.querySelector(`[data-tab-id="${session.sessionId}"]`);
        if (!tab) continue;
        applyTabColorPill(tab.querySelector(".tab-icon.device-color-pill"), session.deviceColor);
    }
}

async function refreshSessionTabMetadata(sessionId) {
    if (!window.sessionAPI?.list || !sessionId) return;

    const sessions = await window.sessionAPI.list();
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) return;

    upsertSessionTab({ ...session, active: true }, { updateOnly: true });
}

function scheduleSessionOrientationApply() {
    if (!window.sessionAPI?.getActiveOrientation || typeof window.applySessionPortraitLayout !== "function") {
        return;
    }

    void (async () => {
        try {
            const orient = await window.sessionAPI.getActiveOrientation();
            if (orient?.success) {
                await window.applySessionPortraitLayout(orient.orientation === "portrait");
            }
        } catch (_err) {
            // noop
        }
    })();
}

async function activateSessionTab(sessionId) {
    window.__hubShowingHome = false;
    window.dispatchEvent(new CustomEvent("hub-home-visibility", { detail: { home: false } }));
    document.querySelectorAll(".page").forEach((page) => page.classList.add("hidden"));
    document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));

    if (typeof restoreSessionView === "function") {
        restoreSessionView();
    }

    const switched = window.sessionAPI?.switchTo
        ? await window.sessionAPI.switchTo(sessionId)
        : false;

    // switchTo a échoué (session fantôme / déjà fermée) → ne pas rester sur un écran vide.
    if (!switched) {
        console.warn(`[Sidebar] activateSessionTab échoué — session introuvable ${sessionId}`);
        if (typeof window.goToLaunchHome === "function") {
            await window.goToLaunchHome();
        } else {
            window.__hubShowingHome = true;
            document.getElementById("page-new")?.classList.remove("hidden");
            document.querySelector(".content")?.classList.remove(
                "content--session-view",
                "content--session-focused"
            );
            if (window.sessionAPI?.suppressView) {
                await window.sessionAPI.suppressView();
            }
        }
        return false;
    }

    if (sessionId.startsWith("instance-") && typeof activateInstance === "function") {
        await activateInstance(sessionId);
    } else if (typeof activateNewInstanceSession === "function") {
        activateNewInstanceSession(sessionId);
    }

    const tabsBar = getSessionTabsContainer();
    const tabExists = Boolean(tabsBar?.querySelector(`[data-tab-id="${sessionId}"]`));
    if (tabExists) {
        setActiveSessionTab(sessionId);
        if (typeof updateScreenToggle === "function") updateScreenToggle();
        if (typeof updateOrientationToggle === "function") updateOrientationToggle();
        if (typeof reportContentBounds === "function") reportContentBounds();
        scheduleSessionOrientationApply();
        return true;
    }

    await renderSidebar();
    if (typeof updateScreenToggle === "function") updateScreenToggle();
    if (typeof updateOrientationToggle === "function") updateOrientationToggle();
    scheduleSessionOrientationApply();
    if (typeof reportContentBounds === "function") reportContentBounds();
    return true;
}

async function cycleSessionTab(direction) {
    if (!window.sessionAPI?.cycleTab) return;
    await window.sessionAPI.cycleTab(direction);
}

function initSessionTabShortcuts() {
    document.addEventListener("keydown", (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        if (event.key !== "Tab") return;
        if (isTypingTarget(document.activeElement)) return;

        event.preventDefault();
        cycleSessionTab(event.shiftKey ? "prev" : "next").catch(console.error);
    });

    if (window.sessionAPI?.onSessionActivated) {
        window.sessionAPI.onSessionActivated(async (data) => {
            if (!data?.sessionId) return;
            const sessions = await window.sessionAPI.list();
            const target = sessions.find((s) => s.sessionId === data.sessionId);
            if (target?.active) {
                setActiveSessionTab(data.sessionId);
                if (typeof reportContentBounds === "function") reportContentBounds();
                return;
            }
            activateSessionTab(data.sessionId).catch(console.error);
        });
    }
}

async function renderSidebar() {
    if (!window.sessionAPI) return;

    const sessions = await window.sessionAPI.list();
    const tabsBar = getSessionTabsContainer();
    if (!tabsBar) return;

    if (typeof window.videoPreviewHook?.hide === "function") {
        window.videoPreviewHook.hide();
    }

    tabsBar.innerHTML = "";

    sessions.forEach((session) => {
        tabsBar.appendChild(createSessionTabElement(session));
        resolveSessionTabIcon(session).catch(() => {});
    });

    if (typeof updateScreenToggle === "function") updateScreenToggle();
    if (typeof updateOrientationToggle === "function") updateOrientationToggle();
    if (typeof window.refreshFpsSnapshot === "function") window.refreshFpsSnapshot();

    const content = document.querySelector(".content");
    if (content) {
        const showSessionView = sessions.length > 0 && !window.__hubShowingHome;
        content.classList.toggle("content--session-view", showSessionView);
        const activeSession = sessions.find((session) => session.active);
        updateSessionFocusChrome(showSessionView ? (activeSession?.sessionId || null) : null);
        if (window.__hubShowingHome && window.sessionAPI?.suppressView) {
            void window.sessionAPI.suppressView();
        } else if (typeof reportContentBounds === "function") {
            reportContentBounds();
        }
    }
}

async function finalizeSessionUI(sessionId, options = {}) {
    if (!sessionId || !window.sessionAPI) return;

    // Ne jamais recréer un onglet DOM si la BrowserView a déjà été fermée
    // (finalize retardé après close → onglet fantôme noir / — fps).
    try {
        const listed = await window.sessionAPI.list();
        if (!Array.isArray(listed) || !listed.some((session) => session?.sessionId === sessionId)) {
            console.warn(`[Sidebar] finalizeSessionUI ignoré — session absente ${sessionId}`);
            return;
        }
    } catch (_err) {
        return;
    }

    window.__hubShowingHome = false;
    window.dispatchEvent(new CustomEvent("hub-home-visibility", { detail: { home: false } }));
    document.querySelectorAll(".page").forEach((page) => page.classList.add("hidden"));
    document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));

    if (typeof restoreSessionView === "function") {
        restoreSessionView();
    }

    const switched = await window.sessionAPI.switchTo(sessionId);
    if (!switched) {
        console.warn(`[Sidebar] finalizeSessionUI annulé — switchTo échoué ${sessionId}`);
        return;
    }

    window.__sessionAudioHub?.setActiveSession?.(sessionId);

    if (sessionId.startsWith("instance-") && typeof activateInstance === "function") {
        await activateInstance(sessionId);
    } else if (typeof activateNewInstanceSession === "function") {
        activateNewInstanceSession(sessionId);
    }

    const type = options.type || (sessionId.startsWith("instance-") ? "A" : "B");
    upsertSessionTab({
        sessionId,
        type,
        active: true,
        label: options.label || sessionId,
        hasCustomName: options.hasCustomName,
        deviceColor: options.deviceColor
    });

    const content = document.querySelector(".content");
    if (content) {
        content.classList.add("content--session-view");
    }

    if (typeof updateScreenToggle === "function") updateScreenToggle();
    if (typeof updateOrientationToggle === "function") updateOrientationToggle();
    if (typeof window.refreshFpsSnapshot === "function") window.refreshFpsSnapshot();
    if (typeof reportContentBounds === "function") reportContentBounds();

    refreshSessionTabMetadata(sessionId).catch(() => {});
    scheduleSessionOrientationApply();
}

async function onSessionLaunched(sessionId, type, options = {}) {
    await finalizeSessionUI(sessionId, options);
}

window.renderSidebar = renderSidebar;
window.refreshSessionTabColors = refreshSessionTabColors;
window.finalizeSessionUI = finalizeSessionUI;
window.onSessionLaunched = onSessionLaunched;
window.activateSessionTab = activateSessionTab;

initSessionTabShortcuts();
initSessionTabDragReorder();

if (window.sessionAPI?.onSessionListChanged) {
    window.sessionAPI.onSessionListChanged(() => {
        renderSidebar().catch(console.error);
    });
}

window.addEventListener("performance-prefs-changed", () => {
    renderSidebar().catch(console.error);
});

if (window.sessionAPI?.list) {
    renderSidebar().catch(console.error);
}

if (window.deviceColorsAPI?.onUpdated) {
    window.deviceColorsAPI.onUpdated(() => {
        refreshSessionTabColors().catch(console.error);
    });
}

if (window.electronAPI?.onAppMetadataUpdated) {
    window.electronAPI.onAppMetadataUpdated(({ serial, updates } = {}) => {
        if (!Array.isArray(updates) || updates.length === 0) return;
        for (const update of updates) {
            const deviceKey = update.deviceId || serial;
            const packageName = update.packageName || update.package;
            if (!deviceKey || !packageName || !update.iconUrl) continue;
            const iconKey = `${deviceKey}::${packageName}::${normalizeUserId(update.userId)}`;
            sessionIconCache.set(iconKey, update.iconUrl);
            hydrateTabsWithIcon(iconKey, update.iconUrl);
        }
    });
}
