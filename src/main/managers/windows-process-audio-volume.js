const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { app } = require("electron");

/**
 * Volume de lecture PC par PID (Windows Core Audio).
 * Slider Hub → process scrcpy audio du device, sans ADB media_session.
 * Utilise hub-volume-mixer.exe (pas PowerShell) pour rester réactif.
 */

function clampPercent(percent) {
    return Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
}

function execFileAsync(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            windowsHide: true,
            timeout: opts.timeoutMs || 8000,
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
        this._exePath = null;
        this._ensurePromise = null;
        this._queue = Promise.resolve();
        /** @type {Map<number, number>} */
        this._lastByPid = new Map();
        /** @type {Map<number, boolean>} */
        this._muteByPid = new Map();
        /** @type {Map<number, string>} */
        this._identityByPid = new Map();
        this._iconPath = null;
    }

    _sourceCsPath() {
        return path.join(__dirname, "../native/VolumeMixer.cs");
    }

    _resolveExePath() {
        if (this._exePath) return this._exePath;
        let base;
        try {
            base = app?.getPath?.("userData") || path.join(require("os").tmpdir(), "android-hub");
        } catch (_err) {
            base = path.join(require("os").tmpdir(), "android-hub");
        }
        this._exePath = path.join(base, "hub-volume-mixer.exe");
        return this._exePath;
    }

    async _ensureExe() {
        if (this._ensurePromise) return this._ensurePromise;
        this._ensurePromise = (async () => {
            if (process.platform !== "win32") {
                throw new Error("windows uniquement");
            }
            const exe = this._resolveExePath();
            const src = this._sourceCsPath();
            if (fs.existsSync(exe) && fs.existsSync(src)) {
                const exeStat = fs.statSync(exe);
                const srcStat = fs.statSync(src);
                if (exeStat.mtimeMs >= srcStat.mtimeMs) return exe;
            }
            if (!fs.existsSync(src)) {
                throw new Error(`VolumeMixer.cs introuvable: ${src}`);
            }
            fs.mkdirSync(path.dirname(exe), { recursive: true });
            // Ancien DLL éventuel — plus utilisé.
            try {
                const oldDll = path.join(path.dirname(exe), "hub-volume-mixer.dll");
                if (fs.existsSync(oldDll)) fs.unlinkSync(oldDll);
            } catch (_err) {
                /* ignore */
            }
            const cscCandidates = [
                path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
                path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
            ];
            const csc = cscCandidates.find((p) => fs.existsSync(p));
            if (!csc) throw new Error("csc.exe introuvable");
            await execFileAsync(csc, ["/nologo", "/target:exe", `/out:${exe}`, src], {
                timeoutMs: 30000
            });
            if (!fs.existsSync(exe)) throw new Error("compilation VolumeMixer échouée");
            return exe;
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
     * @param {{ force?: boolean }} [opts]
     */
    setVolumePercent(pid, percent, opts = {}) {
        const p = clampPercent(percent);
        const id = Number(pid);
        const force = Boolean(opts.force);
        if (!Number.isInteger(id) || id <= 0) {
            return Promise.resolve({ success: false, percent: p, error: "pid invalide" });
        }
        if (process.platform !== "win32") {
            return Promise.resolve({ success: false, percent: p, error: "windows uniquement" });
        }

        // Skip no-op (évite file d'attente pendant un drag / double input+change).
        if (!force && (this._lastByPid.get(id) === p || this._pendingByPid?.get(id) === p)) {
            return Promise.resolve({ success: true, percent: p, matched: 1, skipped: true });
        }
        if (!this._pendingByPid) this._pendingByPid = new Map();
        this._pendingByPid.set(id, p);

        const run = async () => {
            try {
                if (!force && this._lastByPid.get(id) === p) {
                    return { success: true, percent: p, matched: 1, skipped: true };
                }
                const exe = await this._ensureExe();
                let out = await execFileAsync(exe, ["set", String(id), String(p)], { timeoutMs: 4000 });
                let matched = Number.parseInt(String(out).trim(), 10);
                if (!Number.isInteger(matched) || matched <= 0) {
                    // Session audio parfois créée juste après spawn scrcpy.
                    await new Promise((r) => setTimeout(r, 180));
                    out = await execFileAsync(exe, ["set", String(id), String(p)], { timeoutMs: 4000 });
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
                if (p > 0) this._muteByPid.set(id, false);
                return { success: true, percent: p, matched };
            } catch (err) {
                return { success: false, percent: p, error: err?.message || String(err) };
            } finally {
                if (this._pendingByPid?.get(id) === p) this._pendingByPid.delete(id);
            }
        };

        const next = this._queue.then(run, run);
        this._queue = next.then(() => undefined, () => undefined);
        return next;
    }

    /**
     * Mute Windows (Core Audio) pour le PID — ne touche pas le %.
     * @param {number} pid
     * @param {boolean} muted
     * @param {{ force?: boolean }} [opts]
     */
    setMuted(pid, muted, opts = {}) {
        const id = Number(pid);
        const wantMute = Boolean(muted);
        const force = Boolean(opts.force);
        if (!Number.isInteger(id) || id <= 0) {
            return Promise.resolve({ success: false, muted: wantMute, error: "pid invalide" });
        }
        if (process.platform !== "win32") {
            return Promise.resolve({ success: false, muted: wantMute, error: "windows uniquement" });
        }

        if (!force && this._muteByPid.get(id) === wantMute) {
            return Promise.resolve({ success: true, muted: wantMute, matched: 1, skipped: true });
        }

        const run = async () => {
            try {
                if (!force && this._muteByPid.get(id) === wantMute) {
                    return { success: true, muted: wantMute, matched: 1, skipped: true };
                }
                const exe = await this._ensureExe();
                let out = await execFileAsync(
                    exe,
                    ["mute", String(id), wantMute ? "1" : "0"],
                    { timeoutMs: 4000 }
                );
                let matched = Number.parseInt(String(out).trim(), 10);
                if (!Number.isInteger(matched) || matched <= 0) {
                    await new Promise((r) => setTimeout(r, 180));
                    out = await execFileAsync(
                        exe,
                        ["mute", String(id), wantMute ? "1" : "0"],
                        { timeoutMs: 4000 }
                    );
                    matched = Number.parseInt(String(out).trim(), 10);
                }
                if (!Number.isInteger(matched) || matched <= 0) {
                    return {
                        success: false,
                        muted: wantMute,
                        matched: 0,
                        error: "session audio introuvable (playback OFF?)"
                    };
                }
                this._muteByPid.set(id, wantMute);
                return { success: true, muted: wantMute, matched };
            } catch (err) {
                return { success: false, muted: wantMute, error: err?.message || String(err) };
            }
        };

        const next = this._queue.then(run, run);
        this._queue = next.then(() => undefined, () => undefined);
        return next;
    }

    /**
     * Volume + mute atomiques (CLI apply) — sync mixeur Windows sur le % Hub.
     * @param {number} pid
     * @param {number} percent
     * @param {boolean} muted
     * @param {{ force?: boolean }} [opts]
     */
    applyVolumeAndMute(pid, percent, muted, opts = {}) {
        const p = clampPercent(percent);
        const id = Number(pid);
        const wantMute = Boolean(muted);
        const force = Boolean(opts.force);
        if (!Number.isInteger(id) || id <= 0) {
            return Promise.resolve({
                success: false,
                percent: p,
                muted: wantMute,
                error: "pid invalide"
            });
        }
        if (process.platform !== "win32") {
            return Promise.resolve({
                success: false,
                percent: p,
                muted: wantMute,
                error: "windows uniquement"
            });
        }

        if (
            !force
            && this._lastByPid.get(id) === p
            && this._muteByPid.get(id) === wantMute
        ) {
            return Promise.resolve({
                success: true,
                percent: p,
                muted: wantMute,
                matched: 1,
                skipped: true
            });
        }

        const run = async () => {
            try {
                if (
                    !force
                    && this._lastByPid.get(id) === p
                    && this._muteByPid.get(id) === wantMute
                ) {
                    return {
                        success: true,
                        percent: p,
                        muted: wantMute,
                        matched: 1,
                        skipped: true
                    };
                }
                const exe = await this._ensureExe();
                let out = await execFileAsync(
                    exe,
                    ["apply", String(id), String(p), wantMute ? "1" : "0"],
                    { timeoutMs: 4000 }
                );
                let matched = Number.parseInt(String(out).trim(), 10);
                if (!Number.isInteger(matched) || matched <= 0) {
                    await new Promise((r) => setTimeout(r, 180));
                    out = await execFileAsync(
                        exe,
                        ["apply", String(id), String(p), wantMute ? "1" : "0"],
                        { timeoutMs: 4000 }
                    );
                    matched = Number.parseInt(String(out).trim(), 10);
                }
                if (!Number.isInteger(matched) || matched <= 0) {
                    return {
                        success: false,
                        percent: p,
                        muted: wantMute,
                        matched: 0,
                        error: "session audio introuvable (playback OFF?)"
                    };
                }
                this._lastByPid.set(id, p);
                this._muteByPid.set(id, wantMute);
                return { success: true, percent: p, muted: wantMute, matched };
            } catch (err) {
                return {
                    success: false,
                    percent: p,
                    muted: wantMute,
                    error: err?.message || String(err)
                };
            }
        };

        const next = this._queue.then(run, run);
        this._queue = next.then(() => undefined, () => undefined);
        return next;
    }

    formatMixerDisplayName(deviceName) {
        const name = String(deviceName || "").trim().replace(/\.exe$/i, "") || "Device";
        return `Android Hub - ${name}`.replace(/\.exe$/i, "");
    }

    resolveHubIconPath() {
        if (this._iconPath && fs.existsSync(this._iconPath)) return this._iconPath;
        try {
            const { resolveHubIconPath } = require("./windows-exe-icon");
            this._iconPath = resolveHubIconPath();
        } catch (_err) {
            this._iconPath = null;
        }
        return this._iconPath;
    }

    /**
     * Nom + icône Hub dans le mixeur Windows (SetDisplayName / SetIconPath).
     */
    setMixerIdentity(pid, opts = {}) {
        const id = Number(pid);
        if (!Number.isInteger(id) || id <= 0) {
            return Promise.resolve({ success: false, error: "pid invalide" });
        }
        if (process.platform !== "win32") {
            return Promise.resolve({ success: false, error: "windows uniquement" });
        }

        const displayName = String(
            opts.displayName || this.formatMixerDisplayName(opts.deviceName) || "Android Hub"
        ).trim().replace(/\.exe$/i, "");
        let iconPath = opts.iconPath || "";
        if (!iconPath && opts.exePath && fs.existsSync(opts.exePath)) {
            iconPath = `${opts.exePath},0`;
        }
        if (!iconPath) {
            const ico = this.resolveHubIconPath() || "";
            try {
                const sap = global.sessionAudioProcessManager;
                const toolsDir = sap?.scrcpyBinaryPath ? path.dirname(sap.scrcpyBinaryPath) : null;
                if (toolsDir && ico && fs.existsSync(ico)) {
                    const stable = path.join(toolsDir, "android-hub-mixer.ico");
                    if (!fs.existsSync(stable) || fs.statSync(stable).mtimeMs < fs.statSync(ico).mtimeMs) {
                        fs.copyFileSync(ico, stable);
                    }
                    iconPath = stable;
                } else {
                    iconPath = ico;
                }
            } catch (_err) {
                iconPath = ico;
            }
        }

        const cacheKey = `${displayName}|${iconPath}`;
        if (!opts.force && this._identityByPid?.get(id) === cacheKey) {
            return Promise.resolve({ success: true, skipped: true, displayName, iconPath });
        }
        if (!this._identityByPid) this._identityByPid = new Map();

        const run = async () => {
            try {
                const exe = await this._ensureExe();
                let out = await execFileAsync(
                    exe,
                    ["identity", String(id), displayName, iconPath || ""],
                    { timeoutMs: 4000 }
                );
                let matched = Number.parseInt(String(out).trim(), 10);
                if (!Number.isInteger(matched) || matched <= 0) {
                    await new Promise((r) => setTimeout(r, 200));
                    out = await execFileAsync(
                        exe,
                        ["identity", String(id), displayName, iconPath || ""],
                        { timeoutMs: 4000 }
                    );
                    matched = Number.parseInt(String(out).trim(), 10);
                }
                if (!Number.isInteger(matched) || matched <= 0) {
                    return {
                        success: false,
                        matched: 0,
                        displayName,
                        iconPath,
                        error: "session audio introuvable pour identité"
                    };
                }
                this._identityByPid.set(id, cacheKey);
                console.log(`[WindowsAudio] mixer identity pid=${id} → "${displayName}" + icon`);
                return { success: true, matched, displayName, iconPath };
            } catch (err) {
                return {
                    success: false,
                    displayName,
                    iconPath,
                    error: err?.message || String(err)
                };
            }
        };

        const next = this._queue.then(run, run);
        this._queue = next.then(() => undefined, () => undefined);
        return next;
    }
}

module.exports = { WindowsProcessAudioVolume, clampPercent };
