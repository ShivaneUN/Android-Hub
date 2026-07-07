const fs = require("fs");
const path = require("path");
const { createLocaleApi, SUPPORTED_LOCALES } = require("../../shared/locale");

const DEFAULT_PREFERENCES = {
    locale: "fr",
    sidebarOpen: true
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
            return { locale, sidebarOpen };
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
            sidebarOpen: this.getSidebarOpen()
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

    t(key, vars = {}) {
        return this.localeApi.t(key, vars);
    }
}

module.exports = { UiPreferencesManager };
