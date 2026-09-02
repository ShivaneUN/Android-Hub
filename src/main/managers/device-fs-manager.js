const { spawn } = require("child_process");
const path = require("path");

const CREATE_NO_WINDOW = 0x08000000;
const DEFAULT_PUSH_TARGET = "/sdcard/Download";
const ALLOWED_ROOTS = ["/sdcard", "/storage/emulated/0", "/mnt/sdcard"];
const SHORTCUTS = [
    { id: "download", path: "/sdcard/Download" },
    { id: "dcim", path: "/sdcard/DCIM" },
    { id: "pictures", path: "/sdcard/Pictures" },
    { id: "documents", path: "/sdcard/Documents" },
    { id: "movies", path: "/sdcard/Movies" },
    { id: "music", path: "/sdcard/Music" }
];

function spawnHidden(command, args) {
    const options = { windowsHide: true };
    if (process.platform === "win32") {
        options.creationFlags = CREATE_NO_WINDOW;
    }
    return spawn(command, args, options);
}

function normalizeRemotePath(input) {
    let value = String(input || "").replace(/\\/g, "/").trim();
    if (!value) value = "/sdcard";
    if (!value.startsWith("/")) value = `/${value}`;
    value = value.replace(/\/{2,}/g, "/");
    if (value.length > 1) value = value.replace(/\/+$/, "");
    return value;
}

function isAllowedRemotePath(remotePath, { allowRoot = true } = {}) {
    const normalized = normalizeRemotePath(remotePath);
    if (normalized.includes("\0") || normalized.includes("..")) return false;
    const allowed = ALLOWED_ROOTS.some((root) => (
        normalized === root || normalized.startsWith(`${root}/`)
    ));
    if (!allowed) return false;
    if (!allowRoot && ALLOWED_ROOTS.includes(normalized)) return false;
    return true;
}

function parentRemotePath(remotePath) {
    const normalized = normalizeRemotePath(remotePath);
    if (ALLOWED_ROOTS.includes(normalized)) return normalized;
    const idx = normalized.lastIndexOf("/");
    if (idx <= 0) return "/sdcard";
    const parent = normalized.slice(0, idx);
    return parent || "/sdcard";
}

function basenameRemote(remotePath) {
    const normalized = normalizeRemotePath(remotePath);
    const idx = normalized.lastIndexOf("/");
    return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function joinRemote(dir, name) {
    const base = normalizeRemotePath(dir);
    const leaf = String(name || "").replace(/[\\/]/g, "").trim();
    if (!leaf || leaf === "." || leaf === "..") return null;
    return normalizeRemotePath(`${base}/${leaf}`);
}

function quoteForDeviceShell(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class DeviceFsManager {
    constructor(adbPath) {
        this.adbPath = adbPath;
        /** @type {Map<string, string>} */
        this._pushTargetByDevice = new Map();
    }

    setPushTarget(deviceKey, remotePath) {
        const key = String(deviceKey || "").trim();
        if (!key || !isAllowedRemotePath(remotePath)) return;
        this._pushTargetByDevice.set(key, normalizeRemotePath(remotePath));
    }

    getPushTarget(deviceKey) {
        const key = String(deviceKey || "").trim();
        return this._pushTargetByDevice.get(key) || DEFAULT_PUSH_TARGET;
    }

    getShortcuts() {
        return SHORTCUTS.map((item) => ({ ...item }));
    }

    async list(serial, remotePath) {
        const dir = isAllowedRemotePath(remotePath) ? normalizeRemotePath(remotePath) : "/sdcard";
        const quoted = quoteForDeviceShell(dir);
        let stdout = "";
        try {
            stdout = await this._runAdb(serial, ["shell", `ls -1p ${quoted}`], { timeoutMs: 15000 });
        } catch (err) {
            const message = String(err?.message || "");
            if (/unknown option|illegal option|invalid option/i.test(message)) {
                stdout = await this._runAdb(serial, ["shell", `ls -1 ${quoted}`], { timeoutMs: 15000 });
            } else if (/no such file|not a directory/i.test(message)) {
                throw new Error("Dossier introuvable");
            } else {
                throw err;
            }
        }

        const entries = [];
        for (const raw of stdout.split(/\r?\n/)) {
            const line = raw.replace(/\r/g, "").trim();
            if (!line || line === "." || line === "..") continue;
            const isDir = line.endsWith("/");
            const name = isDir ? line.slice(0, -1) : line;
            if (!name || name.startsWith("ls:")) continue;
            const fullPath = joinRemote(dir, name);
            if (!fullPath) continue;
            entries.push({
                name,
                path: fullPath,
                isDir
            });
        }

        entries.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });

        return {
            path: dir,
            parent: parentRemotePath(dir),
            atRoot: ALLOWED_ROOTS.includes(dir),
            entries
        };
    }

    async mkdir(serial, parentPath, name) {
        const fullPath = joinRemote(parentPath, name);
        if (!fullPath || !isAllowedRemotePath(fullPath, { allowRoot: false })) {
            throw new Error("Nom de dossier invalide");
        }
        await this._runAdb(serial, ["shell", "mkdir", "-p", fullPath], { timeoutMs: 12000 });
        return { path: fullPath };
    }

    async remove(serial, remotePath) {
        const target = normalizeRemotePath(remotePath);
        if (!isAllowedRemotePath(target, { allowRoot: false })) {
            throw new Error("Suppression refusée");
        }
        await this._runAdb(serial, ["shell", "rm", "-rf", target], { timeoutMs: 60000 });
        return { path: target };
    }

    async push(serial, localPaths, remoteDir, onProgress) {
        const destDir = isAllowedRemotePath(remoteDir) ? normalizeRemotePath(remoteDir) : DEFAULT_PUSH_TARGET;
        const sources = (Array.isArray(localPaths) ? localPaths : [localPaths])
            .map((item) => String(item || "").trim())
            .filter(Boolean);
        if (sources.length === 0) {
            throw new Error("Aucun fichier à envoyer");
        }

        const results = [];
        for (const localPath of sources) {
            const name = path.basename(localPath);
            onProgress?.({ phase: "push", localPath, name, percent: 0 });
            await this._runAdb(serial, ["push", localPath, destDir], {
                timeoutMs: 30 * 60 * 1000,
                onProgress: (percent) => onProgress?.({ phase: "push", localPath, name, percent })
            });
            results.push({ localPath, name, remoteDir: destDir });
        }
        return { remoteDir: destDir, files: results };
    }

    async pull(serial, remotePath, localDest, onProgress) {
        const source = normalizeRemotePath(remotePath);
        if (!isAllowedRemotePath(source, { allowRoot: false })) {
            throw new Error("Chemin device invalide");
        }
        const dest = String(localDest || "").trim();
        if (!dest) throw new Error("Destination PC manquante");
        const name = basenameRemote(source);
        onProgress?.({ phase: "pull", remotePath: source, name, percent: 0 });
        await this._runAdb(serial, ["pull", source, dest], {
            timeoutMs: 30 * 60 * 1000,
            onProgress: (percent) => onProgress?.({ phase: "pull", remotePath: source, name, percent })
        });
        return { remotePath: source, localPath: dest, name };
    }

    isApk(localPath) {
        return /\.apk$/i.test(String(localPath || ""));
    }

    async installApk(serial, localPath, onProgress) {
        const apk = String(localPath || "").trim();
        if (!this.isApk(apk)) throw new Error("Fichier APK invalide");
        onProgress?.({ phase: "install", localPath: apk, name: path.basename(apk), percent: 0 });
        await this._runAdb(serial, ["install", "-r", apk], { timeoutMs: 10 * 60 * 1000 });
        onProgress?.({ phase: "install", localPath: apk, name: path.basename(apk), percent: 100 });
        return { localPath: apk };
    }

    _runAdb(serial, args, { timeoutMs = 20000, onProgress } = {}) {
        return new Promise((resolve, reject) => {
            if (!this.adbPath || !serial) {
                reject(new Error("ADB ou serial manquant"));
                return;
            }
            const child = spawnHidden(this.adbPath, ["-s", serial, ...args]);
            let stdout = "";
            let stderr = "";
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new Error("Timeout ADB"));
            }, timeoutMs);

            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) reject(err);
                else resolve(value);
            };

            child.stdout?.on("data", (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr?.on("data", (chunk) => {
                const text = chunk.toString();
                stderr += text;
                if (onProgress) {
                    const matches = text.match(/\[\s*(\d+)%\]/g);
                    if (matches?.length) {
                        const last = matches[matches.length - 1].match(/(\d+)/);
                        const percent = last ? Number(last[1]) : null;
                        if (Number.isFinite(percent)) onProgress(percent);
                    }
                }
            });
            child.on("error", (err) => finish(err));
            child.on("close", (code) => {
                if (code === 0) {
                    finish(null, stdout.trim());
                    return;
                }
                finish(new Error(stderr.trim() || stdout.trim() || `adb exit ${code}`));
            });
        });
    }
}

module.exports = {
    DeviceFsManager,
    DEFAULT_PUSH_TARGET,
    normalizeRemotePath,
    isAllowedRemotePath
};
