/**
 * Préférences Performances — appliquées à chaud sur la fenêtre principale.
 */
(function initPerformancePrefs() {
    const FEATURE_KEYS = [
        "fpsMonitor",
        "appLogos",
        "homePreview",
        "hoverPreview",
        "dockBatteryLive",
        "uiAnimations",
        "sessionTransportSwitch"
    ];

    const DEFAULT_PREFS = {
        performanceMode: false,
        fpsMonitor: true,
        appLogos: true,
        homePreview: true,
        hoverPreview: true,
        dockBatteryLive: true,
        uiAnimations: true,
        sessionTransportSwitch: true
    };

    let cachedPrefs = { ...DEFAULT_PREFS };
    let ready = false;

    function normalizePrefs(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const prefs = { ...DEFAULT_PREFS };
        prefs.performanceMode = source.performanceMode === true;
        for (const key of FEATURE_KEYS) {
            prefs[key] = source[key] !== false;
        }
        return prefs;
    }

    function isEnabled(key) {
        if (cachedPrefs.performanceMode) return false;
        if (!FEATURE_KEYS.includes(key)) return true;
        return cachedPrefs[key] !== false;
    }

    function getPrefs() {
        return { ...cachedPrefs };
    }

    function applyDomFlags() {
        const body = document.body;
        if (!body) return;
        body.classList.toggle("perf-reduce-motion", !isEnabled("uiAnimations"));
        body.classList.toggle("perf-hide-fps", !isEnabled("fpsMonitor"));
        body.classList.toggle("perf-no-app-logos", !isEnabled("appLogos"));
    }

    function applyFpsMonitor() {
        if (isEnabled("fpsMonitor")) {
            window.startFpsMonitor?.();
        } else {
            window.stopFpsMonitor?.();
            document.querySelectorAll(".tab-fps").forEach((badge) => {
                badge.textContent = "— fps";
                badge.classList.remove("active-stream");
            });
            document.querySelectorAll("[data-session-fps]").forEach((badge) => {
                badge.textContent = "— fps";
            });
        }
    }

    function applyHomePreview() {
        if (isEnabled("homePreview")) {
            if (typeof window.syncHomeSessions === "function") {
                void window.syncHomeSessions();
            }
        } else {
            window.stopHomePreviewPolling?.();
        }
    }

    function applyHoverPreview() {
        if (!isEnabled("hoverPreview")) {
            window.videoPreviewHook?.hide?.();
        }
    }

    function applyDockBatteries() {
        if (typeof window.syncDockBatteries === "function") {
            void window.syncDockBatteries();
        }
    }

    function applyAppLogos() {
        if (typeof window.syncRecentApps === "function") {
            void window.syncRecentApps();
        }
        window.dispatchEvent(new CustomEvent("performance-prefs-changed", {
            detail: getPrefs()
        }));
    }

    function applyPerformancePrefs(prefs) {
        cachedPrefs = normalizePrefs(prefs);
        ready = true;
        applyDomFlags();
        applyFpsMonitor();
        applyHomePreview();
        applyHoverPreview();
        applyDockBatteries();
        applyAppLogos();
        return getPrefs();
    }

    async function loadPerformancePrefs() {
        try {
            if (window.uiPreferencesAPI?.getPerformancePrefs) {
                const prefs = await window.uiPreferencesAPI.getPerformancePrefs();
                return applyPerformancePrefs(prefs);
            }
        } catch (_err) {
            /* ignore */
        }
        return applyPerformancePrefs(DEFAULT_PREFS);
    }

    async function setPerformancePrefs(patch = {}) {
        if (window.uiPreferencesAPI?.setPerformancePrefs) {
            const result = await window.uiPreferencesAPI.setPerformancePrefs(patch);
            if (result?.success && result.performance) {
                return applyPerformancePrefs(result.performance);
            }
            if (!result?.success) {
                window.showHubToast?.(
                    result?.error
                    || globalThis.HubI18n?.t?.("settingsPanel.performanceSaveFailed")
                    || "Impossible d’enregistrer.",
                    "error"
                );
                return null;
            }
        }
        return applyPerformancePrefs({ ...cachedPrefs, ...patch });
    }

    async function setPerformanceMode(enabled) {
        return setPerformancePrefs({ performanceMode: Boolean(enabled) });
    }

    async function setPerformanceFeature(key, enabled) {
        if (!FEATURE_KEYS.includes(key)) return getPrefs();
        return setPerformancePrefs({ [key]: Boolean(enabled) });
    }

    window.HubPerformance = {
        FEATURE_KEYS,
        DEFAULT_PREFS,
        isReady: () => ready,
        getPrefs,
        isEnabled,
        applyPerformancePrefs,
        loadPerformancePrefs,
        setPerformancePrefs,
        setPerformanceMode,
        setPerformanceFeature
    };

    window.__hubModalMainActions = {
        ...(window.__hubModalMainActions || {}),
        getPerformancePrefs: getPrefs,
        setPerformancePrefs: async (patch) => setPerformancePrefs(patch),
        setPerformanceMode: async (enabled) => setPerformanceMode(enabled),
        setPerformanceFeature: async (key, enabled) => setPerformanceFeature(key, enabled)
    };

    function boot() {
        void loadPerformancePrefs();
        window.uiPreferencesAPI?.onPerformanceChanged?.((payload) => {
            if (payload?.performance) {
                applyPerformancePrefs(payload.performance);
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
