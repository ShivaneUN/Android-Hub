const fs = require("fs");
const path = require("path");
const { createLocaleApi, SUPPORTED_LOCALES } = require("../../shared/locale");

const DEFAULT_PREFERENCES = {
    locale: "fr",
    sidebarOpen: true,
    streamDeckMode: false,
    displayLayout: "grid",
    focusedDeviceId: null,
    duoDeviceIds: [null, null]
};

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
            return { locale, sidebarOpen, streamDeckMode, displayLayout, focusedDeviceId, duoDeviceIds };
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
            duoDeviceIds: this.getDuoDeviceIds()
        };
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

module.exports = { UiPreferencesManager };
