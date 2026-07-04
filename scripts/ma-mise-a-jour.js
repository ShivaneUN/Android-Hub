#!/usr/bin/env node
/**
 * Build personnel : compile l'installateur et le copie dans releases/
 * Usage:
 *   node scripts/ma-mise-a-jour.js          # bump patch + build
 *   node scripts/ma-mise-a-jour.js --no-bump
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const noBump = args.includes("--no-bump");

function run(cmd) {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true, windowsHide: true });
}

function killLockingProcesses() {
    if (process.platform !== "win32") return;
    for (const name of ["Android Hub", "electron", "adb"]) {
        try {
            execSync(`taskkill /F /IM "${name}.exe" /T 2>nul`, { stdio: "ignore", shell: true });
        } catch (_err) {
            // noop
        }
    }
}

console.log("\n=== Android Hub — build perso ===\n");

killLockingProcesses();

if (!noBump) {
    console.log("Incrément version (patch)...");
    run("npm version patch --no-git-tag-version");
}

const releasesDir = path.join(ROOT, "releases");
fs.mkdirSync(releasesDir, { recursive: true });

run("npm run build");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const setupName = `Android Hub-Setup-${pkg.version}.exe`;
const setupPath = path.join(ROOT, "dist", setupName);

if (!fs.existsSync(setupPath)) {
    console.error(`ERREUR: introuvable ${setupPath}`);
    process.exit(1);
}

const destVersioned = path.join(releasesDir, setupName);
const destLatest = path.join(releasesDir, "Android Hub-Setup-dernier.exe");

fs.copyFileSync(setupPath, destVersioned);
fs.copyFileSync(setupPath, destLatest);

console.log(`\nOK — v${pkg.version}`);
console.log(`  releases\\Android Hub-Setup-dernier.exe\n`);
