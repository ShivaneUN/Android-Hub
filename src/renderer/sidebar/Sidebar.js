function getSessionTabsContainer() {
    return document.getElementById("tabs-bar");
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

const DEFAULT_TAB_APP_ICON_SVG = `<svg viewBox="0 0 24 24" stroke-width="1.6" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M8 14.5l2.5-2.5 2.1 2.1 2.4-2.4 1.5 1.5"/></svg>`;

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
    if (iconUrl) {
        return `<span class="tab-app-icon"><img src="${escapeHtml(iconUrl)}" alt="" loading="lazy"></span>`;
    }
    return `<span class="tab-app-icon is-placeholder">${DEFAULT_TAB_APP_ICON_SVG}</span>`;
}

function updateTabAppIcon(tab, iconUrl = null) {
    if (!tab) return;
    const iconContainer = tab.querySelector(".tab-app-icon");
    if (!iconContainer) return;
    iconContainer.classList.toggle("is-placeholder", !iconUrl);
    iconContainer.innerHTML = iconUrl
        ? `<img src="${escapeHtml(iconUrl)}" alt="" loading="lazy">`
        : DEFAULT_TAB_APP_ICON_SVG;
}

function hydrateTabsWithIcon(iconKey, iconUrl) {
    const tabsBar = getSessionTabsContainer();
    if (!tabsBar || !iconKey || !iconUrl) return;
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
        await activateSessionTab(sessionId);
    });

    tab.querySelector(".tab-close").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (sessionId.startsWith("instance-") && typeof closeInstance === "function") {
            await closeInstance(sessionId);
        } else if (typeof closeNewInstanceSession === "function") {
            await closeNewInstanceSession(sessionId);
        } else {
            await window.sessionAPI.close(sessionId);
        }
        renderSidebar();
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
    document.querySelectorAll(".page").forEach((page) => page.classList.add("hidden"));
    document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));

    if (typeof restoreSessionView === "function") {
        restoreSessionView();
    }

    await window.sessionAPI.switchTo(sessionId);

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
        return;
    }

    await renderSidebar();
    if (typeof updateScreenToggle === "function") updateScreenToggle();
    if (typeof updateOrientationToggle === "function") updateOrientationToggle();
    scheduleSessionOrientationApply();
    if (typeof reportContentBounds === "function") reportContentBounds();
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
        content.classList.toggle("content--session-view", sessions.length > 0);
        const activeSession = sessions.find((session) => session.active);
        updateSessionFocusChrome(activeSession?.sessionId || null);
        if (typeof reportContentBounds === "function") reportContentBounds();
    }
}

async function finalizeSessionUI(sessionId, options = {}) {
    if (!sessionId || !window.sessionAPI) return;

    document.querySelectorAll(".page").forEach((page) => page.classList.add("hidden"));
    document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));

    if (typeof restoreSessionView === "function") {
        restoreSessionView();
    }

    await window.sessionAPI.switchTo(sessionId);
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

if (window.sessionAPI?.onSessionListChanged) {
    window.sessionAPI.onSessionListChanged(() => {
        renderSidebar().catch(console.error);
    });
}

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
