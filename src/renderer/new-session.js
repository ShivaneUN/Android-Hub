/**
 * new-session.js
 *
 * UI Type B (Nouvelle instance) uniquement:
 * - Selection appareil
 * - Selection application
 * - Apercu commande
 * - Lancement pipeline dedie (session/tab/canvas/input independants)
 */

const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

let selectedDevice = null;
let selectedApp = null;
let launcherApps = [];
let launchPipeline = null;
let historyEntries = [];
let connectedDevicesCache = [];

const DEFAULT_APP_ICON_SVG = globalThis.HubAppIconPlaceholder?.APP_ICON_PLACEHOLDER_SVG
    || `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="#3d4f6f"/></svg>`;
const DELETE_ICON_SVG = `<svg viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

const newInstanceSessions = new Map();
let activeNewInstanceSessionId = null;
let historyAppList = null;
let launcherIconPrefetchObserver = null;
const prefetchedAppKeys = new Set();
const VISIBLE_PREFETCH_COUNT = 10;
const SCROLL_PREFETCH_ROOT_MARGIN = "120px 0px";

function isHubModalChildWindow() {
    return /hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"));
}

function dismissHubModalPanel() {
    if (isHubModalChildWindow()) {
        window.hubModalWindowAPI?.close?.();
        return;
    }
    if (typeof closeHubModal === "function") {
        void closeHubModal();
    }
}

async function resolveDefaultLaunchStreamParams() {
    try {
        if (window.displayPresetsAPI?.getDefault) {
            const result = await window.displayPresetsAPI.getDefault();
            if (result?.success && result.params) {
                return result.params;
            }
        }
        if (window.displayPresetsAPI?.resolveParams) {
            const result = await window.displayPresetsAPI.resolveParams();
            if (result?.success && result.params) {
                return result.params;
            }
        }
    } catch (err) {
        console.warn("[NewSession] displayPresetsAPI indisponible:", err.message);
    }

    if (typeof StreamParams !== "undefined" && StreamParams.DEFAULT_STREAM_PARAMS) {
        return StreamParams.cloneParams
            ? StreamParams.cloneParams(StreamParams.DEFAULT_STREAM_PARAMS)
            : { ...StreamParams.DEFAULT_STREAM_PARAMS };
    }

    return {
        width: 1920,
        height: 1080,
        dpi: 240,
        maxFps: 60,
        bitRateMbps: 8,
        iFrameInterval: 1
    };
}

async function buildDefaultScrcpyOptions(sessionType) {
    const params = await resolveDefaultLaunchStreamParams();
    if (typeof StreamParams !== "undefined" && StreamParams.toScrcpyOptions) {
        return StreamParams.toScrcpyOptions(params, sessionType);
    }
    return {};
}

async function invokeMainAction(action, args = []) {
    const response = await window.hubModalWindowAPI.invokeMain(action, args);
    if (!response?.success) {
        throw new Error(response?.error || t("newSession.actionFailed"));
    }
    return response.result;
}

function getAppLabel(app = {}) {
    if (window.AppDisplay?.getAppLabel) {
        return window.AppDisplay.getAppLabel(app);
    }
    return app.labelName || app.displayName || app.package || "";
}

function getAppVariantClass(app = {}) {
    if (app.variantType === "clone") return "app-variant-clone";
    if (app.variantType === "duplicate") return "app-variant-duplicate";
    return "";
}

function buildAppKey(app = {}) {
    if (app.appKey) return String(app.appKey);
    const pkg = String(app.package || app.packageName || "");
    const userId = app.userId === undefined || app.userId === null ? "0" : String(app.userId);
    return `${pkg}@@${userId}`;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function getNewInstanceElements() {
    return {
        deviceList: document.getElementById("new-instance-device-list"),
        historyList: document.getElementById("new-instance-history-list"),
        historySearchInput: document.getElementById("new-instance-history-search-input"),
        appLauncherHint: document.getElementById("new-instance-app-launcher-hint"),
        appSearchInput: document.getElementById("new-instance-app-search-input"),
        appResults: document.getElementById("new-instance-app-results"),
        launchBtn: document.getElementById("new-instance-launch-btn"),
        launchHint: document.getElementById("new-instance-launch-hint"),
        status: document.getElementById("new-instance-status"),
        commandPreview: document.getElementById("new-instance-command-preview")
    };
}

function formatHistoryDate(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (isToday) return t("newSession.today", { time });
    if (isYesterday) return t("newSession.yesterday", { time });
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function resolveDeviceName(historyDeviceId, devices = connectedDevicesCache) {
    const device = findDeviceForHistory(devices, historyDeviceId);
    return device?.name || historyDeviceId;
}

function findDeviceForHistory(devices, historyDeviceId) {
    if (!historyDeviceId) return null;
    const id = String(historyDeviceId).trim();
    return (Array.isArray(devices) ? devices : []).find((device) =>
        device?.connected !== false && (
            device.deviceId === id
            || device.serial === id
            || device.usbSerial === id
            || device.wifiSerial === id
        )
    ) || null;
}

function mapLauncherAppToSelection(app) {
    const label = getAppLabel(app);
    return {
        package: app.package,
        displayName: app.displayName || label,
        labelName: label,
        appName: label,
        variantType: app.variantType,
        userId: app.userId === undefined || app.userId === null ? null : Number(app.userId),
        appKey: buildAppKey(app),
        iconPath: app.iconPath || null,
        iconUrl: app.iconUrl || null
    };
}

function renderLauncherAppIcon(app) {
    const iconSrc = app.iconUrl || app.iconPath;
    if (iconSrc) {
        return `<span class="new-instance-app-icon"><img src="${escapeHtml(iconSrc)}" alt="" loading="lazy"></span>`;
    }
    if (globalThis.HubAppIconPlaceholder?.wrapNewInstanceAppIconPlaceholder) {
        return globalThis.HubAppIconPlaceholder.wrapNewInstanceAppIconPlaceholder();
    }
    return `<span class="new-instance-app-icon is-placeholder">${DEFAULT_APP_ICON_SVG}</span>`;
}

function updateLauncherHint(message) {
    const { appLauncherHint } = getNewInstanceElements();
    if (appLauncherHint) appLauncherHint.textContent = message;
}

function resetLauncherApps() {
    launcherApps = [];
    resetMetadataPrefetchState();
    const { appSearchInput, appResults } = getNewInstanceElements();
    if (appSearchInput) appSearchInput.value = "";
    updateLauncherHint(t("newSession.selectDeviceHint"));
    if (appResults) {
        appResults.innerHTML = `<p class="apps-loading">${t("newSession.noDeviceSelected")}</p>`;
    }
}

function resetMetadataPrefetchState() {
    disconnectLauncherIconPrefetchObserver();
    prefetchedAppKeys.clear();
}

function disconnectLauncherIconPrefetchObserver() {
    if (launcherIconPrefetchObserver) {
        launcherIconPrefetchObserver.disconnect();
        launcherIconPrefetchObserver = null;
    }
}

function buildPrefetchAppsPayload(apps = []) {
    return apps.map((app) => ({
        package: app.package,
        packageName: app.package,
        userId: app.userId ?? null,
        appName: app.appName || app.labelName || app.displayName || app.package
    }));
}

function requestAppsMetadataPrefetch(apps = [], { priority = "high" } = {}) {
    if (!selectedDevice?.serial || !window.electronAPI?.prefetchAppMetadata) return;

    const toFetch = [];
    for (const app of apps) {
        const key = buildAppKey(app);
        if (prefetchedAppKeys.has(key)) continue;
        if (app.iconUrl || app.iconPath) continue;
        prefetchedAppKeys.add(key);
        toFetch.push(app);
    }

    if (!toFetch.length) return;

    window.electronAPI.prefetchAppMetadata({
        deviceId: selectedDevice.serial,
        apps: buildPrefetchAppsPayload(toFetch),
        maxCount: toFetch.length,
        priority
    }).catch((err) => {
        console.warn("[NewSession] prefetch metadata:", err.message);
    });
}

function setupLauncherIconPrefetch(container, orderedApps = []) {
    disconnectLauncherIconPrefetchObserver();
    if (!container || !orderedApps.length) return;

    requestAppsMetadataPrefetch(orderedApps.slice(0, VISIBLE_PREFETCH_COUNT), { priority: "high" });

    if (typeof IntersectionObserver !== "function") return;

    launcherIconPrefetchObserver = new IntersectionObserver((entries) => {
        const visibleApps = [];
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const appKey = entry.target.dataset.appKey;
            const app = orderedApps.find((item) => buildAppKey(item) === appKey);
            if (app) visibleApps.push(app);
        }
        if (visibleApps.length) {
            requestAppsMetadataPrefetch(visibleApps, { priority: "high" });
        }
    }, {
        root: container,
        rootMargin: SCROLL_PREFETCH_ROOT_MARGIN,
        threshold: 0.01
    });

    container.querySelectorAll(".new-instance-app-item").forEach((btn) => {
        launcherIconPrefetchObserver.observe(btn);
    });
}

function normalizeLauncherApps(apps = []) {
    return apps.map((app) => ({
        ...app,
        appKey: buildAppKey(app),
        appName: app.appName || app.labelName || app.displayName || app.package,
        labelName: app.labelName || app.appName || app.displayName || app.package
    }));
}

function renderLauncherAppsList(apps) {
    const { appResults } = getNewInstanceElements();
    if (!appResults) return;

    if (!selectedDevice) {
        appResults.innerHTML = `<p class="apps-loading">${t("newSession.selectDevice")}</p>`;
        return;
    }

    if (!apps.length) {
        appResults.innerHTML = `<p class="apps-loading">${t("newSession.noAppsFound")}</p>`;
        return;
    }

    appResults.innerHTML = apps.map((app) => {
        const label = getAppLabel(app);
        const variantClass = getAppVariantClass(app);
        const isSelected = selectedApp && buildAppKey(app) === selectedApp.appKey;
        return `
        <button type="button" class="new-instance-app-item ${variantClass}${isSelected ? " selected" : ""}" data-app-key="${buildAppKey(app)}">
            ${renderLauncherAppIcon(app)}
            <span class="new-instance-app-main">
                <span class="new-instance-app-name">${escapeHtml(label)}</span>
                <span class="new-instance-app-package">${escapeHtml(app.package)}${app.userId !== undefined && app.userId !== null ? ` (${t("newSession.profile", { userId: app.userId })})` : ""}</span>
            </span>
        </button>
    `;
    }).join("");

    appResults.querySelectorAll(".new-instance-app-item").forEach((btn) => {
        btn.addEventListener("click", () => {
            const app = launcherApps.find((entry) => buildAppKey(entry) === btn.dataset.appKey);
            if (!app) return;
            selectAppFromLauncher(app);
        });
    });

    setupLauncherIconPrefetch(appResults, apps);
}

function selectAppFromLauncher(app) {
    if (!selectedDevice) {
        setStatus(t("newSession.selectDeviceFirst"), true);
        return;
    }

    selectedApp = mapLauncherAppToSelection(app);
    updateLaunchState();

    const { appSearchInput } = getNewInstanceElements();
    filterLauncherAppsAndRender(appSearchInput?.value || "");
    setStatus(`${t("newSession.selectApp")}: ${getAppLabel(selectedApp)}`);
}

function filterLauncherAppsAndRender(query) {
    if (!selectedDevice) {
        renderLauncherAppsList([]);
        return;
    }

    const normalized = String(query || "").toLowerCase().trim();
    let list = launcherApps.slice();

    if (normalized) {
        list = list.filter((app) => {
            const appName = getAppLabel(app).toLowerCase();
            const packageName = String(app.package || "").toLowerCase();
            return appName.includes(normalized) || packageName.includes(normalized);
        });
    }

    list.sort((a, b) => getAppLabel(a).localeCompare(getAppLabel(b), "fr", { sensitivity: "base" }));
    renderLauncherAppsList(list);
}

function createHistoryAppList() {
    const { historyList, historySearchInput } = getNewInstanceElements();
    if (!historyList || historyAppList) return historyAppList;

    historyList.classList.add("app-list");
    historyAppList = new AppList(historyList, {
        mode: "history",
        emptyMessage: t("newSession.noHistory"),
        noResultsMessage: t("newSession.noSearchResults"),
        sortAlphabetically: false,
        searchInput: historySearchInput || null,
        itemClassName: "app-list-item new-instance-history-item",
        itemTag: "div",
        getItemKey: (entry) => entry.key || buildAppKey({ package: entry.packageName, userId: entry.userId }),
        getAppName: (entry) => entry.appName || entry.packageName,
        getPackageName: (entry) => entry.packageName,
        getIconSrc: (entry) => entry.iconUrl || entry.iconPath || null,
        renderMeta: (entry) => {
            const deviceLabel = escapeHtml(resolveDeviceName(entry.deviceId));
            const dateLabel = formatHistoryDate(entry.lastLaunchedAt);
            const countLabel = entry.launchCount > 1 ? ` · ${entry.launchCount} lancements` : "";
            const userLabel = Number.isInteger(entry.userId) && entry.userId !== 0
                ? ` · ${t("newSession.profile", { userId: entry.userId })}`
                : "";
            return `<span class="app-list-item-meta">${deviceLabel}${userLabel} · ${dateLabel}${countLabel}</span>`;
        },
        renderActions: (entry) => `
            <button type="button" class="app-list-action-btn new-instance-history-delete" data-app-list-action="delete" title="${t("newSession.delete")}" data-history-key="${escapeHtml(entry.key || "")}" data-device-id="${escapeHtml(entry.deviceId)}" data-package="${escapeHtml(entry.packageName)}" data-user-id="${entry.userId ?? ""}" aria-label="${t("newSession.delete")}">${DELETE_ICON_SVG}</button>
        `,
        onSelect: (entry) => {
            selectFromHistory({
                deviceId: entry.deviceId,
                packageName: entry.packageName,
                appName: entry.appName,
                userId: entry.userId ?? null,
                iconPath: entry.iconPath || null,
                iconUrl: entry.iconUrl || null
            });
        }
    });

    historyList.addEventListener("click", (event) => {
        const deleteBtn = event.target.closest(".new-instance-history-delete");
        if (!deleteBtn) return;
        event.stopPropagation();
        removeHistoryEntry({
            key: deleteBtn.dataset.historyKey || null,
            deviceId: deleteBtn.dataset.deviceId,
            packageName: deleteBtn.dataset.package,
            userId: deleteBtn.dataset.userId === "" ? null : Number(deleteBtn.dataset.userId)
        }).catch((err) => {
            setStatus(`Erreur suppression: ${err.message}`, true);
        });
    });

    historyList.addEventListener("dblclick", (event) => {
        if (event.target.closest(".new-instance-history-delete")) return;

        const itemEl = event.target.closest(".new-instance-history-item");
        if (!itemEl || !historyList.contains(itemEl)) return;

        const entry = historyEntries.find((item) => {
            const key = item.key || buildAppKey({ package: item.packageName, userId: item.userId });
            return key === itemEl.dataset.itemKey;
        });
        if (!entry) return;

        event.preventDefault();
        launchFromHistory({
            deviceId: entry.deviceId,
            packageName: entry.packageName,
            appName: entry.appName,
            userId: entry.userId ?? null,
            iconPath: entry.iconPath || null,
            iconUrl: entry.iconUrl || null
        }).catch((err) => {
            setStatus(`Erreur lancement: ${err.message}`, true);
        });
    });

    return historyAppList;
}

function patchLauncherAppIcons(updates = []) {
    const { appResults } = getNewInstanceElements();
    if (!appResults || !updates.length) return false;

    const updateMap = new Map();
    for (const update of updates) {
        updateMap.set(buildAppKey(update), update);
    }

    let patched = false;
    appResults.querySelectorAll(".new-instance-app-item").forEach((btn) => {
        const update = updateMap.get(btn.dataset.appKey);
        if (!update) return;

        const iconSrc = update.iconUrl || update.iconPath;
        if (!iconSrc) return;

        const iconWrap = btn.querySelector(".new-instance-app-icon");
        if (!iconWrap) return;

        const img = iconWrap.querySelector("img");
        if (img) {
            if (img.getAttribute("src") !== iconSrc) {
                img.setAttribute("src", iconSrc);
                patched = true;
            }
            iconWrap.classList.remove("is-placeholder", "hub-app-icon-placeholder");
            return;
        }

        iconWrap.classList.remove("is-placeholder", "hub-app-icon-placeholder");
        iconWrap.innerHTML = `<img src="${escapeHtml(iconSrc)}" alt="" loading="lazy">`;
        patched = true;
    });

    return patched;
}

function applyMetadataUpdates(updates = []) {
    if (!updates.length) return;

    launcherApps = launcherApps.map((app) => {
        const match = updates.find((update) => buildAppKey(update) === buildAppKey(app));
        if (!match) return app;
        return {
            ...app,
            appName: match.appName || app.appName,
            labelName: match.appName || app.labelName,
            displayName: match.appName || app.displayName,
            iconPath: match.iconPath || app.iconPath,
            iconUrl: match.iconUrl || app.iconUrl
        };
    });

    const { appSearchInput } = getNewInstanceElements();
    if (!patchLauncherAppIcons(updates)) {
        filterLauncherAppsAndRender(appSearchInput?.value || "");
    }

    historyEntries = historyEntries.map((entry) => {
        const match = updates.find((update) =>
            update.packageName === entry.packageName
            && (update.userId ?? null) === (entry.userId ?? null)
            && (!update.deviceId || update.deviceId === entry.deviceId)
        );
        if (!match) return entry;
        return {
            ...entry,
            appName: match.appName || entry.appName,
            iconPath: match.iconPath || entry.iconPath,
            iconUrl: match.iconUrl || entry.iconUrl
        };
    });

    if (historyAppList) {
        historyAppList.updateMetadata(updates.map((update) => {
            const entry = historyEntries.find((item) =>
                item.packageName === (update.packageName || update.package)
                && (item.userId ?? null) === (update.userId ?? null)
                && (!update.deviceId || item.deviceId === update.deviceId)
            );
            return entry ? { ...update, key: entry.key } : update;
        }));
    }
}

async function loadLaunchHistory() {
    const { historyList } = getNewInstanceElements();
    if (!historyList || !window.launchHistoryAPI?.list) {
        return;
    }

    try {
        const response = await window.launchHistoryAPI.list();
        historyEntries = Array.isArray(response?.entries) ? response.entries : [];
    } catch (err) {
        console.error("[NewSession] loadLaunchHistory:", err);
        historyEntries = [];
    }

    renderHistoryList();
}

function scheduleLaunchHistoryRefresh() {
    const run = () => {
        loadLaunchHistory().catch((err) => {
            console.error("[NewSession] scheduleLaunchHistoryRefresh:", err);
        });
    };

    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 3000 });
    } else {
        setTimeout(run, 0);
    }
}

function renderHistoryList() {
    const list = createHistoryAppList();
    if (!list) return;
    list.setItems(historyEntries);
    list.syncSearchFromInput();
}

async function removeHistoryEntry({ key, deviceId, packageName, userId = null }) {
    if (!window.launchHistoryAPI?.remove) return;
    const response = await window.launchHistoryAPI.remove({ key, deviceId, packageName, userId });
    if (!response?.success) {
        const detail = response?.requestedKey
            ? ` (clé: ${response.requestedKey})`
            : "";
        throw new Error((response?.error || "suppression impossible") + detail);
    }
    await loadLaunchHistory();
}

function setStatus(message = "", isError = false) {
    const { status } = getNewInstanceElements();
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
}

function buildTypeBLaunchStreamOptions() {
    return {
        newDisplay: "1920x1080",
        stayAwake: true,
        turnScreenOff: true
    };
}

const pendingDisplayIdWaiters = [];

function resolveDisplayIdWaiters(data) {
    if (!data?.serial || !Number.isInteger(data.displayId)) return;

    for (let i = pendingDisplayIdWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = pendingDisplayIdWaiters[i];
        if (waiter.serial === data.serial) {
            clearTimeout(waiter.timer);
            waiter.resolve(data.displayId);
            pendingDisplayIdWaiters.splice(i, 1);
        }
    }
}

function waitForVirtualDisplayId(serial, knownDisplayId, timeoutMs = 10000) {
    if (Number.isInteger(knownDisplayId)) {
        return Promise.resolve(knownDisplayId);
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            const index = pendingDisplayIdWaiters.findIndex((w) => w.resolve === resolve);
            if (index >= 0) pendingDisplayIdWaiters.splice(index, 1);
            resolve(null);
        }, timeoutMs);

        pendingDisplayIdWaiters.push({ serial, resolve, timer });
    });
}

function formatTypeBLaunchCommand(packageName) {
    const pkg = packageName || "";
    return `scrcpy --new-display=1920x1080 --stay-awake --turn-screen-off --start-app=${pkg}`;
}

function updateCommandPreview() {
    const { commandPreview } = getNewInstanceElements();
    if (!commandPreview) return;
    commandPreview.textContent = formatTypeBLaunchCommand(selectedApp?.package || "");
}

function updateLaunchState() {
    const { launchBtn, launchHint } = getNewInstanceElements();
    if (!launchBtn || !launchHint) return;

    const hasDevice = Boolean(selectedDevice);
    const hasApp = Boolean(selectedApp);
    const isReady = hasDevice && hasApp;

    launchBtn.classList.toggle("is-active", isReady);

    if (!hasDevice) {
        launchHint.textContent = t("newSession.selectDeviceFirst");
        updateCommandPreview();
        return;
    }

    if (!hasApp) {
        launchHint.textContent = t("newSession.selectApp");
        updateCommandPreview();
        return;
    }

    launchHint.textContent = t("newSession.readyToLaunch");
    updateCommandPreview();
}

function renderDeviceList(devices) {
    const { deviceList } = getNewInstanceElements();
    if (!deviceList) return;

    const connected = (Array.isArray(devices) ? devices : []).filter((d) => d?.connected !== false);

    if (!connected.length) {
        deviceList.innerHTML = `<p class="apps-loading">${t("newSession.noDeviceConnected")}</p>`;
        return;
    }

    deviceList.innerHTML = connected.map((d) => {
        const isSelected = selectedDevice && (
            selectedDevice.deviceId === d.deviceId
            || selectedDevice.serial === d.serial
        );
        const transport = d.transportLabel || (d.transport === "wifi" ? t("devicesPanel.wifi") : t("devicesPanel.usb"));
        return `
        <button type="button" class="new-instance-device-item ${isSelected ? "selected" : ""}" data-serial="${d.serial}" data-device-id="${d.deviceId || d.serial}" data-name="${d.name}">
            <span class="status-dot status-${d.status}"></span>
            <span class="new-instance-device-main">
                <span class="new-instance-device-name">${d.name}</span>
                <span class="new-instance-device-serial">${d.serial} · ${transport}</span>
            </span>
        </button>
    `;
    }).join("");

    deviceList.querySelectorAll(".new-instance-device-item").forEach((btn) => {
        btn.addEventListener("click", () => {
            selectDevice(btn.dataset.serial, btn.dataset.name, btn.dataset.deviceId);
        });
    });
}

async function loadAppsForSelectedDevice() {
    if (!selectedDevice) return;

    resetMetadataPrefetchState();

    const { appResults } = getNewInstanceElements();
    if (!appResults) return;

    updateLauncherHint(`Applications installees sur ${selectedDevice.name || selectedDevice.serial}`);
    appResults.innerHTML = `<p class="apps-loading">${t("newSession.loadingApps")}</p>`;
    setStatus(t("newSession.loadingApps"));

    try {
        const response = await window.electronAPI.getAppsWithDetails(selectedDevice.serial);
        if (response?.success === false) {
            throw new Error(response.error || "Impossible de charger les applications");
        }

        const apps = Array.isArray(response)
            ? response
            : Array.isArray(response?.apps)
                ? response.apps
                : [];

        launcherApps = normalizeLauncherApps(apps);

        const { appSearchInput } = getNewInstanceElements();
        filterLauncherAppsAndRender(appSearchInput?.value || "");

        if (!launcherApps.length) {
            setStatus(t("newSession.noAppsDetected"), true);
            return;
        }

        const cachedIconUpdates = launcherApps.filter((app) => app.iconUrl || app.iconPath);
        if (cachedIconUpdates.length) {
            patchLauncherAppIcons(cachedIconUpdates);
        }

        setStatus(`${launcherApps.length} application(s) chargee(s).`);
    } catch (err) {
        launcherApps = [];
        appResults.innerHTML = `<p class="apps-loading">${t("newSession.loadAppsError")}</p>`;
        setStatus(`Erreur apps: ${err.message}`, true);
        console.error("[NewSession] loadAppsForSelectedDevice:", err);
    }
}

async function fetchConnectedDevices({ force = false } = {}) {
    if (force && typeof window.refreshDevicesForce === "function") {
        await window.refreshDevicesForce();
    } else if (typeof window.refreshDevicesIfStale === "function") {
        await window.refreshDevicesIfStale();
    } else if (typeof window.refreshDevices === "function") {
        await window.refreshDevices();
    }

    let source = typeof window.getConnectedDevices === "function"
        ? window.getConnectedDevices()
        : (typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : []);

    if (!source.length && !force && typeof window.refreshDevicesForce === "function") {
        await window.refreshDevicesForce();
        source = typeof window.getConnectedDevices === "function"
            ? window.getConnectedDevices()
            : (typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : []);
    }

    if (source.length > 0) {
        return source.filter((d) => d?.connected !== false);
    }

    try {
        const response = await window.electronAPI.getDevices();
        const devices = Array.isArray(response)
            ? response
            : Array.isArray(response?.devices)
                ? response.devices
                : [];
        return devices.filter((d) => d?.connected !== false);
    } catch (_err) {
        return [];
    }
}

async function selectDevice(serial, name, deviceId) {
    const nextSerial = serial;
    if (selectedDevice?.serial && selectedDevice.serial !== nextSerial) {
        resetMetadataPrefetchState();
    }

    selectedDevice = { serial, name, deviceId: deviceId || serial };
    selectedApp = null;

    const devices = await fetchConnectedDevices();
    renderDeviceList(devices);
    updateLaunchState();
    setStatus("");

    await loadAppsForSelectedDevice();
}

async function loadConnectedDevices() {
    const devices = await fetchConnectedDevices({ force: true });
    connectedDevicesCache = devices;

    renderDeviceList(devices);
    renderHistoryList();

    if (!selectedDevice) {
        resetLauncherApps();
    }
}

function createLaunchPipeline(sessionId) {
    return {
        sessionId,
        adbSocketConnected: false,
        h264FirstPacket: false,
        decoderReady: false,
        canvasActive: false
    };
}

function renderLaunchPipelineStatus(prefix = "Pipeline") {
    if (!launchPipeline) return;

    const parts = [
        `ADB Socket ${launchPipeline.adbSocketConnected ? "OK" : "..."}`,
        `H.264 ${launchPipeline.h264FirstPacket ? "OK" : "..."}`,
        `Decode ${launchPipeline.decoderReady ? "OK" : "..."}`,
        `Canvas ${launchPipeline.canvasActive ? "OK" : "..."}`
    ];

    setStatus(`${prefix}: ${parts.join(" | ")}`);
}

function activateNewInstanceSession(sessionId) {
    const entry = newInstanceSessions.get(sessionId);
    if (!entry) return;

    document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
    document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
    activeNewInstanceSessionId = sessionId;
}

async function closeNewInstanceSession(sessionId) {
    const entry = newInstanceSessions.get(sessionId);

    if (entry) {
        try {
            if (entry.player) {
                try {
                    await entry.player.stop();
                } catch (_err) {
                    // noop
                }
            }

            if (entry.pipeline) {
                await entry.pipeline.stop();
                entry.pipeline.dispose?.();
            } else if (sessionId.startsWith("new-instance-") && window.electronAPI?.newInstanceStop) {
                await window.electronAPI.newInstanceStop({ sessionId });
            }
        } catch (err) {
            console.error(`[NewSession] Erreur fermeture session ${sessionId}:`, err);
        }

        if (entry.canvas) {
            entry.canvas.remove();
        }

        if (window.__sessionStreamBridge) {
            window.__sessionStreamBridge.unregisterSessionStreamHandle(sessionId);
        }

        newInstanceSessions.delete(sessionId);
    } else if (sessionId.startsWith("new-instance-") && window.electronAPI?.newInstanceStop) {
        try {
            await window.electronAPI.newInstanceStop({ sessionId });
        } catch (err) {
            console.error(`[NewSession] Erreur arret backend ${sessionId}:`, err);
        }
    }

    if (window.sessionAPI) {
        await window.sessionAPI.close(sessionId);
    }

    if (activeNewInstanceSessionId === sessionId) {
        activeNewInstanceSessionId = null;
        const remaining = Array.from(newInstanceSessions.keys());
        if (remaining.length > 0) {
            activateNewInstanceSession(remaining[remaining.length - 1]);
        } else {
            showPage("page-new");
            document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
        }
    }

    if (typeof renderSidebar === "function") renderSidebar();
}

function buildTypeBTabLabel(deviceName, appLabel) {
    const device = String(deviceName || "").trim();
    const app = String(appLabel || "").trim();
    if (device && app) return `${device} — ${app}`;
    return app || device || t("newSession.launchInstance");
}

async function launchTypeBSession({
    serial,
    deviceName,
    packageName,
    appLabel,
    userId = null,
    iconPath = null,
    stableDeviceId = null
}) {
    if (isHubModalChildWindow()) {
        dismissHubModalPanel();
        return invokeMainAction("launchTypeBSession", [{
            serial,
            deviceName,
            packageName,
            appLabel,
            userId,
            iconPath,
            stableDeviceId: stableDeviceId || selectedDevice?.deviceId || null
        }]);
    }

    dismissHubModalPanel();

    if (!serial || !packageName) {
        throw new Error("appareil ou application manquant");
    }

    const normalizedUserId = Number.isInteger(userId) ? userId : null;
    const tabLabel = buildTypeBTabLabel(deviceName, appLabel || window.AppDisplay?.humanizePackageName?.(packageName) || packageName);

    setStatus(`Lancement : ${formatTypeBLaunchCommand(packageName)}`);

    const resolvedStableId = stableDeviceId || selectedDevice?.deviceId || null;

    let latencyTraceId = null;
    if (window.LaunchLatency?.markClick) {
        const started = await window.LaunchLatency.markClick("B");
        latencyTraceId = started.traceId;
    }

    const scrcpyLaunch = await window.electronAPI.launchNewInstance(
        serial,
        packageName,
        normalizedUserId,
        latencyTraceId,
        resolvedStableId
    );
    if (!scrcpyLaunch?.success) {
        throw new Error(scrcpyLaunch?.error || t("newSession.launchFailed"));
    }

    if (latencyTraceId && window.LaunchLatency?.mark) {
        await window.LaunchLatency.mark(latencyTraceId, "waitDisplayStart");
    }
    const presetDisplayId = await waitForVirtualDisplayId(serial, scrcpyLaunch.displayId, 10000);
    if (latencyTraceId && window.LaunchLatency?.mark) {
        await window.LaunchLatency.mark(latencyTraceId, "waitDisplayEnd");
    }
    if (!Number.isInteger(presetDisplayId)) {
        throw new Error(t("newSession.virtualDisplayMissing"));
    }

    const presetScrcpyOpts = await buildDefaultScrcpyOptions("B");
    const streamOptions = {
        ...presetScrcpyOpts,
        stayAwake: true,
        turnScreenOff: true,
        audio: false
    };

    const payload = {
        serial,
        stableDeviceId: resolvedStableId,
        packageName,
        userId: normalizedUserId,
        tabLabel,
        streamOptions,
        presetDisplayId,
        skipPackageLaunch: true,
        externalLaunchId: scrcpyLaunch.launchId || null
    };

    const created = await window.electronAPI.newInstanceCreate(payload);
    if (!created?.success || !created?.session?.sessionId) {
        throw new Error(created?.error || "creation session impossible");
    }

    const session = created.session;
    const sessionId = session.sessionId;

    if (latencyTraceId && window.LaunchLatency?.bindSession) {
        await window.LaunchLatency.bindSession(latencyTraceId, sessionId);
    }

    const stage = document.getElementById("video-stage");

    const canvas = document.createElement("canvas");
    canvas.id = `canvas-${sessionId}`;
    canvas.dataset.sessionId = sessionId;
    canvas.dataset.kind = "new-instance";
    canvas.style.display = "none";

    if (stage) {
        stage.appendChild(canvas);
    }

    const pipeline = window.createNewInstanceVideoPipeline(sessionId, canvas);

    newInstanceSessions.set(sessionId, {
        sessionId,
        label: tabLabel,
        canvas,
        pipeline,
        serial,
        packageName
    });

    try {
        if (window.sessionAPI) {
            await window.sessionAPI.registerView(sessionId, "B", {
                label: tabLabel,
                deviceId: serial,
                stableDeviceId: resolvedStableId,
                packageName,
                userId: normalizedUserId,
                stayAwakeActive: true
            });
        }

        const started = await pipeline.start();
        if (!started?.success) {
            throw new Error(started?.error || "demarrage session echoue");
        }

        if (typeof finalizeSessionUI === "function") {
            await finalizeSessionUI(sessionId, { label: tabLabel });
        } else if (typeof onSessionLaunched === "function") {
            await onSessionLaunched(sessionId, "B", { label: tabLabel });
        } else {
            activateNewInstanceSession(sessionId);
        }

        launchPipeline = createLaunchPipeline(sessionId);
        renderLaunchPipelineStatus(`Instance lancee pour ${appLabel || tabLabel}`);

        scheduleLaunchHistoryRefresh();
    } catch (err) {
        await closeNewInstanceSession(sessionId);
        throw err;
    }
}

async function selectFromHistory(entry) {
    const { deviceId, packageName, appName, userId, iconPath, iconUrl } = entry;
    const devices = await fetchConnectedDevices();
    connectedDevicesCache = devices;

    const device = findDeviceForHistory(devices, deviceId);
    if (!device) {
        setStatus(t("newSession.deviceNotConnected"), true);
        return;
    }

    const previousSerial = selectedDevice?.serial;
    selectedDevice = { serial: device.serial, name: device.name || deviceId, deviceId: device.deviceId || deviceId };
    selectedApp = {
        package: packageName,
        displayName: appName || packageName,
        labelName: appName || packageName,
        userId: Number.isInteger(userId) ? userId : null,
        appKey: buildAppKey({ package: packageName, userId }),
        iconPath: iconPath || null,
        iconUrl: iconUrl || null
    };

    renderDeviceList(devices);
    updateLaunchState();

    if (previousSerial !== device.serial || !launcherApps.length) {
        await loadAppsForSelectedDevice();
    } else {
        const { appSearchInput } = getNewInstanceElements();
        filterLauncherAppsAndRender(appSearchInput?.value || "");
    }

    setStatus(`Pret a lancer : ${appName || packageName} — cliquez « Lancer instance » ou double-cliquez dans l'historique`);
}

async function launchFromHistory(entry) {
    const { deviceId, packageName, appName, userId, iconPath } = entry;
    if (!deviceId || !packageName) {
        setStatus(t("newSession.historyIncomplete"), true);
        return;
    }

    const devices = await fetchConnectedDevices();
    const device = findDeviceForHistory(devices, deviceId);
    if (!device) {
        setStatus(t("newSession.deviceNotConnected"), true);
        return;
    }

    const appLabel = appName || getAppLabel({ package: packageName, displayName: appName, labelName: appName });

    setStatus(`Lancement : ${appLabel}...`);
    await launchTypeBSession({
        serial: device.serial,
        stableDeviceId: device.deviceId,
        deviceName: device.name || deviceId,
        packageName,
        appLabel,
        userId: Number.isInteger(userId) ? userId : null,
        iconPath: iconPath || null
    });
}

async function launchNewInstanceSession() {
    if (!selectedDevice) {
        updateLaunchState();
        return;
    }
    if (!selectedApp) {
        updateLaunchState();
        return;
    }

    const appLabel = getAppLabel(selectedApp);

    try {
        await launchTypeBSession({
            serial: selectedDevice.serial,
            stableDeviceId: selectedDevice.deviceId,
            deviceName: selectedDevice.name,
            packageName: selectedApp.package,
            appLabel,
            userId: Number.isInteger(selectedApp.userId) ? selectedApp.userId : null,
            iconPath: selectedApp.iconPath || null
        });
    } catch (err) {
        setStatus(`Erreur lancement: ${err.message}`, true);
    }
}

function onMirrorButtonClick() {
    launchMirrorSession().catch((err) => {
        setStatus(`Erreur mirroring: ${err.message}`, true);
    });
}

function setSelectedDeviceForMirror(serial, name, deviceId) {
    selectedDevice = { serial, name, deviceId: deviceId || serial };
}

async function launchMirrorSession(options = {}) {
    if (isHubModalChildWindow()) {
        const serial = options.serial || selectedDevice?.serial;
        const deviceName = options.deviceName || selectedDevice?.name || serial;
        if (!serial) {
            setStatus(t("newSession.selectDeviceFirst"), true);
            return;
        }
        dismissHubModalPanel();
        try {
            await invokeMainAction("launchMirrorSession", [{
                serial,
                deviceName,
                stableDeviceId: options.stableDeviceId || selectedDevice?.deviceId || serial
            }]);
        } catch (err) {
            setStatus(`Erreur mirroring: ${err.message}`, true);
        }
        return;
    }

    dismissHubModalPanel();

    if (!options.serial && !selectedDevice) {
        setStatus(t("newSession.selectDeviceFirst"), true);
        return;
    }

    const serial = options.serial || selectedDevice?.serial;
    const deviceName = options.deviceName || selectedDevice?.name || serial;
    const mirrorLabel = `${deviceName} (Mirror)`;

    setStatus(t("newSession.launchingMirror"));

    try {
        if (typeof createInstance !== "function") {
            throw new Error(t("newSession.instanceManagerUnavailable"));
        }

        let latencyTraceId = options.latencyTraceId || null;
        if (!latencyTraceId && window.__pendingMirrorLatencyTraceId) {
            latencyTraceId = window.__pendingMirrorLatencyTraceId;
            window.__pendingMirrorLatencyTraceId = null;
        }
        if (!latencyTraceId && window.LaunchLatency?.markClick) {
            const started = await window.LaunchLatency.markClick("A");
            latencyTraceId = started.traceId;
        }

        const scrcpyOpts = await buildDefaultScrcpyOptions("A");

        await createInstance(serial, deviceName, null, {
            tabLabel: mirrorLabel,
            stableDeviceId: options.stableDeviceId || selectedDevice?.deviceId || null,
            latencyTraceId,
            ...scrcpyOpts
        });

        setStatus(t("newSession.mirrorActive", { deviceName }));
    } catch (err) {
        setStatus(`Erreur mirroring: ${err.message}`, true);
    }
}

async function openNewSessionPanel(options = {}) {
    if (!options.inChildWindow && !isHubModalChildWindow()) {
        if (window.hubModalAPI) {
            await window.hubModalAPI.open({ panel: "new-session" });
        }
        document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
        document.getElementById("nav-new-session")?.classList.add("active");
        return;
    }

    selectedDevice = null;
    selectedApp = null;
    launchPipeline = null;
    resetLauncherApps();
    historyAppList?.resetSearch();
    setStatus("");
    updateLaunchState();
    await Promise.all([loadConnectedDevices(), loadLaunchHistory()]);
}

window.openNewSessionPanel = openNewSessionPanel;

window.refreshNewSessionPanel = async function refreshNewSessionPanel() {
    if (typeof window.refreshDevicesForce === "function") {
        await window.refreshDevicesForce();
    } else if (typeof window.refreshDevices === "function") {
        await window.refreshDevices();
    }
    await loadConnectedDevices();
    await loadLaunchHistory();
};

document.addEventListener("DOMContentLoaded", () => {
    const navNewSession = document.getElementById("nav-new-session");
    const appSearchInput = document.getElementById("new-instance-app-search-input");
    const launchBtn = document.getElementById("new-instance-launch-btn");

    resetLauncherApps();

    if (window.electronAPI?.onNewInstanceDisplayReady) {
        window.electronAPI.onNewInstanceDisplayReady(resolveDisplayIdWaiters);
    }

    if (navNewSession && !isHubModalChildWindow()) {
        // Géré dans index.html
    }

    if (appSearchInput) {
        appSearchInput.addEventListener("input", (e) => {
            filterLauncherAppsAndRender(e.target.value || "");
        });
    }

    if (launchBtn) {
        launchBtn.addEventListener("click", () => {
            launchNewInstanceSession().catch((err) => {
                setStatus(`Erreur lancement: ${err.message}`, true);
            });
        });
    }

    const mirrorBtn = document.getElementById("new-instance-mirror-btn");
    if (mirrorBtn) {
        mirrorBtn.addEventListener("click", onMirrorButtonClick);
    }

    if (window.electronAPI?.onVideoStreamState) {
        window.electronAPI.onVideoStreamState((data) => {
            if (!launchPipeline || !data || data.tabId !== launchPipeline.sessionId) return;
            if (data.stage === "codec-meta") {
                launchPipeline.decoderReady = true;
                renderLaunchPipelineStatus("Pipeline Android -> Canvas");
            }
            if (data.stage === "h264-first-packet") {
                launchPipeline.h264FirstPacket = true;
                renderLaunchPipelineStatus("Pipeline Android -> Canvas");
            }
            if (data.stage === "adb-socket-connected") {
                launchPipeline.adbSocketConnected = true;
                renderLaunchPipelineStatus("Pipeline Android -> Canvas");
            }
        });
    }

    if (window.electronAPI?.onNewInstanceState) {
        window.electronAPI.onNewInstanceState((data) => {
            if (!launchPipeline || !data || data.sessionId !== launchPipeline.sessionId) return;
            if (data.state === "started") {
                launchPipeline.adbSocketConnected = true;
                renderLaunchPipelineStatus("Pipeline Android -> Canvas");
            }
            if (data.state === "display-ready") {
                launchPipeline.adbSocketConnected = true;
                renderLaunchPipelineStatus("Pipeline Android -> Canvas");
            }
        });
    }

    if (window.electronAPI?.onVideoError) {
        window.electronAPI.onVideoError((data) => {
            if (!data?.codecFallback) return;
            window.showHubToast?.(t("controlPanel.videoCodec.fallbackToast"), "info");
        });
    }

    if (window.electronAPI?.onNewInstanceVideoError) {
        window.electronAPI.onNewInstanceVideoError((data) => {
            if (data?.codecFallback) {
                window.showHubToast?.(t("controlPanel.videoCodec.fallbackToast"), "info");
                return;
            }
            if (!launchPipeline || !data || data.sessionId !== launchPipeline.sessionId) return;
            setStatus(`Erreur flux video: ${data.error || "inconnue"}`, true);
        });
    }

    if (window.electronAPI?.onNewInstanceScrcpyClosed && !isHubModalChildWindow()) {
        window.electronAPI.onNewInstanceScrcpyClosed(async ({ sessionId } = {}) => {
            if (!sessionId) return;
            console.log(`[NewSession] Scrcpy ferme, fermeture session ${sessionId}`);
            await closeNewInstanceSession(sessionId);
        });
    }

    window.addEventListener("new-instance:first-frame", (event) => {
        const sessionId = event?.detail?.sessionId;
        if (!launchPipeline || sessionId !== launchPipeline.sessionId) return;
        launchPipeline.canvasActive = true;
        renderLaunchPipelineStatus("Pipeline Android -> Canvas");
    });

    window.addEventListener("devices-refreshed", async (event) => {
        if (!isHubModalChildWindow()) return;

        const allDevices = Array.isArray(event.detail)
            ? event.detail
            : (typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : []);
        const connectedDevices = allDevices.filter((d) => d?.connected !== false);
        connectedDevicesCache = connectedDevices;
        if (selectedDevice && !connectedDevices.some((d) =>
            d.serial === selectedDevice.serial || d.deviceId === selectedDevice.deviceId
        )) {
            selectedDevice = null;
            selectedApp = null;
            resetLauncherApps();
            setStatus(t("newSession.deviceDisconnected"), true);
            await loadConnectedDevices();
            updateLaunchState();
            return;
        }

        renderDeviceList(connectedDevices);
        renderHistoryList();
        updateLaunchState();
    });

    if (window.electronAPI?.onAppMetadataUpdated) {
        window.electronAPI.onAppMetadataUpdated(({ serial, updates } = {}) => {
            if (!selectedDevice || serial !== selectedDevice.serial) {
                if (Array.isArray(updates) && updates.length) {
                    applyMetadataUpdates(updates.map((update) => ({ ...update, deviceId: serial })));
                }
                return;
            }
            applyMetadataUpdates(updates);
        });
    }

    if (window.launchHistoryAPI?.onUpdated) {
        window.launchHistoryAPI.onUpdated(() => {
            scheduleLaunchHistoryRefresh();
        });
    }

    updateLaunchState();
});

globalThis.HubI18n?.onChange?.(() => {
    globalThis.HubI18n?.applyDomI18n?.(document.getElementById("panel-new-session") || document);
    resetLauncherApps();
    updateLaunchState();
    if (typeof window.refreshNewSessionPanel === "function") {
        void window.refreshNewSessionPanel();
    }
});

function getAllNewInstanceSessions() {
    return Array.from(newInstanceSessions.values());
}

window.getAllNewInstanceSessions = getAllNewInstanceSessions;

if (!isHubModalChildWindow()) {
    window.__hubModalMainActions = {
        launchTypeBSession,
        launchMirrorSession,
        launchFromHistory,
        onMirrorButtonClick,
        setSelectedDeviceForMirror
    };
}
