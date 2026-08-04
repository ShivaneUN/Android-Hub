const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { app } = require("electron");

/**
 * Branding mixeur Windows : icône Hub + FileDescription "Android Hub - {device}".
 * Toujours sur une copie .exe (spawn direct = volume sidebar fiable).
 */

function resolveHubIconPath() {
    const candidates = [];
    try {
        if (app?.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, "icon.ico"));
            candidates.push(path.join(process.resourcesPath, "build", "icon.ico"));
        }
    } catch (_err) {
        /* ignore */
    }
    candidates.push(
        path.join(__dirname, "../assets/icons/icon.ico"),
        path.join(__dirname, "../../assets/icons/icon.ico"),
        path.join(__dirname, "../../build/icon.ico"),
        path.join(process.cwd(), "build/icon.ico"),
        path.join(process.cwd(), "src/assets/icons/icon.ico")
    );
    return candidates.find((p) => p && fs.existsSync(p)) || null;
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
    const iconPath = opts.iconPath || resolveHubIconPath();
    if (!iconPath || !fs.existsSync(iconPath)) {
        return { success: false, error: "icon.ico Hub introuvable" };
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
    stripExeSuffix,
    readExeFileDescription,
    brandExeWithHubIdentity
};
