const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "../src/shared/locales");
fs.mkdirSync(dir, { recursive: true });

const fr = require("./locale-data-fr");
const en = require("./locale-data-en");

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

const frKeys = new Set(collectKeys(fr));
const enKeys = new Set(collectKeys(en));
const missingInEn = [...frKeys].filter((k) => !enKeys.has(k));
const missingInFr = [...enKeys].filter((k) => !frKeys.has(k));
if (missingInEn.length || missingInFr.length) {
    console.error("Key mismatch!");
    console.error("Missing in EN:", missingInEn);
    console.error("Missing in FR:", missingInFr);
    process.exit(1);
}

fs.writeFileSync(path.join(dir, "fr.json"), JSON.stringify(fr, null, 2));
fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(en, null, 2));

const rendererDir = path.join(__dirname, "../src/renderer/locales");
fs.mkdirSync(rendererDir, { recursive: true });
fs.writeFileSync(path.join(rendererDir, "fr.json"), JSON.stringify(fr, null, 2));
fs.writeFileSync(path.join(rendererDir, "en.json"), JSON.stringify(en, null, 2));
console.log(`Wrote ${frKeys.size} keys to fr.json and en.json`);
