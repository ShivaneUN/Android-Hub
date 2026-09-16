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

const IMAGE_MIME = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml"
};
const PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

function extensionOf(name) {
    const base = String(name || "");
    const idx = base.lastIndexOf(".");
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : "";
}

function mimeFromName(name) {
    return IMAGE_MIME[extensionOf(name)] || null;
}

function looksLikeLsLong(stdout) {
    return String(stdout || "").split(/\r?\n/).some((line) => (
        /^[-dlcbps][-rwxsStT]{9}[+.@]?\s/.test(line.trim())
    ));
}

function parseLsLong(stdout, dir) {
    const entries = [];
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const line = raw.replace(/\r/g, "").trim();
        if (!line || /^total\s/i.test(line) || line.startsWith("ls:")) continue;
        const match = line.match(/^([-dlcbps])[-rwxsStT]{9}[+.@]?\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/);
        if (!match) continue;
        const name = match[2].replace(/\/$/, "").trim();
        if (!name || name === "." || name === "..") continue;
        const fullPath = joinRemote(dir, name);
        if (!fullPath) continue;
        entries.push({
            name,
            path: fullPath,
            isDir: match[1] === "d"
        });
    }
    return entries;
}

function parseLsMarked(stdout, dir) {
    const entries = [];
    for (const raw of String(stdout || "").split(/\r?\n/)) {
        const line = raw.replace(/\r/g, "").trim();
        if (!line || line === "." || line === ".." || line.startsWith("ls:")) continue;
        const typed = line.match(/^([df])\t(.*)$/);
        if (typed) {
            const name = typed[2].trim();
            const fullPath = joinRemote(dir, name);
            if (!name || !fullPath) continue;
            entries.push({ name, path: fullPath, isDir: typed[1] === "d" });
            continue;
        }
        const isDir = line.endsWith("/");
        const name = isDir ? line.slice(0, -1) : line;
        const fullPath = joinRemote(dir, name);
        if (!name || !fullPath) continue;
        entries.push({ name, path: fullPath, isDir });
    }
    return entries;
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
        let entries = [];
        try {
            const longOut = await this._runAdb(serial, ["shell", `ls -l ${quoted}`], { timeoutMs: 20000 });
            if (looksLikeLsLong(longOut)) {
                entries = parseLsLong(longOut, dir);
            }
        } catch (err) {
            const message = String(err?.message || "");
            if (/no such file|not a directory/i.test(message)) {
                throw new Error("Dossier introuvable");
            }
        }

        if (!entries.length || !entries.some((item) => item.isDir)) {
            try {
                const typed = await this._runAdb(serial, ["shell",
                    `dir=${quoted}; ls -1 "$dir" 2>/dev/null | while IFS= read -r name || [ -n "$name" ]; do [ -z "$name" ] && continue; if [ -d "$dir/$name" ]; then printf 'd\\t%s\\n' "$name"; else printf 'f\\t%s\\n' "$name"; fi; done`
                ], { timeoutMs: 25000 });
                const typedEntries = parseLsMarked(typed, dir);
                if (typedEntries.length) entries = typedEntries;
            } catch (_err) {
                if (!entries.length) {
                    const marked = await this._runAdb(serial, ["shell", `ls -1p ${quoted}`], { timeoutMs: 15000 });
                    entries = parseLsMarked(marked, dir);
                }
            }
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
        await this._runAdb(serial, ["shell", `mkdir -p -- ${quoteForDeviceShell(fullPath)}`], { timeoutMs: 12000 });
        return { path: fullPath };
    }

    async remove(serial, remotePath) {
        const target = normalizeRemotePath(remotePath);
        if (!isAllowedRemotePath(target, { allowRoot: false })) {
            throw new Error("Suppression refusée");
        }
        await this._runAdb(serial, ["shell", `rm -rf -- ${quoteForDeviceShell(target)}`], { timeoutMs: 60000 });
        return { path: target };
    }

    async preview(serial, remotePath) {
        const source = normalizeRemotePath(remotePath);
        if (!isAllowedRemotePath(source, { allowRoot: false })) {
            throw new Error("Chemin device invalide");
        }
        const name = basenameRemote(source);
        const mime = mimeFromName(name);
        if (!mime) {
            return { previewable: false, name };
        }
        const quoted = quoteForDeviceShell(source);
        const result = await this._execOut(serial, `cat -- ${quoted}`, {
            timeoutMs: 45000,
            maxBytes: PREVIEW_MAX_BYTES
        });
        if (result.truncated) {
            return { previewable: false, tooLarge: true, name, mime };
        }
        if (!result.buffer?.length) {
            return { previewable: false, name, mime };
        }
        return {
            previewable: true,
            name,
            mime,
            data: result.buffer.toString("base64")
        };
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

    _execOut(serial, shellCommand, { timeoutMs = 30000, maxBytes = 0 } = {}) {
        return new Promise((resolve, reject) => {
            if (!this.adbPath || !serial) {
                reject(new Error("ADB ou serial manquant"));
                return;
            }
            const child = spawnHidden(this.adbPath, ["-s", serial, "exec-out", "sh", "-c", shellCommand]);
            const chunks = [];
            let stderr = "";
            let size = 0;
            let truncated = false;
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
                if (truncated) return;
                size += chunk.length;
                if (maxBytes && size > maxBytes) {
                    truncated = true;
                    child.kill();
                    return;
                }
                chunks.push(chunk);
            });
            child.stderr?.on("data", (chunk) => {
                stderr += chunk.toString();
            });
            child.on("error", (err) => finish(err));
            child.on("close", (code) => {
                if (truncated) {
                    finish(null, { truncated: true, buffer: Buffer.concat(chunks) });
                    return;
                }
                if (code !== 0 && size === 0) {
                    finish(new Error(stderr.trim() || `adb exec-out exit ${code}`));
                    return;
                }
                finish(null, { truncated: false, buffer: Buffer.concat(chunks) });
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
