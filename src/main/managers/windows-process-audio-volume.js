const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { app } = require("electron");

/**
 * Volume de lecture PC par PID (Windows Core Audio).
 * Slider Hub → process scrcpy audio du device, sans ADB media_session.
 */

function clampPercent(percent) {
    return Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
}

function execFileAsync(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            windowsHide: true,
            timeout: opts.timeoutMs || 10000,
            maxBuffer: 1024 * 1024
        }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(String(stderr || err.message || err)));
                return;
            }
            resolve(String(stdout || "").trim());
        });
    });
}

class WindowsProcessAudioVolume {
    constructor() {
        this._dllPath = null;
        this._ensurePromise = null;
        this._queue = Promise.resolve();
        /** @type {Map<number, number>} */
        this._lastByPid = new Map();
    }

    _sourceCsPath() {
        return path.join(__dirname, "../native/VolumeMixer.cs");
    }

    _resolveDllPath() {
        if (this._dllPath) return this._dllPath;
        let base;
        try {
            base = app?.getPath?.("userData") || path.join(require("os").tmpdir(), "android-hub");
        } catch (_err) {
            base = path.join(require("os").tmpdir(), "android-hub");
        }
        this._dllPath = path.join(base, "hub-volume-mixer.dll");
        return this._dllPath;
    }

    async _ensureDll() {
        if (this._ensurePromise) return this._ensurePromise;
        this._ensurePromise = (async () => {
            if (process.platform !== "win32") {
                throw new Error("windows uniquement");
            }
            const dll = this._resolveDllPath();
            const src = this._sourceCsPath();
            if (fs.existsSync(dll) && fs.existsSync(src)) {
                const dllStat = fs.statSync(dll);
                const srcStat = fs.statSync(src);
                if (dllStat.mtimeMs >= srcStat.mtimeMs) return dll;
            }
            if (!fs.existsSync(src)) {
                throw new Error(`VolumeMixer.cs introuvable: ${src}`);
            }
            fs.mkdirSync(path.dirname(dll), { recursive: true });
            const cscCandidates = [
                path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
                path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
            ];
            const csc = cscCandidates.find((p) => fs.existsSync(p));
            if (!csc) throw new Error("csc.exe introuvable");
            await execFileAsync(csc, ["/nologo", "/target:library", `/out:${dll}`, src], {
                timeoutMs: 30000
            });
            if (!fs.existsSync(dll)) throw new Error("compilation VolumeMixer échouée");
            return dll;
        })();
        try {
            return await this._ensurePromise;
        } catch (err) {
            this._ensurePromise = null;
            throw err;
        }
    }

    /**
     * @param {number} pid
     * @param {number} percent 0–100
     */
    setVolumePercent(pid, percent) {
        const p = clampPercent(percent);
        const id = Number(pid);
        if (!Number.isInteger(id) || id <= 0) {
            return Promise.resolve({ success: false, percent: p, error: "pid invalide" });
        }
        if (process.platform !== "win32") {
            return Promise.resolve({ success: false, percent: p, error: "windows uniquement" });
        }

        const run = async () => {
            try {
                const dll = await this._ensureDll();
                const script = `
Add-Type -Path '${String(dll).replace(/'/g, "''")}';
$n = [HubVolumeMixer]::SetApplicationVolume(${id}, [single]${p})
Write-Output $n
`.trim();
                let out = await execFileAsync(
                    "powershell.exe",
                    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                    { timeoutMs: 8000 }
                );
                let matched = Number.parseInt(String(out).trim(), 10);
                if (!Number.isInteger(matched) || matched <= 0) {
                    // Session audio parfois créée après le démarrage scrcpy playback.
                    await new Promise((r) => setTimeout(r, 400));
                    out = await execFileAsync(
                        "powershell.exe",
                        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                        { timeoutMs: 8000 }
                    );
                    matched = Number.parseInt(String(out).trim(), 10);
                }
                if (!Number.isInteger(matched) || matched <= 0) {
                    return {
                        success: false,
                        percent: p,
                        matched: 0,
                        error: "session audio introuvable (playback OFF?)"
                    };
                }
                this._lastByPid.set(id, p);
                return { success: true, percent: p, matched };
            } catch (err) {
                return { success: false, percent: p, error: err?.message || String(err) };
            }
        };

        const next = this._queue.then(run, run);
        this._queue = next.then(() => undefined, () => undefined);
        return next;
    }
}

module.exports = { WindowsProcessAudioVolume, clampPercent };
