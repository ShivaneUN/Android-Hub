#!/usr/bin/env node
/**
 * Regénère build/icon.ico et src/assets/icons/icon.ico depuis build/icon.png.
 * Usage: npm run icons
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pngToIco from "png-to-ico";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(ROOT, "build", "icon.png");
const targets = [
    path.join(ROOT, "build", "icon.ico"),
    path.join(ROOT, "src", "assets", "icons", "icon.ico"),
];

const buf = await pngToIco(source);
for (const dest of targets) {
    fs.writeFileSync(dest, buf);
}
console.log(`OK — ${targets.length} fichiers ICO générés depuis build/icon.png`);
