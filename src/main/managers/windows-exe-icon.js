const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { app } = require("electron");

/**
 * Branding mixeur Windows : icône Hub + FileDescription "Android Hub - {device}".
 * Toujours sur une copie .exe (spawn direct = volume sidebar fiable).
 *
 * Important packaged : rcedit (binaire natif) ne lit PAS l'asar —
 * l'icône doit être un vrai fichier disque (extraResources ou copie userData).
 */

function _isInsideAsar(filePath) {
    const p = String(filePath || "");
    return p.includes(`${path.sep}app.asar${path.sep}`) || p.includes(".asar" + path.sep);
}

function _brandingCacheDir() {
    try {
        return path.join(app.getPath("userData"), "audio-branding");
    } catch (_err) {
        return path.join(require("os").tmpdir(), "android-hub-audio-branding");
    }
}

/** Chemins candidats (asar inclus) — pas forcément utilisable par rcedit. */
function resolveHubIconPathRaw() {
    const candidates = [];
    try {
        if (app?.isPackaged && process.resourcesPath) {
            // Priorité absolue : extraResources (fichier disque réel pour rcedit).
            candidates.push(path.join(process.resourcesPath, "icon.ico"));
            candidates.push(path.join(process.resourcesPath, "icons", "icon.ico"));
            candidates.push(path.join(process.resourcesPath, "build", "icon.ico"));
            candidates.push(path.join(process.resourcesPath, "tools", "android-hub-mixer.ico"));
        }
    } catch (_err) {
        /* ignore */
    }
    try {
        const toolsDir = global.sessionAudioProcessManager?.scrcpyBinaryPath
            ? path.dirname(global.sessionAudioProcessManager.scrcpyBinaryPath)
            : null;
        if (toolsDir) {
            candidates.push(path.join(toolsDir, "android-hub-mixer.ico"));
        }
    } catch (_err) {
        /* ignore */
    }
    candidates.push(
        path.join(__dirname, "../assets/icons/icon.ico"),
        path.join(__dirname, "../../assets/icons/icon.ico"),
        path.join(__dirname, "../../../build/icon.ico"),
        path.join(__dirname, "../../build/icon.ico"),
        path.join(process.cwd(), "build/icon.ico"),
        path.join(process.cwd(), "src/assets/icons/icon.ico")
    );
    return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/**
 * Icône Hub en chemin disque réel (hors asar) pour rcedit / mixeur.
 * Copie vers userData si la source est dans l'asar.
 */
function materializeHubIconPath(preferred = null) {
    const src = preferred || resolveHubIconPathRaw();
    if (!src || !fs.existsSync(src)) return null;
    if (!_isInsideAsar(src)) {
        return src;
    }

    try {
        const dir = _brandingCacheDir();
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, "icon.ico");
        const srcBuf = fs.readFileSync(src);
        let needWrite = !fs.existsSync(dest);
        if (!needWrite) {
            try {
                const destBuf = fs.readFileSync(dest);
                needWrite = destBuf.length !== srcBuf.length;
            } catch (_err) {
                needWrite = true;
            }
        }
        if (needWrite) {
            fs.writeFileSync(dest, srcBuf);
        }
        return fs.existsSync(dest) ? dest : null;
    } catch (err) {
        console.warn("[WindowsExeIcon] materialize icon:", err?.message || err);
        return null;
    }
}

/** Résout + matérialise l'icône Hub (toujours safe pour rcedit). */
function resolveHubIconPath() {
    return materializeHubIconPath(resolveHubIconPathRaw());
}

/**
 * Copie l'icône à côté de scrcpy (tools/) si le dossier est accessible en écriture.
 * Utile pour SetIconPath mixeur + cache local post-update.
 */
function ensureMixerIconBesideTools(toolsDir = null) {
    const dir = toolsDir
        || (global.sessionAudioProcessManager?.scrcpyBinaryPath
            ? path.dirname(global.sessionAudioProcessManager.scrcpyBinaryPath)
            : null);
    if (!dir) return null;
    const icon = resolveHubIconPath();
    if (!icon) return null;
    const dest = path.join(dir, "android-hub-mixer.ico");
    try {
        if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(icon).mtimeMs) {
            fs.copyFileSync(icon, dest);
        }
        return dest;
    } catch (_err) {
        return icon;
    }
}

function stripExeSuffix(value) {
    return String(value || "")
        .trim()
        .replace(/\.exe$/i, "")
        .trim() || "Android Hub";
}

/** Lit FileDescription PE (vide si absent / erreur). */
function readExeFileDescription(exePath) {
    if (!exePath || !fs.existsSync(exePath)) return "";
    try {
        const q = path.resolve(exePath).replace(/'/g, "''");
        const out = execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${q}').FileDescription`
            ],
            { encoding: "utf8", timeout: 8000, windowsHide: true }
        );
        return String(out || "").trim();
    } catch (_err) {
        return "";
    }
}

/**
 * @param {string} exePath
 * @param {{ iconPath?: string|null, displayName?: string|null }} [opts]
 */
async function brandExeWithHubIdentity(exePath, opts = {}) {
    if (process.platform !== "win32") {
        return { success: false, error: "windows uniquement" };
    }
    if (!exePath || !fs.existsSync(exePath)) {
        return { success: false, error: "exe introuvable" };
    }
    const iconPath = materializeHubIconPath(opts.iconPath || resolveHubIconPathRaw());
    if (!iconPath || !fs.existsSync(iconPath)) {
        return { success: false, error: "icon.ico Hub introuvable (hors asar)" };
    }
    if (_isInsideAsar(iconPath)) {
        return { success: false, error: "icon.ico encore dans asar — rcedit impossible" };
    }
    const displayName = stripExeSuffix(opts.displayName || "Android Hub");

    try {
        const { rcedit } = require("rcedit");
        // Branding sur fichier temp puis replace — évite PE partiel / fichier verrouillé à moitié.
        const dir = path.dirname(exePath);
        const tmp = path.join(dir, `.${path.basename(exePath)}.branding.tmp`);
        try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch (_err) {
            /* ignore */
        }
        fs.copyFileSync(exePath, tmp);

        await rcedit(tmp, {
            icon: iconPath,
            "file-version": "1.0.0.0",
            "product-version": "1.0.0.0",
            "version-string": {
                FileDescription: displayName,
                ProductName: displayName,
                InternalName: displayName,
                OriginalFilename: path.basename(exePath),
                CompanyName: "Android Hub"
            }
        });

        const actual = readExeFileDescription(tmp);
        if (actual !== displayName) {
            try {
                fs.unlinkSync(tmp);
            } catch (_err) {
                /* ignore */
            }
            return {
                success: false,
                error: `FileDescription non appliqué (got="${actual}", want="${displayName}")`,
                exePath,
                iconPath,
                displayName,
                actual
            };
        }

        try {
            if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
        } catch (_err) {
            /* replace below may still work */
        }
        fs.renameSync(tmp, exePath);

        return { success: true, exePath, iconPath, displayName, verified: true };
    } catch (err) {
        return { success: false, error: err?.message || String(err) };
    }
}

module.exports = {
    resolveHubIconPath,
    resolveHubIconPathRaw,
    materializeHubIconPath,
    ensureMixerIconBesideTools,
    stripExeSuffix,
    readExeFileDescription,
    brandExeWithHubIdentity
};
