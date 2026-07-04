function getSessionTabsContainer() {
    return document.getElementById("tabs-bar");
}

function isTypingTarget(element) {
    if (!element) return false;
    const tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return element.isContentEditable;
}

function createSessionTabElement({ sessionId, type, active, label, hasCustomName, deviceColor }) {
    const tab = document.createElement("div");
    tab.className = `scrcpy-tab ${active ? "active" : ""}`;
    tab.dataset.tabId = sessionId;
    tab.dataset.sessionType = type;
    const displayLabel = label || sessionId;
    const colorStyle = deviceColor?.hex ? ` style="background:${deviceColor.hex}"` : "";
    tab.innerHTML = `
        <span class="tab-icon device-color-pill"${colorStyle}></span>
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

function setActiveSessionTab(sessionId) {
    const tabsBar = getSessionTabsContainer();
    if (!tabsBar) return;

    tabsBar.querySelectorAll(".scrcpy-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.tabId === sessionId);
    });
}

function upsertSessionTab({ sessionId, type, active, label, hasCustomName, deviceColor }, { updateOnly = false } = {}) {
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
        if (deviceColor?.hex) {
            const pill = existing.querySelector(".tab-icon.device-color-pill");
            if (pill) pill.style.background = deviceColor.hex;
        }
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
        deviceColor
    });
    tabsBar.appendChild(tab);
    return tab;
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
    });

    if (typeof updateScreenToggle === "function") updateScreenToggle();
    if (typeof updateOrientationToggle === "function") updateOrientationToggle();
    if (typeof window.refreshFpsSnapshot === "function") window.refreshFpsSnapshot();

    const content = document.querySelector(".content");
    if (content) {
        content.classList.toggle("content--session-view", sessions.length > 0);
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
        renderSidebar().catch(console.error);
    });
}
