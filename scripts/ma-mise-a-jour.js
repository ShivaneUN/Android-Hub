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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanDistUnpack() {
    run("node scripts/clean-dist-unpack.js");
}

function recoverPartialUnpack() {
    const dist = path.join(ROOT, "dist");
    const tmp = path.join(dist, "win-unpacked.tmp");
    const out = path.join(dist, "win-unpacked");
    if (!fs.existsSync(tmp) || fs.existsSync(out)) return;
    try {
        fs.renameSync(tmp, out);
        console.log("Récupéré: dist\\win-unpacked.tmp -> dist\\win-unpacked");
    } catch (_err) {
        try {
            fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
        } catch (_err2) {
            // noop
        }
    }
}

async function runBuildWithRetry(maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1) {
                killLockingProcesses();
                recoverPartialUnpack();
                cleanDistUnpack();
                console.log(`Nouvelle tentative de build (${attempt}/${maxAttempts})...`);
                await sleep(2000);
            }
            run("npm run build");
            return;
        } catch (err) {
            if (attempt === maxAttempts) throw err;
            console.warn(`\nBuild échoué (tentative ${attempt}/${maxAttempts}).`);
        }
    }
}

async function main() {
    console.log("\n=== Android Hub — build perso ===\n");

    killLockingProcesses();
    cleanDistUnpack();

    if (!noBump) {
        console.log("Incrément version (patch)...");
        run("npm version patch --no-git-tag-version");
    }

    const releasesDir = path.join(ROOT, "releases");
    fs.mkdirSync(releasesDir, { recursive: true });

    await runBuildWithRetry();

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
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
