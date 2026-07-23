(function initHubI18n() {
    const SUPPORTED = ["fr", "en"];
    let locale = "fr";
    let bundles = { fr: {}, en: {} };
    const listeners = new Set();
    let ready = false;
    let readyPromise = null;

    function getNested(obj, key) {
        return key.split(".").reduce((current, part) => {
            if (current && Object.prototype.hasOwnProperty.call(current, part)) {
                return current[part];
            }
            return undefined;
        }, obj);
    }

    function interpolate(str, vars = {}) {
        if (typeof str !== "string") return str;
        return str.replace(/\{(\w+)\}/g, (_, name) => (
            vars[name] !== undefined ? String(vars[name]) : `{${name}}`
        ));
    }

    function t(key, vars = {}) {
        let value = getNested(bundles[locale], key);
        if (value === undefined && locale !== "fr") {
            value = getNested(bundles.fr, key);
        }
        if (value === undefined) return key;
        if (typeof value === "string") return interpolate(value, vars);
        return value;
    }

    function tArray(key) {
        const value = t(key);
        return Array.isArray(value) ? value : [];
    }

    function tObject(key) {
        const value = t(key);
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function getLocale() {
        return locale;
    }

    function applyDomI18n(root = document) {
        root.querySelectorAll("[data-i18n]").forEach((el) => {
            const key = el.getAttribute("data-i18n");
            if (!key) return;
            let vars = {};
            const varsRaw = el.getAttribute("data-i18n-vars");
            if (varsRaw) {
                try { vars = JSON.parse(varsRaw); } catch (_) { /* ignore */ }
            }
            el.textContent = t(key, vars);
        });
        root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
            const key = el.getAttribute("data-i18n-placeholder");
            if (key) el.placeholder = t(key);
        });
        root.querySelectorAll("[data-i18n-title]").forEach((el) => {
            const key = el.getAttribute("data-i18n-title");
            if (!key) return;
            let vars = {};
            const varsRaw = el.getAttribute("data-i18n-vars");
            if (varsRaw) {
                try { vars = JSON.parse(varsRaw); } catch (_) { /* ignore */ }
            }
            el.title = t(key, vars);
        });
        root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
            const key = el.getAttribute("data-i18n-aria-label");
            if (key) el.setAttribute("aria-label", t(key));
        });
        root.querySelectorAll("[data-i18n-dock-tip]").forEach((el) => {
            const key = el.getAttribute("data-i18n-dock-tip");
            if (!key) return;
            const label = t(key);
            el.dataset.dockTip = label;
            if (!el.hasAttribute("data-i18n-aria-label") && !el.getAttribute("aria-label")) {
                el.setAttribute("aria-label", label);
            }
        });
    }

    function notifyChange() {
        document.documentElement.lang = locale;
        applyDomI18n();
        listeners.forEach((cb) => {
            try { cb(locale); } catch (_) { /* ignore */ }
        });
        window.dispatchEvent(new CustomEvent("hub:locale-changed", { detail: { locale } }));
    }

    async function setLocale(nextLocale) {
        if (!SUPPORTED.includes(nextLocale) || nextLocale === locale) {
            return { success: true, locale };
        }
        if (!window.uiPreferencesAPI?.setLocale) {
            locale = nextLocale;
            notifyChange();
            return { success: true, locale };
        }
        const result = await window.uiPreferencesAPI.setLocale(nextLocale);
        if (result?.success) {
            locale = result.locale;
            notifyChange();
        }
        return result;
    }

    async function toggleLocale() {
        const next = locale === "fr" ? "en" : "fr";
        return setLocale(next);
    }

    function onChange(callback) {
        if (typeof callback === "function") listeners.add(callback);
        return () => listeners.delete(callback);
    }

    async function init() {
        if (ready) return;
        if (readyPromise) return readyPromise;
        readyPromise = (async () => {
            if (window.uiPreferencesAPI?.getLocaleData) {
                const data = await window.uiPreferencesAPI.getLocaleData();
                if (data?.locale && SUPPORTED.includes(data.locale)) {
                    locale = data.locale;
                }
                if (data?.bundles) {
                    bundles = data.bundles;
                }
            }
            ready = true;
            notifyChange();
            window.uiPreferencesAPI?.onLocaleChanged?.((payload) => {
                const next = payload?.locale;
                if (next && SUPPORTED.includes(next) && next !== locale) {
                    locale = next;
                    notifyChange();
                }
            });
        })();
        return readyPromise;
    }

    globalThis.HubI18n = {
        init,
        t,
        tArray,
        tObject,
        getLocale,
        setLocale,
        toggleLocale,
        onChange,
        applyDomI18n
    };
})();
