#!/usr/bin/env node
/**
 * Génère src/shared/update-feed.json avant un build packagé.
 * GH_UPDATE_TOKEN : PAT read-only (Contents: Read) embarqué dans l'app pour repo privé.
 *                   Absent = feed sans auth, le build perso continue normalement.
 * GH_TOKEN        : utilisé par electron-builder pour publier sur GitHub Releases (séparé).
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outPath = path.join(root, "src", "shared", "update-feed.json");
const token = (process.env.GH_UPDATE_TOKEN || "").trim();

const feed = {
    configured: Boolean(token),
    provider: "github",
    owner: "ShivaneUN",
    repo: "Android-Hub",
    private: true
};

if (token) {
    feed.token = token;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(feed, null, 2)}\n`, "utf8");

if (feed.configured) {
    console.log("[generate-update-feed] update-feed.json généré (token présent).");
} else {
    console.warn(
        "[generate-update-feed] GH_UPDATE_TOKEN absent — feed sans auth généré, le build continue normalement."
    );
}
