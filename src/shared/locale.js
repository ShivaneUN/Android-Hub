const fs = require("fs");
const path = require("path");

const SUPPORTED_LOCALES = Object.freeze(["fr", "en"]);
const LOCALES_DIR = path.join(__dirname, "locales");
const bundleCache = new Map();

function loadBundle(locale) {
    if (bundleCache.has(locale)) {
        return bundleCache.get(locale);
    }
    const filePath = path.join(LOCALES_DIR, `${locale}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    bundleCache.set(locale, data);
    return data;
}

function clearBundleCache() {
    bundleCache.clear();
}

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

function createLocaleApi(defaultLocale = "fr") {
    let currentLocale = SUPPORTED_LOCALES.includes(defaultLocale) ? defaultLocale : "fr";

    return {
        getLocale() {
            return currentLocale;
        },
        setLocale(locale) {
            if (SUPPORTED_LOCALES.includes(locale)) {
                currentLocale = locale;
            }
        },
        loadBundles() {
            return {
                fr: loadBundle("fr"),
                en: loadBundle("en")
            };
        },
        t(key, vars = {}, locale = currentLocale) {
            let value = getNested(loadBundle(locale), key);
            if (value === undefined && locale !== "fr") {
                value = getNested(loadBundle("fr"), key);
            }
            if (value === undefined) return key;
            if (typeof value === "string") return interpolate(value, vars);
            return value;
        }
    };
}

const COLOR_KEYS = Object.freeze([
    "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "slate"
]);

function getColorLabel(localeApi, colorId) {
    const key = COLOR_KEYS[colorId];
    if (!key || !localeApi) return "";
    return localeApi.t(`colors.${key}`);
}

module.exports = {
    SUPPORTED_LOCALES,
    LOCALES_DIR,
    loadBundle,
    clearBundleCache,
    getNested,
    interpolate,
    createLocaleApi,
    COLOR_KEYS,
    getColorLabel
};
