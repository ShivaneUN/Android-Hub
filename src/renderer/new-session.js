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
const DEVICE_USB_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 7h6M9 17h6"/></svg>`;
const DEVICE_WIFI_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12.5a9 9 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg>`;
let historyExpanded = false;
const RECENTS_STRIP_LIMIT = 9;

const newInstanceSessions = new Map();
/** Clés `device::package::user` des lancements Type B en cours (anti double-clic / double lancement). */
const typeBLaunchInFlightKeys = new Set();
let activeNewInstanceSessionId = null;
let historyAppList = null;
let launcherIconPrefetchObserver = null;
const prefetchedAppKeys = new Set();
const VISIBLE_PREFETCH_COUNT = 36;
const SCROLL_PREFETCH_ROOT_MARGIN = "480px 0px";

/** sessionId → timestamp : ignore scrcpy-closed pendant/après reattach USB↔WiFi. */
const scrcpyClosedGraceUntilBySession = new Map();

function markScrcpyClosedGrace(sessionId, ms = 25000) {
    if (!sessionId) return;
    const until = Date.now() + ms;
    const prev = scrcpyClosedGraceUntilBySession.get(sessionId) || 0;
    if (until > prev) scrcpyClosedGraceUntilBySession.set(sessionId, until);
}

function markAllTypeBScrcpyClosedGrace(ms = 25000) {
    for (const sessionId of newInstanceSessions.keys()) {
        markScrcpyClosedGrace(sessionId, ms);
    }
}

function shouldIgnoreScrcpyClosedLocally(sessionId) {
    if (!sessionId) return false;
    const until = scrcpyClosedGraceUntilBySession.get(sessionId) || 0;
    if (Date.now() < until) return true;
    scrcpyClosedGraceUntilBySession.delete(sessionId);
    return false;
}

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

function isWifiLaunchContext({ serial, isWifi, device } = {}) {
    if (typeof isWifi === "boolean") return isWifi;
    if (device?.transport === "wifi") return true;
    const label = String(device?.transportLabel || "").toLowerCase();
    if (label.includes("wifi") || label.includes("wi-fi")) return true;
    const candidate = serial || device?.serial || device?.wifiSerial || null;
    if (typeof StreamParams !== "undefined" && StreamParams.isWifiTransportSerial) {
        return StreamParams.isWifiTransportSerial(candidate);
    }
    return /:\d+$/.test(String(candidate || "").trim());
}

async function resolveDefaultLaunchStreamParams(context = {}) {
    const wifi = isWifiLaunchContext(context);
    const transport = wifi ? "wifi" : "usb";

    try {
        if (window.displayPresetsAPI?.getDefault) {
            const result = await window.displayPresetsAPI.getDefault(transport);
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

    if (typeof StreamParams !== "undefined" && StreamParams.getFactoryStreamParams) {
        return StreamParams.getFactoryStreamParams({ wifi });
    }

    if (wifi && typeof StreamParams !== "undefined" && StreamParams.DEFAULT_WIFI_STREAM_PARAMS) {
        return StreamParams.cloneParams
            ? StreamParams.cloneParams(StreamParams.DEFAULT_WIFI_STREAM_PARAMS)
            : { ...StreamParams.DEFAULT_WIFI_STREAM_PARAMS };
    }

    if (typeof StreamParams !== "undefined" && StreamParams.DEFAULT_STREAM_PARAMS) {
        return StreamParams.cloneParams
            ? StreamParams.cloneParams(StreamParams.DEFAULT_STREAM_PARAMS)
            : { ...StreamParams.DEFAULT_STREAM_PARAMS };
    }

    return wifi
        ? {
            width: 1280,
            height: 720,
            dpi: 240,
            maxFps: 30,
            bitRateMbps: 8,
            iFrameInterval: 1,
            videoCodec: "h264"
        }
        : {
            width: 1920,
            height: 1080,
            dpi: 240,
            maxFps: 60,
            bitRateMbps: 8,
            iFrameInterval: 1,
            videoCodec: "h264"
        };
}

async function buildDefaultScrcpyOptions(sessionType, context = {}) {
    const params = await resolveDefaultLaunchStreamParams(context);
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

function normalizeTypeBLaunchUserId(userId) {
    return Number.isInteger(userId) ? userId : 0;
}

function buildTypeBLaunchKey({ serial, stableDeviceId, packageName, userId } = {}) {
    const deviceKey = String(stableDeviceId || serial || "").trim();
    const pkg = String(packageName || "").trim();
    if (!deviceKey || !pkg) return null;
    return `${deviceKey}::${pkg}::${normalizeTypeBLaunchUserId(userId)}`;
}

function sameTypeBLaunchDevice(entry, { serial, stableDeviceId } = {}) {
    if (!entry) return false;
    const entryStable = entry.stableDeviceId || null;
    const entrySerial = entry.serial || entry.deviceId || null;
    if (stableDeviceId && entryStable && entryStable === stableDeviceId) return true;
    if (serial && entrySerial && entrySerial === serial) return true;
    if (stableDeviceId && entrySerial && entrySerial === stableDeviceId) return true;
    return false;
}

function findOpenTypeBSessionLocal({ serial, stableDeviceId, packageName, userId } = {}) {
    const pkg = String(packageName || "").trim();
    if (!pkg) return null;
    const targetUser = normalizeTypeBLaunchUserId(userId);
    for (const entry of newInstanceSessions.values()) {
        if (String(entry.packageName || "").trim() !== pkg) continue;
        if (normalizeTypeBLaunchUserId(entry.userId) !== targetUser) continue;
        if (!sameTypeBLaunchDevice(entry, { serial, stableDeviceId })) continue;
        return entry;
    }
    return null;
}

async function findOpenTypeBSessionFromList({ serial, stableDeviceId, packageName, userId } = {}) {
    const pkg = String(packageName || "").trim();
    if (!pkg || !window.sessionAPI?.list) return null;
    const targetUser = normalizeTypeBLaunchUserId(userId);
    try {
        const sessions = await window.sessionAPI.list();
        if (!Array.isArray(sessions)) return null;
        for (const session of sessions) {
            if (session?.type !== "B") continue;
            if (String(session.packageName || "").trim() !== pkg) continue;
            if (normalizeTypeBLaunchUserId(session.userId) !== targetUser) continue;
            if (!sameTypeBLaunchDevice(session, { serial, stableDeviceId })) continue;
            return session;
        }
    } catch (err) {
        console.warn("[NewSession] session:list indisponible pour garde Type B:", err?.message || err);
    }
    return null;
}

async function focusExistingTypeBSession(sessionId, appLabel = null) {
    if (!sessionId) return false;
    let activated = false;
    try {
        if (typeof activateSessionTab === "function") {
            activated = (await activateSessionTab(sessionId)) !== false;
        } else if (window.sessionAPI?.switchTo) {
            activated = Boolean(await window.sessionAPI.switchTo(sessionId));
        }
    } catch (err) {
        console.warn("[NewSession] focus session existante échoué:", err?.message || err);
    }
    const label = appLabel || sessionId;
    setStatus(
        activated
            ? t("newSession.alreadyOpenFocused", { appLabel: label })
            : t("newSession.alreadyOpen", { appLabel: label })
    );
    return activated;
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
        recentsStrip: document.getElementById("new-instance-recents-strip"),
        historyExpandedPanel: document.getElementById("new-instance-history-expanded"),
        historyToggle: document.getElementById("new-instance-history-toggle"),
        appLauncherHint: document.getElementById("new-instance-app-launcher-hint"),
        appSearchInput: document.getElementById("new-instance-app-search-input"),
        appResults: document.getElementById("new-instance-app-results"),
        launchBtn: document.getElementById("new-instance-launch-btn"),
        launchHint: document.getElementById("new-instance-launch-hint"),
        status: document.getElementById("new-instance-status"),
        commandPreview: document.getElementById("new-instance-command-preview"),
        body: document.querySelector("#panel-new-session .new-instance-body")
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

function formatRelativeTime(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 60_000) return t("newSession.justNow");
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return t("newSession.minutesAgo", { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("newSession.hoursAgo", { count: hours });
    return formatHistoryDate(timestamp);
}

function getHistoryAppLabel(entry) {
    const device = findDeviceForHistory(connectedDevicesCache, entry?.deviceId);
    const aliases = [device?.name, device?.originalName, resolveDeviceName(entry?.deviceId)].filter(Boolean);
    if (window.AppDisplay?.resolveHistoryAppName) {
        return window.AppDisplay.resolveHistoryAppName(entry, aliases) || "—";
    }
    const raw = String(entry?.appName || "").trim();
    const pkg = String(entry?.packageName || "").trim();
    const deviceLabel = aliases[0] || "";
    if (!raw || raw === deviceLabel || raw.startsWith(`${deviceLabel} —`) || raw.startsWith(`${deviceLabel} -`)) {
        if (pkg) {
            const shortPkg = pkg.includes(".") ? pkg.split(".").pop() : pkg;
            return shortPkg || pkg;
        }
    }
    return raw || pkg || "—";
}

function resolveDeviceName(historyDeviceId, devices = connectedDevicesCache) {
    const id = String(historyDeviceId || "").trim();
    if (!id) return "";

    const live = findDeviceForHistory(devices, id);
    if (live?.name) return String(live.name).trim();

    // Inclure les appareils hors ligne (noms custom déjà appliqués côté main).
    const all = typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [];
    const any = (Array.isArray(all) ? all : []).find((device) =>
        device?.deviceId === id
        || device?.serial === id
        || device?.usbSerial === id
        || device?.wifiSerial === id
    );
    if (any?.name) return String(any.name).trim();

    return id;
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

function areAppLogosEnabled() {
    return !window.HubPerformance || window.HubPerformance.isEnabled("appLogos");
}

function renderLauncherAppIcon(app) {
    const iconSrc = areAppLogosEnabled() ? (app.iconUrl || app.iconPath) : null;
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
    if (!areAppLogosEnabled()) return;
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

    // Permet une nouvelle passe sur les apps encore sans logo (échecs cache / heuristiques).
    for (const app of orderedApps) {
        if (!app.iconUrl && !app.iconPath) {
            prefetchedAppKeys.delete(buildAppKey(app));
        }
    }

    // Priorité UI : premières apps visibles.
    requestAppsMetadataPrefetch(orderedApps.slice(0, VISIBLE_PREFETCH_COUNT), { priority: "high" });

    // Reste du catalogue en fond — après le batch visible (évite course IPC).
    const backgroundApps = orderedApps.slice(VISIBLE_PREFETCH_COUNT);
    if (backgroundApps.length) {
        setTimeout(() => {
            requestAppsMetadataPrefetch(backgroundApps, { priority: "normal" });
        }, 0);
    }

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

function formatLauncherAppMeta(app = {}) {
    const isVariant = app.variantType === "clone" || app.variantType === "duplicate";
    const userId = app.userId === undefined || app.userId === null ? null : Number(app.userId);
    const hasProfile = userId !== null && (isVariant || userId !== 0);
    if (!isVariant && !hasProfile) return "";

    const parts = [];
    if (userId !== null && (isVariant || userId !== 0)) {
        parts.push(t("newSession.profile", { userId }));
    } else if (app.variantType === "clone") {
        parts.push(t("newSession.cloneLabel"));
    } else if (app.variantType === "duplicate") {
        parts.push(t("newSession.duplicateLabel"));
    }
    if (app.package) parts.push(String(app.package));
    return parts.join(" · ");
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
        const meta = formatLauncherAppMeta(app);
        const metaHtml = meta
            ? `<span class="new-instance-app-package">${escapeHtml(meta)}</span>`
            : "";
        return `
        <button type="button" class="new-instance-app-item ${variantClass}${isSelected ? " selected" : ""}" data-app-key="${buildAppKey(app)}">
            ${renderLauncherAppIcon(app)}
            <span class="new-instance-app-main">
                <span class="new-instance-app-name">${escapeHtml(label)}</span>
                ${metaHtml}
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
        btn.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const app = launcherApps.find((entry) => buildAppKey(entry) === btn.dataset.appKey);
            if (!app || !selectedDevice) return;
            void showAppPinContextMenu(event, {
                deviceId: selectedDevice.deviceId || selectedDevice.serial,
                packageName: app.package,
                appName: getAppLabel(app),
                userId: app.userId ?? null,
                iconPath: app.iconPath || null,
                iconUrl: app.iconUrl || null
            });
        });
    });

    setupLauncherIconPrefetch(appResults, apps);
}

async function isAppPinnedOnHome(entry) {
    if (window.isHomeAppPinned) {
        return Boolean(window.isHomeAppPinned(entry));
    }
    if (window.hubModalWindowAPI?.invokeMain) {
        try {
            const response = await window.hubModalWindowAPI.invokeMain("isHomeAppPinned", [entry]);
            return Boolean(response?.success && response?.result);
        } catch (_err) {
            return false;
        }
    }
    return false;
}

async function showAppPinContextMenu(event, entry) {
    if (!window.namesAPI?.showContextMenu || !entry?.deviceId || !entry?.packageName) return;
    const pinned = await isAppPinnedOnHome(entry);
    void window.namesAPI.showContextMenu({
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        target: {
            kind: "app",
            deviceId: entry.deviceId,
            packageName: entry.packageName,
            appName: entry.appName || entry.packageName,
            userId: entry.userId ?? null,
            iconPath: entry.iconPath || null,
            iconUrl: entry.iconUrl || null,
            pinned
        }
    });
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
    if (!historyList) return null;
    if (historyAppList) return historyAppList;

    const ListCtor = typeof AppList !== "undefined" ? AppList : window.AppList;
    if (!ListCtor) {
        console.error("[NewSession] AppList unavailable");
        return null;
    }

    historyList.classList.add("app-list");
    historyAppList = new ListCtor(historyList, {
        mode: "history",
        emptyMessage: t("newSession.noHistory"),
        noResultsMessage: t("newSession.noSearchResults"),
        sortAlphabetically: false,
        searchInput: historySearchInput || null,
        itemClassName: "app-list-item new-instance-history-item",
        itemTag: "div",
        getItemKey: (entry) => entry.key || buildAppKey({ package: entry.packageName, userId: entry.userId }),
        getAppName: (entry) => getHistoryAppLabel(entry),
        getPackageName: (entry) => entry.packageName,
        getIconSrc: (entry) => {
            if (!areAppLogosEnabled()) return null;
            return entry.iconUrl || entry.iconPath || null;
        },
        getTipAttrs: (entry) => historyTipAttrs(
            getHistoryAppLabel(entry),
            resolveDeviceName(entry.deviceId),
            resolveDeviceColorHex(entry.deviceId)
        ),
        getDeviceColor: (entry) => resolveDeviceColorHex(entry.deviceId),
        renderTip: (entry) => buildAppLaunchTipHtml(
            getHistoryAppLabel(entry),
            resolveDeviceName(entry.deviceId),
            resolveDeviceColorHex(entry.deviceId)
        ),
        renderMeta: (entry) => {
            const parts = [escapeHtml(resolveDeviceName(entry.deviceId))];
            if (Number.isInteger(entry.userId) && entry.userId !== 0) {
                parts.push(escapeHtml(t("newSession.profile", { userId: entry.userId })));
            }
            parts.push(escapeHtml(formatHistoryDate(entry.lastLaunchedAt)));
            if (entry.launchCount > 1) {
                parts.push(escapeHtml(t("newSession.launchCount", { count: entry.launchCount })));
            }
            return `<span class="app-list-item-meta">${parts.join(" • ")}</span>`;
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

    historyList.addEventListener("contextmenu", (event) => {
        if (event.target.closest(".new-instance-history-delete")) return;
        const itemEl = event.target.closest(".new-instance-history-item");
        if (!itemEl || !historyList.contains(itemEl)) return;
        const entry = historyEntries.find((item) => {
            const key = item.key || buildAppKey({ package: item.packageName, userId: item.userId });
            return key === itemEl.dataset.itemKey;
        });
        if (!entry) return;
        event.preventDefault();
        event.stopPropagation();
        void showAppPinContextMenu(event, {
            deviceId: entry.deviceId,
            packageName: entry.packageName,
            appName: entry.appName,
            userId: entry.userId ?? null,
            iconPath: entry.iconPath || null,
            iconUrl: entry.iconUrl || null
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
        if (!iconSrc || !areAppLogosEnabled()) return;

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

function resolveDeviceColorHex(deviceId, devices = connectedDevicesCache) {
    const id = String(deviceId || "").trim();
    if (!id) return "";
    const live = findDeviceForHistory(devices, id);
    if (live?.deviceColor?.hex) return String(live.deviceColor.hex);
    return "";
}

async function resolveDeviceColorHexAsync(deviceId) {
    const id = String(deviceId || "").trim();
    if (!id) return "";

    const candidates = new Set([id]);
    const live = findDeviceForHistory(connectedDevicesCache, id);
    if (live) {
        [live.deviceId, live.serial, live.usbSerial, live.wifiSerial]
            .filter(Boolean)
            .forEach((key) => candidates.add(String(key)));
    }

    if (window.deviceColorsAPI?.get) {
        for (const key of candidates) {
            try {
                const response = await window.deviceColorsAPI.get({ deviceId: key });
                if (response?.deviceColor?.hex) return String(response.deviceColor.hex);
            } catch (_err) {
                /* try next key */
            }
        }
    }

    return resolveDeviceColorHex(id);
}

function formatAppDeviceTipLabel(_appName, deviceName) {
    return String(deviceName || "").trim();
}

function historyTipAttrs(appName, deviceName, colorHex) {
    const label = formatAppDeviceTipLabel(appName, deviceName);
    if (!label) return "";
    const color = /^#[0-9A-Fa-f]{6}$/.test(String(colorHex || "").trim())
        ? String(colorHex).trim()
        : "";
    return ` data-dock-tip="${escapeHtml(label)}"${color ? ` data-dock-tip-color="${escapeHtml(color)}"` : ""}`;
}

function buildAppLaunchTipHtml(appName, deviceName, colorHex) {
    const label = formatAppDeviceTipLabel(appName, deviceName);
    if (!label) return "";
    const color = /^#[0-9A-Fa-f]{6}$/.test(String(colorHex || "").trim())
        ? String(colorHex).trim()
        : "";
    const pillStyle = color ? ` style="background:${escapeHtml(color)}"` : "";
    return (
        `<span class="app-launch-tip" aria-hidden="true">` +
        `<span class="app-launch-tip-pill"${pillStyle}></span>` +
        `<span class="app-launch-tip-title">${escapeHtml(label)}</span>` +
        `</span>`
    );
}

async function resolveDeviceDisplayNameAsync(deviceId) {
    const id = String(deviceId || "").trim();
    if (!id) return "";

    const syncName = resolveDeviceName(id);
    if (syncName && syncName !== id) return syncName;

    const live = findDeviceForHistory(connectedDevicesCache, id)
        || (typeof window.getCurrentDevices === "function"
            ? (window.getCurrentDevices() || []).find((device) =>
                device?.deviceId === id
                || device?.serial === id
                || device?.usbSerial === id
                || device?.wifiSerial === id
            )
            : null);

    const candidates = [id];
    if (live) {
        [live.deviceId, live.serial, live.usbSerial, live.wifiSerial]
            .filter(Boolean)
            .forEach((key) => {
                if (!candidates.includes(String(key))) candidates.push(String(key));
            });
    }

    if (window.namesAPI?.getDeviceInfo) {
        for (const key of candidates) {
            try {
                const info = await window.namesAPI.getDeviceInfo({
                    serial: key,
                    fallbackName: live?.name || live?.originalName || key
                });
                const custom = String(info?.customName || "").trim();
                if (custom) return custom;
                const name = String(info?.name || "").trim();
                if (name && name !== key && name !== id) return name;
                if (info?.hasCustomName && name) return name;
            } catch (_err) {
                /* try next */
            }
        }
    }

    return syncName || id;
}

function renderHistoryList() {
    renderRecentsStrip();
    syncHistoryExpandedUi();
    const list = createHistoryAppList();
    if (!list) return;
    list.setItems(historyEntries);
    list.syncSearchFromInput();
    void enrichHistoryTipColors();
}

async function enrichHistoryTipColors() {
    const nodes = document.querySelectorAll(
        ".ni-recent-card[data-device-id], .new-instance-history-item[data-device-id]"
    );
    if (!nodes.length) return;

    const ids = [...new Set(Array.from(nodes).map((node) => node.dataset.deviceId).filter(Boolean))];
    const colorById = {};
    const nameById = {};
    await Promise.all(ids.map(async (deviceId) => {
        colorById[deviceId] = await resolveDeviceColorHexAsync(deviceId);
        nameById[deviceId] = await resolveDeviceDisplayNameAsync(deviceId);
    }));

    nodes.forEach((node) => {
        const color = colorById[node.dataset.deviceId] || "";
        const deviceName = nameById[node.dataset.deviceId] || "";
        if (color) node.setAttribute("data-dock-tip-color", color);
        else node.removeAttribute("data-dock-tip-color");
        if (deviceName) {
            node.setAttribute("data-dock-tip", deviceName);
            node.setAttribute("aria-label", deviceName);
        }

        const pill = node.querySelector(".app-launch-tip-pill");
        if (pill) {
            if (color) pill.style.background = color;
            else pill.style.removeProperty("background");
        }
        const tipTitle = node.querySelector(".app-launch-tip-title");
        if (tipTitle && deviceName) tipTitle.textContent = deviceName;
        const iconPill = node.querySelector(".home-app-device-pill");
        if (iconPill) {
            if (color) iconPill.style.background = color;
            else iconPill.style.removeProperty("background");
        }

        // Mettre à jour le libellé appareil visible (pas seulement l’infobulle).
        if (deviceName) {
            const meta = node.querySelector(".app-list-item-meta, .ni-recent-card-meta");
            if (meta) {
                const parts = String(meta.textContent || "").split(" • ").map((p) => p.trim()).filter(Boolean);
                if (parts.length) {
                    parts[0] = deviceName;
                    meta.textContent = parts.join(" • ");
                } else {
                    meta.textContent = deviceName;
                }
            }
        }
    });
}

function setHistoryExpanded(next) {
    historyExpanded = Boolean(next);
    syncHistoryExpandedUi();
    if (!historyExpanded) return;
    try {
        const list = createHistoryAppList();
        if (!list) {
            const { historyList } = getNewInstanceElements();
            if (historyList) {
                historyList.innerHTML = `<p class="apps-loading">${escapeHtml(t("newSession.noHistory"))}</p>`;
            }
            return;
        }
        list.setItems(historyEntries);
        list.syncSearchFromInput();
        void enrichHistoryTipColors();
    } catch (err) {
        console.error("[NewSession] setHistoryExpanded:", err);
        const { historyList } = getNewInstanceElements();
        if (historyList) {
            historyList.innerHTML = `<p class="apps-loading">${escapeHtml(err.message || t("newSession.noHistory"))}</p>`;
        }
    }
}

function formatHistoryEntryMeta(entry = {}, { includeTime = true, forceProfile = false } = {}) {
    const parts = [];
    if (Number.isInteger(entry.userId) && (forceProfile || entry.userId !== 0)) {
        parts.push(t("newSession.profile", { userId: entry.userId }));
    }
    if (includeTime) {
        const timeLabel = formatRelativeTime(entry.lastLaunchedAt);
        if (timeLabel) parts.push(timeLabel);
    }
    return parts.join(" · ");
}

function renderRecentsStrip() {
    const { recentsStrip, historyToggle } = getNewInstanceElements();
    if (!recentsStrip) return;

    const entries = Array.isArray(historyEntries) ? historyEntries : [];
    if (historyToggle) {
        historyToggle.hidden = entries.length === 0;
    }

    if (!entries.length) {
        recentsStrip.innerHTML = "";
        recentsStrip.dataset.empty = t("newSession.noHistory");
        return;
    }

    delete recentsStrip.dataset.empty;
    const visible = entries.slice(0, RECENTS_STRIP_LIMIT);
    const labelCounts = visible.reduce((acc, entry) => {
        const label = getHistoryAppLabel(entry);
        acc[label] = (acc[label] || 0) + 1;
        return acc;
    }, {});

    recentsStrip.innerHTML = visible.map((entry, index) => {
        const name = getHistoryAppLabel(entry);
        const forceProfile = (labelCounts[name] || 0) > 1;
        const meta = escapeHtml(formatHistoryEntryMeta(entry, { forceProfile }));
        const safeName = escapeHtml(name);
        const deviceName = resolveDeviceName(entry.deviceId);
        const colorHex = resolveDeviceColorHex(entry.deviceId);
        const tipHtml = buildAppLaunchTipHtml(name, deviceName, colorHex);
        const tipAttrs = historyTipAttrs(name, deviceName, colorHex);
        const pillHtml = colorHex
            ? `<span class="home-app-device-pill device-color-pill" style="background:${escapeHtml(colorHex)}" aria-hidden="true"></span>`
            : "";
        const iconSrc = areAppLogosEnabled() ? (entry.iconUrl || entry.iconPath) : null;
        const icon = iconSrc
            ? `<span class="ni-recent-card-icon"><img src="${escapeHtml(iconSrc)}" alt="" loading="lazy">${pillHtml}</span>`
            : `<span class="ni-recent-card-icon">${DEFAULT_APP_ICON_SVG}${pillHtml}</span>`;
        const profileClass = Number.isInteger(entry.userId) && (forceProfile || entry.userId !== 0)
            ? " ni-recent-card--profile"
            : "";
        return `
            <button type="button" class="ni-recent-card${profileClass}" data-recent-index="${index}" data-device-id="${escapeHtml(entry.deviceId || "")}"${tipAttrs} aria-label="${escapeHtml(deviceName || name)}">
                ${icon}
                <span class="ni-recent-card-name">${safeName}</span>
                <span class="ni-recent-card-meta">${meta}</span>
                ${tipHtml}
            </button>
        `;
    }).join("");

    recentsStrip.querySelectorAll(".ni-recent-card").forEach((btn) => {
        btn.addEventListener("click", () => {
            const entry = visible[Number(btn.dataset.recentIndex)];
            if (!entry) return;
            selectFromHistory({
                deviceId: entry.deviceId,
                packageName: entry.packageName,
                appName: entry.appName,
                userId: entry.userId ?? null,
                iconPath: entry.iconPath || null,
                iconUrl: entry.iconUrl || null
            });
        });
    });
}

function syncHistoryExpandedUi() {
    const { body, historyExpandedPanel, historyToggle, recentsStrip } = getNewInstanceElements();
    if (body) body.classList.toggle("is-history-expanded", historyExpanded);
    if (historyExpandedPanel) historyExpandedPanel.hidden = !historyExpanded;
    if (recentsStrip) recentsStrip.hidden = historyExpanded;
    if (historyToggle) {
        const label = historyToggle.querySelector("span") || historyToggle;
        label.textContent = historyExpanded ? t("newSession.showLess") : t("newSession.showAll");
    }
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

function normalizePreviewParams(params) {
    if (typeof StreamParams !== "undefined" && StreamParams.normalizeParams && params) {
        return StreamParams.normalizeParams(params);
    }
    return {
        width: params?.width ?? 1920,
        height: params?.height ?? 1080,
        dpi: params?.dpi ?? 240,
        maxFps: params?.maxFps ?? 60,
        bitRateMbps: params?.bitRateMbps ?? 8,
        iFrameInterval: params?.iFrameInterval ?? 1,
        videoCodec: params?.videoCodec ?? "h264"
    };
}

function resolvePreviewNewDisplay(params) {
    if (typeof StreamParams !== "undefined" && StreamParams.formatNewDisplay && params) {
        return StreamParams.formatNewDisplay(params);
    }
    if (params?.width && params?.height) {
        return params.dpi
            ? `${params.width}x${params.height}/${params.dpi}`
            : `${params.width}x${params.height}`;
    }
    return "1920x1080/240";
}

function formatTypeBLaunchCommand(packageName, params) {
    const pkg = packageName || "";
    const p = normalizePreviewParams(params);
    const newDisplay = resolvePreviewNewDisplay(p);
    const parts = [
        "scrcpy",
        `--new-display=${newDisplay}`,
        `--max-fps=${p.maxFps}`,
        `--video-bit-rate=${p.bitRateMbps}M`
    ];
    if (p.videoCodec === "h265") {
        parts.push("--video-codec=h265");
    }
    parts.push("--stay-awake", `--start-app=${pkg}`);
    return parts.join(" ");
}

async function updateCommandPreview() {
    const { commandPreview } = getNewInstanceElements();
    if (!commandPreview) return;
    const params = await resolveDefaultLaunchStreamParams({
        serial: selectedDevice?.serial,
        device: selectedDevice
    });
    commandPreview.textContent = formatTypeBLaunchCommand(selectedApp?.package || "", params);
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
        void updateCommandPreview();
        return;
    }

    if (!hasApp) {
        launchHint.textContent = t("newSession.selectApp");
        void updateCommandPreview();
        return;
    }

    launchHint.textContent = t("newSession.readyToLaunch");
    void updateCommandPreview();
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
        const isWifi = d.transport === "wifi" || String(d.transportLabel || "").toLowerCase().includes("wifi");
        const transport = d.transportLabel || (isWifi ? t("devicesPanel.wifi") : t("devicesPanel.usb"));
        const metaParts = [];
        if (d.androidVersion && d.androidVersion !== "unknown") {
            metaParts.push(`Android ${escapeHtml(d.androidVersion)}`);
        }
        metaParts.push(escapeHtml(transport));
        const actionLabel = isSelected ? t("newSession.connected") : t("newSession.select");
        return `
        <button type="button" class="ni-device-card ${isSelected ? "selected" : ""}" data-serial="${escapeHtml(d.serial)}" data-device-id="${escapeHtml(d.deviceId || d.serial)}" data-name="${escapeHtml(d.name)}">
            <span class="ni-device-card-icon" aria-hidden="true">${isWifi ? DEVICE_WIFI_ICON : DEVICE_USB_ICON}</span>
            <span class="ni-device-card-main">
                <span class="ni-device-card-name">${escapeHtml(d.name)}</span>
                <span class="ni-device-card-meta">${metaParts.join(" • ")}</span>
                <span class="ni-device-card-status"><span class="status-dot"></span>${t("newSession.online")}</span>
            </span>
            <span class="ni-device-card-action">${actionLabel}</span>
        </button>
    `;
    }).join("");

    deviceList.querySelectorAll(".ni-device-card").forEach((btn) => {
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

    window.dispatchEvent(new CustomEvent("launcher-device-selected", {
        detail: { ...selectedDevice }
    }));
    if (typeof window.updateScreenToggle === "function") {
        void window.updateScreenToggle();
    }
    if (typeof window.updateDeviceSpeakerToggle === "function") {
        void window.updateDeviceSpeakerToggle();
    }

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

async function closeNewInstanceSession(sessionId, reason = "unspecified") {
    if (!sessionId) return;

    if (!closeNewInstanceSession._inflight) {
        closeNewInstanceSession._inflight = new Set();
    }
    if (closeNewInstanceSession._inflight.has(sessionId)) {
        console.warn(`[NewSession] close déjà en cours ${sessionId} reason=${reason}`);
        return;
    }
    closeNewInstanceSession._inflight.add(sessionId);

    console.warn(`[NewSession] closeNewInstanceSession ${sessionId} reason=${reason}`);
    scrcpyClosedGraceUntilBySession.delete(sessionId);

    try {
        const entry = newInstanceSessions.get(sessionId);

        // Teardown UI immédiat (même rythme que Type A) — kill device via pipeline/session:close.
        // Pas de force-stop anticipé ici : sinon am force-stop / dumpsys / re-off ×3–4.
        if (entry) {
            try {
                if (entry.player) {
                    try {
                        entry.player.stop();
                    } catch (_err) {
                        // noop
                    }
                }

                if (entry.pipeline) {
                    void entry.pipeline.stop().catch(() => {});
                    entry.pipeline.dispose?.();
                } else if (sessionId.startsWith("new-instance-") && window.electronAPI?.newInstanceStop) {
                    void window.electronAPI.newInstanceStop({ sessionId }).catch(() => {});
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
            void window.electronAPI.newInstanceStop({ sessionId }).catch((err) => {
                console.error(`[NewSession] Erreur arret backend ${sessionId}:`, err);
            });
        }

        if (window.sessionAPI) {
            await window.sessionAPI.close(sessionId);
        }

        if (activeNewInstanceSessionId === sessionId) {
            activeNewInstanceSessionId = null;
        }

        // Toujours se baser sur les BrowserViews restantes (Type A + B), pas seulement
        // la map locale Type B — sinon un miroir restant réapparaît noir / — fps.
        let remaining = [];
        try {
            const listed = await window.sessionAPI?.list?.();
            remaining = (Array.isArray(listed) ? listed : [])
                .filter((session) => session?.sessionId && session.sessionId !== sessionId);
        } catch (_err) {
            remaining = [];
        }

        if (remaining.length > 0) {
            const nextId = remaining[remaining.length - 1].sessionId;
            let activated = false;
            if (typeof activateSessionTab === "function") {
                activated = (await activateSessionTab(nextId)) !== false;
            } else if (nextId.startsWith("new-instance-")) {
                activateNewInstanceSession(nextId);
                activated = true;
            }
            // Filet de sécurité si l’activation a échoué (écran vide évité).
            if (!activated) {
                if (typeof window.goToLaunchHome === "function") {
                    await window.goToLaunchHome();
                } else {
                    window.__hubShowingHome = true;
                    showPage("page-new");
                    document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
                    document.querySelector(".content")?.classList.remove(
                        "content--session-view",
                        "content--session-focused"
                    );
                    if (window.sessionAPI?.suppressView) {
                        await window.sessionAPI.suppressView();
                    }
                }
            }
        } else if (typeof window.goToLaunchHome === "function") {
            await window.goToLaunchHome();
        } else {
            window.__hubShowingHome = true;
            showPage("page-new");
            document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
            document.querySelector(".content")?.classList.remove(
                "content--session-view",
                "content--session-focused"
            );
            if (window.sessionAPI?.suppressView) {
                await window.sessionAPI.suppressView();
            }
        }

        if (typeof renderSidebar === "function") {
            await renderSidebar();
        }
    } finally {
        closeNewInstanceSession._inflight.delete(sessionId);
    }
}

function buildTypeBTabLabel(_deviceName, appLabel) {
    const app = String(appLabel || "").trim();
    return app || t("newSession.launchInstance");
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
    const resolvedAppLabel = appLabel || window.AppDisplay?.humanizePackageName?.(packageName) || packageName;
    const tabLabel = buildTypeBTabLabel(deviceName, resolvedAppLabel);
    const resolvedStableId = stableDeviceId || selectedDevice?.deviceId || null;
    const launchIdentity = {
        serial,
        stableDeviceId: resolvedStableId,
        packageName,
        userId: normalizedUserId
    };
    const launchKey = buildTypeBLaunchKey(launchIdentity);

    const existingLocal = findOpenTypeBSessionLocal(launchIdentity);
    if (existingLocal?.sessionId) {
        await focusExistingTypeBSession(existingLocal.sessionId, resolvedAppLabel);
        return { skipped: true, reason: "already-open", sessionId: existingLocal.sessionId };
    }

    const existingListed = await findOpenTypeBSessionFromList(launchIdentity);
    if (existingListed?.sessionId) {
        await focusExistingTypeBSession(existingListed.sessionId, resolvedAppLabel);
        return { skipped: true, reason: "already-open", sessionId: existingListed.sessionId };
    }

    if (launchKey && typeBLaunchInFlightKeys.has(launchKey)) {
        setStatus(t("newSession.launchInProgress", { appLabel: resolvedAppLabel }), true);
        return { skipped: true, reason: "launch-in-progress" };
    }
    if (launchKey) {
        typeBLaunchInFlightKeys.add(launchKey);
    }

    try {
        let latencyTraceId = null;
        if (window.LaunchLatency?.markClick) {
            const started = await window.LaunchLatency.markClick("B");
            latencyTraceId = started.traceId;
        }

        // Lire le preset default AVANT le bootstrap externe pour que --new-display
        // naisse à la bonne résolution (sinon attach display_id reste collé à 1920x1080).
        const launchContext = {
            serial,
            device: selectedDevice,
            isWifi: isWifiLaunchContext({ serial, device: selectedDevice })
        };
        const launchParams = await resolveDefaultLaunchStreamParams(launchContext);
        const presetScrcpyOpts = (typeof StreamParams !== "undefined" && StreamParams.toScrcpyOptions)
            ? StreamParams.toScrcpyOptions(launchParams, "B")
            : await buildDefaultScrcpyOptions("B", launchContext);
        const bootstrapNewDisplay = presetScrcpyOpts?.newDisplay || null;
        setStatus(`Lancement : ${formatTypeBLaunchCommand(packageName, launchParams)}`);

        const scrcpyLaunch = await window.electronAPI.launchNewInstance(
            serial,
            packageName,
            normalizedUserId,
            latencyTraceId,
            resolvedStableId,
            bootstrapNewDisplay
        );
        if (!scrcpyLaunch?.success) {
            if (scrcpyLaunch?.reason === "already-open" && scrcpyLaunch?.sessionId) {
                await focusExistingTypeBSession(scrcpyLaunch.sessionId, resolvedAppLabel);
                return { skipped: true, reason: "already-open", sessionId: scrcpyLaunch.sessionId };
            }
            if (scrcpyLaunch?.reason === "launch-in-progress") {
                setStatus(t("newSession.launchInProgress", { appLabel: resolvedAppLabel }), true);
                return { skipped: true, reason: "launch-in-progress" };
            }
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

        const streamOptions = {
            ...presetScrcpyOpts,
            stayAwake: true,
            turnScreenOff: false,
            audio: false
        };

        const payload = {
            serial,
            stableDeviceId: resolvedStableId,
            packageName,
            userId: normalizedUserId,
            tabLabel,
            appLabel: resolvedAppLabel,
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
            packageName,
            userId: normalizedUserId,
            stableDeviceId: resolvedStableId
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
            return { success: true, sessionId };
        } catch (err) {
            await closeNewInstanceSession(sessionId, "launch-error");
            throw err;
        }
    } finally {
        if (launchKey) {
            typeBLaunchInFlightKeys.delete(launchKey);
        }
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

    window.dispatchEvent(new CustomEvent("launcher-device-selected", {
        detail: { ...selectedDevice }
    }));
    if (typeof window.updateScreenToggle === "function") {
        void window.updateScreenToggle();
    }
    if (typeof window.updateDeviceSpeakerToggle === "function") {
        void window.updateDeviceSpeakerToggle();
    }

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

    const appLabel = window.AppDisplay?.resolveHistoryAppName
        ? window.AppDisplay.resolveHistoryAppName(
            { appName, packageName },
            [device.name, device.originalName].filter(Boolean)
        )
        : (appName || getAppLabel({ package: packageName, displayName: appName, labelName: appName }));

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
    window.dispatchEvent(new CustomEvent("launcher-device-selected", {
        detail: { ...selectedDevice }
    }));
    if (typeof window.updateScreenToggle === "function") {
        void window.updateScreenToggle();
    }
    if (typeof window.updateDeviceSpeakerToggle === "function") {
        void window.updateDeviceSpeakerToggle();
    }
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

        const scrcpyOpts = await buildDefaultScrcpyOptions("A", {
            serial,
            device: selectedDevice || { serial, transport: options.transport },
            isWifi: isWifiLaunchContext({
                serial,
                device: selectedDevice,
                isWifi: options.isWifi
            })
        });

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
    historyExpanded = false;
    resetLauncherApps();
    historyAppList?.resetSearch();
    setStatus("");
    syncHistoryExpandedUi();
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

    const historyToggle = document.getElementById("new-instance-history-toggle");
    if (historyToggle) {
        historyToggle.addEventListener("click", () => {
            setHistoryExpanded(!historyExpanded);
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
        window.electronAPI.onNewInstanceScrcpyClosed(async ({ sessionId, ignoreScrcpyClosed } = {}) => {
            if (!sessionId) return;

            let summary = null;
            try {
                const listed = await window.electronAPI?.newInstanceList?.();
                const sessions = listed?.sessions || listed || [];
                summary = Array.isArray(sessions)
                    ? sessions.find((s) => s?.sessionId === sessionId)
                    : null;
            } catch (_err) {
                // noop — fallback fermeture classique
            }

            const mainGoneOrStopped = !summary
                || summary.state === "stopped"
                || summary.state === "error";

            // Grace / ignore seulement si la session main est encore vivante (reattach).
            // Si main a déjà supprimé/stopped la session, fermer l'onglet même sous grace
            // locale — sinon BrowserView orpheline (écran noir + — fps).
            if (!mainGoneOrStopped) {
                if (
                    ignoreScrcpyClosed
                    || shouldIgnoreScrcpyClosedLocally(sessionId)
                    || summary.state === "reconnecting"
                    || summary.ignoreScrcpyClosed
                ) {
                    markScrcpyClosedGrace(sessionId);
                    console.warn(
                        `[NewSession] scrcpy-closed ignoré (reattach/grace) ${sessionId} state=${summary.state}`
                    );
                    return;
                }
                console.warn(
                    `[NewSession] scrcpy-closed ignoré — session vivante state=${summary.state} ${sessionId}`
                );
                return;
            }

            scrcpyClosedGraceUntilBySession.delete(sessionId);
            console.log(`[NewSession] Scrcpy ferme, fermeture session ${sessionId}`);
            await closeNewInstanceSession(sessionId, "scrcpy-closed");
        });
    }

    if (window.wifiAPI?.onTransportReattachState && !isHubModalChildWindow()) {
        window.wifiAPI.onTransportReattachState(({ phase } = {}) => {
            if (phase === "start" || phase === "end") {
                markAllTypeBScrcpyClosedGrace(25000);
            }
        });
    }

    if (window.electronAPI?.onStreamRestarting && !isHubModalChildWindow()) {
        window.electronAPI.onStreamRestarting(({ sessionId } = {}) => {
            markScrcpyClosedGrace(sessionId, 25000);
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

    window.addEventListener("performance-prefs-changed", () => {
        const searchValue = document.getElementById("new-instance-app-search-input")?.value || "";
        filterLauncherAppsAndRender(searchValue);
        renderHistoryList();
        renderRecentsStrip();
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

    if (window.deviceColorsAPI?.onUpdated) {
        window.deviceColorsAPI.onUpdated(() => {
            void enrichHistoryTipColors();
        });
    }

    if (window.namesAPI?.onUpdated) {
        window.namesAPI.onUpdated(() => {
            renderHistoryList();
        });
    }

    if (window.displayPresetsAPI?.onUpdated) {
        window.displayPresetsAPI.onUpdated(() => {
            void updateCommandPreview();
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
window.getSelectedLauncherDevice = () => (selectedDevice ? { ...selectedDevice } : null);

if (!isHubModalChildWindow()) {
    window.__hubModalMainActions = {
        launchTypeBSession,
        launchMirrorSession,
        launchFromHistory,
        onMirrorButtonClick,
        setSelectedDeviceForMirror
    };
}
