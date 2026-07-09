#!/usr/bin/env node
/**
 * Supprime dist/win-unpacked* avant un build electron-builder.
 * Évite EPERM sur Windows quand un dossier partiel ou verrouillé reste de la build précédente.
 */
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "..", "dist");

for (const name of ["win-unpacked", "win-unpacked.tmp"]) {
    const target = path.join(dist, name);
    if (!fs.existsSync(target)) continue;
    try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
        console.log(`Supprimé: dist\\${name}`);
    } catch (err) {
        console.warn(`Impossible de supprimer dist\\${name}: ${err.message}`);
        process.exitCode = 1;
    }
}
