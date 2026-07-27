const fs = require("fs");
const path = require("path");
const { createLocaleApi, SUPPORTED_LOCALES } = require("../../shared/locale");

const DEFAULT_PERFORMANCE_PREFS = {
    performanceMode: false,
    fpsMonitor: true,
    appLogos: true,
    homePreview: true,
    hoverPreview: true,
    dockBatteryLive: true,
    uiAnimations: true,
    sessionTransportSwitch: true
};

const PERFORMANCE_FEATURE_KEYS = [
    "fpsMonitor",
    "appLogos",
    "homePreview",
    "hoverPreview",
    "dockBatteryLive",
    "uiAnimations",
    "sessionTransportSwitch"
];

const DEFAULT_PREFERENCES = {
    locale: "fr",
    sidebarOpen: true,
    streamDeckMode: false,
    displayLayout: "grid",
    focusedDeviceId: null,
    duoDeviceIds: [null, null],
    performance: structuredClone(DEFAULT_PERFORMANCE_PREFS)
};

function normalizePerformancePrefs(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const prefs = { ...DEFAULT_PERFORMANCE_PREFS };
    prefs.performanceMode = source.performanceMode === true;
    for (const key of PERFORMANCE_FEATURE_KEYS) {
        prefs[key] = source[key] !== false;
    }
    return prefs;
}

class UiPreferencesManager {
    constructor(userDataPath) {
        this.preferencesPath = path.join(userDataPath, "ui-preferences.json");
        this.preferences = this.loadPreferences();
        this.localeApi = createLocaleApi(this.preferences.locale);
    }

    loadPreferences() {
        try {
            if (!fs.existsSync(this.preferencesPath)) {
                return structuredClone(DEFAULT_PREFERENCES);
            }
            const parsed = JSON.parse(fs.readFileSync(this.preferencesPath, "utf-8"));
            const locale = SUPPORTED_LOCALES.includes(parsed?.locale) ? parsed.locale : "fr";
            const sidebarOpen = parsed?.sidebarOpen !== false;
            const streamDeckMode = parsed?.streamDeckMode === true;
            const displayLayout = ["grid", "focus", "duo"].includes(parsed?.displayLayout)
                ? parsed.displayLayout
                : "grid";
            const focusedDeviceId = typeof parsed?.focusedDeviceId === "string"
                ? parsed.focusedDeviceId
                : null;
            const duoRaw = Array.isArray(parsed?.duoDeviceIds) ? parsed.duoDeviceIds : [];
            const duoDeviceIds = [
                typeof duoRaw[0] === "string" ? duoRaw[0] : null,
                typeof duoRaw[1] === "string" ? duoRaw[1] : null
            ];
            const performance = normalizePerformancePrefs(parsed?.performance);
            return {
                locale,
                sidebarOpen,
                streamDeckMode,
                displayLayout,
                focusedDeviceId,
                duoDeviceIds,
                performance
            };
        } catch {
            return structuredClone(DEFAULT_PREFERENCES);
        }
    }

    savePreferences() {
        fs.writeFileSync(this.preferencesPath, JSON.stringify(this.preferences, null, 2), "utf-8");
    }

    getLocale() {
        return this.preferences.locale || "fr";
    }

    setLocale(locale) {
        if (!SUPPORTED_LOCALES.includes(locale)) {
            return { success: false, error: "invalid-locale" };
        }
        this.preferences.locale = locale;
        this.localeApi.setLocale(locale);
        this.savePreferences();
        return { success: true, locale };
    }

    getLocaleData() {
        return {
            locale: this.getLocale(),
            bundles: this.localeApi.loadBundles()
        };
    }

    getPreferences() {
        return {
            locale: this.getLocale(),
            sidebarOpen: this.getSidebarOpen(),
            streamDeckMode: this.getStreamDeckMode(),
            displayLayout: this.getDisplayLayout(),
            focusedDeviceId: this.getFocusedDeviceId(),
            duoDeviceIds: this.getDuoDeviceIds(),
            performance: this.getPerformancePrefs()
        };
    }

    getPerformancePrefs() {
        return normalizePerformancePrefs(this.preferences.performance);
    }

    /**
     * @param {Partial<typeof DEFAULT_PERFORMANCE_PREFS>} patch
     */
    setPerformancePrefs(patch = {}) {
        const current = this.getPerformancePrefs();
        const next = { ...current };

        if (Object.prototype.hasOwnProperty.call(patch, "performanceMode")) {
            next.performanceMode = patch.performanceMode === true;
        }

        for (const key of PERFORMANCE_FEATURE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(patch, key)) {
                next[key] = patch[key] !== false;
                // Réactiver une fonction individuelle quitte le mode perf.
                if (next[key] === true && next.performanceMode) {
                    next.performanceMode = false;
                }
            }
        }

        this.preferences.performance = normalizePerformancePrefs(next);
        this.savePreferences();
        return { success: true, performance: this.getPerformancePrefs() };
    }

    isPerformanceFeatureEnabled(key) {
        const prefs = this.getPerformancePrefs();
        if (prefs.performanceMode) return false;
        if (!PERFORMANCE_FEATURE_KEYS.includes(key)) return true;
        return prefs[key] !== false;
    }

    getSidebarOpen() {
        return this.preferences.sidebarOpen !== false;
    }

    setSidebarOpen(open) {
        this.preferences.sidebarOpen = Boolean(open);
        this.savePreferences();
        return { success: true, sidebarOpen: this.preferences.sidebarOpen };
    }

    getDisplayLayout() {
        const layout = this.preferences.displayLayout;
        return ["grid", "focus", "duo"].includes(layout) ? layout : "grid";
    }

    getFocusedDeviceId() {
        return typeof this.preferences.focusedDeviceId === "string"
            ? this.preferences.focusedDeviceId
            : null;
    }

    getDuoDeviceIds() {
        const raw = Array.isArray(this.preferences.duoDeviceIds) ? this.preferences.duoDeviceIds : [];
        return [
            typeof raw[0] === "string" ? raw[0] : null,
            typeof raw[1] === "string" ? raw[1] : null
        ];
    }

    getStreamDeckMode() {
        return this.preferences.streamDeckMode === true;
    }

    setDisplayPreferences({ streamDeckMode, displayLayout, focusedDeviceId, duoDeviceIds } = {}) {
        if (streamDeckMode !== undefined) {
            this.preferences.streamDeckMode = Boolean(streamDeckMode);
        }
        if (displayLayout !== undefined) {
            this.preferences.displayLayout = ["grid", "focus", "duo"].includes(displayLayout)
                ? displayLayout
                : "grid";
        }
        if (focusedDeviceId !== undefined) {
            this.preferences.focusedDeviceId = typeof focusedDeviceId === "string"
                ? focusedDeviceId
                : null;
        }
        if (duoDeviceIds !== undefined) {
            const raw = Array.isArray(duoDeviceIds) ? duoDeviceIds : [];
            this.preferences.duoDeviceIds = [
                typeof raw[0] === "string" ? raw[0] : null,
                typeof raw[1] === "string" ? raw[1] : null
            ];
        }
        this.savePreferences();
        return {
            success: true,
            streamDeckMode: this.getStreamDeckMode(),
            displayLayout: this.getDisplayLayout(),
            focusedDeviceId: this.getFocusedDeviceId(),
            duoDeviceIds: this.getDuoDeviceIds()
        };
    }

    t(key, vars = {}) {
        return this.localeApi.t(key, vars);
    }
}

module.exports = {
    UiPreferencesManager,
    DEFAULT_PERFORMANCE_PREFS,
    PERFORMANCE_FEATURE_KEYS
};
