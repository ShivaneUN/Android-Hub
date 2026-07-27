const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "../src/shared/locales");
fs.mkdirSync(dir, { recursive: true });

const fr = require("./locale-data-fr");
const en = require("./locale-data-en");

/** Top-level sections that must never disappear from locale-data. */
const LOCKED_SECTIONS = [
    "apps",
    "colors",
    "contextMenu",
    "controlPanel",
    "devicePanel",
    "devicesPanel",
    "emptyState",
    "help",
    "homeDashboard",
    "hubModal",
    "maintenance",
    "newSession",
    "rename",
    "settingsPanel",
    "sidebar",
    "streamDeck",
    "titlebar",
    "toggles",
    "uiTheme",
    "update"
];

/** Specific keys that must always resolve (dock tips, home, etc.). */
const LOCKED_KEYS = [
    "settingsPanel.tabHomeShortcuts",
    "sidebar.home",
    "sidebar.settings",
    "sidebar.help",
    "sidebar.newInstance",
    "sidebar.screen",
    "sidebar.portrait",
    "sidebar.audio",
    "sidebar.language",
    "sidebar.devicePanel.audioToggle",
    "sidebar.devicePanel.flyoutMuted",
    "sidebar.devicePanel.flyoutAudioOn",
    "sidebar.devicePanel.flyoutWifi",
    "homeDashboard.activeSessions",
    "homeDashboard.recentApps",
    "homeDashboard.noSessions",
    "uiTheme.classicTitle",
    "uiTheme.tabletTitle",
    "contextMenu.lock",
    "contextMenu.unlock",
    "contextMenu.lockGroup",
    "contextMenu.unlockGroup",
    "devicePanel.usbUnpluggedTitle",
    "settingsPanel.manualCleanup",
    "settingsPanel.maintCacheDesc"
];

function collectKeys(obj, prefix = "") {
    const keys = [];
    for (const [key, value] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object" && !Array.isArray(value)) {
            keys.push(...collectKeys(value, full));
        } else {
            keys.push(full);
        }
    }
    return keys;
}

function getNested(obj, key) {
    return key.split(".").reduce((current, part) => {
        if (current && Object.prototype.hasOwnProperty.call(current, part)) {
            return current[part];
        }
        return undefined;
    }, obj);
}

function loadExistingJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
        console.warn(`Could not parse existing locale file ${filePath}:`, err.message);
        return null;
    }
}

const frKeys = new Set(collectKeys(fr));
const enKeys = new Set(collectKeys(en));
const missingInEn = [...frKeys].filter((k) => !enKeys.has(k));
const missingInFr = [...enKeys].filter((k) => !frKeys.has(k));
if (missingInEn.length || missingInFr.length) {
    console.error("Key mismatch between locale-data-fr and locale-data-en!");
    console.error("Missing in EN:", missingInEn);
    console.error("Missing in FR:", missingInFr);
    process.exit(1);
}

const missingSectionsFr = LOCKED_SECTIONS.filter((section) => !(section in fr));
const missingSectionsEn = LOCKED_SECTIONS.filter((section) => !(section in en));
if (missingSectionsFr.length || missingSectionsEn.length) {
    console.error("Locked locale sections missing from locale-data!");
    console.error("Missing in FR:", missingSectionsFr);
    console.error("Missing in EN:", missingSectionsEn);
    process.exit(1);
}

const missingLockedFr = LOCKED_KEYS.filter((key) => getNested(fr, key) === undefined);
const missingLockedEn = LOCKED_KEYS.filter((key) => getNested(en, key) === undefined);
if (missingLockedFr.length || missingLockedEn.length) {
    console.error("Locked locale keys missing from locale-data!");
    console.error("Missing in FR:", missingLockedFr);
    console.error("Missing in EN:", missingLockedEn);
    process.exit(1);
}

const existingFr = loadExistingJson(path.join(dir, "fr.json"));
const existingEn = loadExistingJson(path.join(dir, "en.json"));
const forceDrop = process.argv.includes("--force-drop");

if (!forceDrop && existingFr) {
    const existingKeys = collectKeys(existingFr);
    const dropped = existingKeys.filter((key) => !frKeys.has(key));
    if (dropped.length) {
        console.error("Refusing to drop existing locale keys. Add them to locale-data-*.js first.");
        console.error(`Would drop ${dropped.length} key(s):`);
        dropped.slice(0, 50).forEach((key) => console.error(`  - ${key}`));
        if (dropped.length > 50) console.error(`  … and ${dropped.length - 50} more`);
        console.error("Re-run with --force-drop only if intentional.");
        process.exit(1);
    }
}

if (!forceDrop && existingEn) {
    const existingKeys = collectKeys(existingEn);
    const dropped = existingKeys.filter((key) => !enKeys.has(key));
    if (dropped.length) {
        console.error("Refusing to drop existing EN locale keys. Add them to locale-data-*.js first.");
        console.error(`Would drop ${dropped.length} key(s):`);
        dropped.slice(0, 50).forEach((key) => console.error(`  - ${key}`));
        if (dropped.length > 50) console.error(`  … and ${dropped.length - 50} more`);
        console.error("Re-run with --force-drop only if intentional.");
        process.exit(1);
    }
}

fs.writeFileSync(path.join(dir, "fr.json"), JSON.stringify(fr, null, 2));
fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(en, null, 2));

const rendererDir = path.join(__dirname, "../src/renderer/locales");
fs.mkdirSync(rendererDir, { recursive: true });
fs.writeFileSync(path.join(rendererDir, "fr.json"), JSON.stringify(fr, null, 2));
fs.writeFileSync(path.join(rendererDir, "en.json"), JSON.stringify(en, null, 2));
console.log(`Wrote ${frKeys.size} keys to fr.json and en.json`);
