#!/usr/bin/env node
/**
 * Supprime dist/win-unpacked* avant un build electron-builder.
 * Évite EPERM sur Windows quand un dossier partiel ou verrouillé reste de la build précédente.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
    markerPath,
    setAlternateOutputDir,
    clearAlternateOutputDir
} = require("./build-output-dir");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const repoAdbPath = path.join(root, "tools", "adb.exe");
const STALE_BUILD_MAX_AGE_MS = 3 * 60 * 60 * 1000;

function killByImageName(imageName) {
    try {
        execSync(`taskkill /F /IM "${imageName}.exe" /T 2>nul`, {
            stdio: "ignore",
            shell: true,
            windowsHide: true
        });
    } catch (_err) {
        // noop
    }
}

function killRepoAdbProcesses() {
    const ps = [
        "$target = [System.IO.Path]::GetFullPath($args[0])",
        "Get-CimInstance Win32_Process -Filter \"Name='adb.exe'\" | ForEach-Object {",
        "  if ($_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target)) {",
        "    taskkill /F /PID $_.ProcessId /T 2>$null",
        "  }",
        "}"
    ].join("; ");
    try {
        execSync(`powershell -NoProfile -NonInteractive -Command "${ps}" "${repoAdbPath}"`, {
            stdio: "ignore",
            shell: true,
            windowsHide: true
        });
    } catch (_err) {
        // noop
    }
}

function killLockingProcesses() {
    if (process.platform !== "win32") return;
    killByImageName("Android Hub");
    killByImageName("electron");
    killRepoAdbProcesses();
}

function sleepSync(ms) {
    try {
        execSync(`ping -n ${Math.max(2, Math.ceil(ms / 1000) + 1)} 127.0.0.1 >nul`, {
            stdio: "ignore",
            shell: true,
            windowsHide: true
        });
    } catch (_err) {
        // noop
    }
}

function findLockedFiles(dir, limit = 5) {
    const locked = [];
    if (!fs.existsSync(dir)) return locked;

    const stack = [dir];
    while (stack.length && locked.length < limit) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_err) {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            try {
                const fd = fs.openSync(full, "r+");
                fs.closeSync(fd);
            } catch (_err) {
                locked.push(path.relative(root, full));
                if (locked.length >= limit) break;
            }
        }
    }

    return locked;
}

function removeDir(target) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 750 });
}

function readCurrentMarkerSubdir() {
    if (!fs.existsSync(markerPath)) return null;
    const sub = fs.readFileSync(markerPath, "utf8").trim();
    return sub || null;
}

function cleanStaleBuildDirs() {
    if (!fs.existsSync(dist)) return;

    const keepSubdir = readCurrentMarkerSubdir();
    const now = Date.now();

    for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("build-")) continue;
        if (keepSubdir && entry.name === keepSubdir) continue;

        const target = path.join(dist, entry.name);
        let mtimeMs;
        try {
            mtimeMs = fs.statSync(target).mtimeMs;
        } catch (_err) {
            continue;
        }
        if (now - mtimeMs < STALE_BUILD_MAX_AGE_MS) continue;

        try {
            removeDir(target);
            console.log(`Supprimé (build orphelin): dist\\${entry.name}`);
        } catch (_err) {
            console.warn(`Impossible de supprimer dist\\${entry.name} (build orphelin).`);
        }
    }
}

function cleanTarget(name) {
    const target = path.join(dist, name);
    if (!fs.existsSync(target)) return true;

    const attempts = [
        () => removeDir(target),
        () => {
            killLockingProcesses();
            sleepSync(1500);
            removeDir(target);
        },
        () => {
            const stale = `${target}.stale-${Date.now()}`;
            fs.renameSync(target, stale);
            console.log(`Renommé en contournement: ${path.relative(root, stale)}`);
        }
    ];

    for (const attempt of attempts) {
        try {
            attempt();
            if (fs.existsSync(target)) continue;
            console.log(`Supprimé: dist\\${name}`);
            return true;
        } catch (_err) {
            // retry
        }
    }

    const locked = findLockedFiles(target);
    console.warn(`Impossible de supprimer dist\\${name}: permission refusée (fichier verrouillé).`);
    if (locked.length) {
        console.warn(`  Verrouillé(s): ${locked.join(", ")}`);
    }
    console.warn("  → Fermez Android Hub / Electron s'ils tournent encore.");
    console.warn("  → Fermez l'explorateur de fichiers sur dist\\win-unpacked.");
    console.warn("  → Si Cursor verrouille app.asar: fermez Cursor, puis dans PowerShell :");
    console.warn(`     Remove-Item -LiteralPath "${target}" -Recurse -Force`);
    return name === "win-unpacked" ? "locked" : false;
}

let failed = false;
let winUnpackedLocked = false;

for (const name of ["win-unpacked", "win-unpacked.tmp"]) {
    const result = cleanTarget(name);
    if (result === "locked") winUnpackedLocked = true;
    else if (result === false) failed = true;
}

cleanStaleBuildDirs();

if (!failed && !winUnpackedLocked) {
    clearAlternateOutputDir();
}

if (fs.existsSync(dist)) {
    for (const entry of fs.readdirSync(dist)) {
        if (!entry.startsWith("win-unpacked.stale-")) continue;
        const result = cleanTarget(entry);
        if (result === false) failed = true;
    }
}

if (winUnpackedLocked) {
    const alt = setAlternateOutputDir();
    console.warn(`Contournement: le build utilisera ${alt.replace(/\//g, "\\")} (win-unpacked verrouillé).`);
    console.warn("Vous pourrez supprimer dist\\win-unpacked plus tard (fermez Cursor si besoin).");
} else if (failed) {
    process.exitCode = 1;
}
