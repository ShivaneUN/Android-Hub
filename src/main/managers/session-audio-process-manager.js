const { spawn, execFile } = require("child_process");

const CREATE_NO_WINDOW = 0x08000000;

/**
 * Capture audio device → PC via scrcpy.exe dédié.
 * Args : --no-video --no-window --no-control --audio-buffer=100
 * (source = output / REMOTE_SUBMIX → HP device coupé tant que la capture vit).
 *
 * ON/OFF PC : ne redémarre JAMAIS ce processus.
 * OFF = volume remote_submix à 0 (overlay / volume manager) → PC muet,
 *        capture gardée → HP device reste silencieux.
 * ON  = restore volume remote → son PC.
 *
 * Ne pas utiliser --no-audio ni --no-audio-playback ici :
 * un restart / hot-swap lâche REMOTE_SUBMIX et le HP device revient.
 *
 * Windows : kill arbre (taskkill /T /F) + balayage des orphelins --no-video.
 */
class SessionAudioProcessManager {
    constructor(scrcpyBinaryPath) {
        this.scrcpyBinaryPath = scrcpyBinaryPath;
        /** @type {Map<string, { child: import('child_process').ChildProcess, serial: string, displayId: number|null, pid: number|null, deviceKey: string|null }>} */
        this.processes = new Map();
        /** @type {Set<number>} */
        this._knownPids = new Set();
    }

    _spawnHidden(command, args) {
        const options = { windowsHide: true, detached: false, stdio: ["ignore", "ignore", "pipe"] };
        if (process.platform === "win32") {
            options.creationFlags = CREATE_NO_WINDOW;
        }
        return spawn(command, args, options);
    }

    _killPidTree(pid) {
        if (!pid || !Number.isInteger(pid) || pid <= 0) return;
        if (process.platform === "win32") {
            try {
                const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
                    windowsHide: true,
                    stdio: "ignore",
                    detached: true
                });
                killer.unref?.();
            } catch (_) {
                /* ignore */
            }
            return;
        }
        try {
            process.kill(pid, "SIGKILL");
        } catch (_) {
            /* ignore */
        }
    }

    async _killOrphanScrcpyAudioProcesses() {
        if (process.platform !== "win32") return;

        await new Promise((resolve) => {
            const script = [
                "$killed = @()",
                "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'scrcpy.exe'\" -ErrorAction SilentlyContinue",
                "foreach ($p in $procs) {",
                "  if ($p.CommandLine -and (($p.CommandLine -like '*--no-video*') -or (($p.CommandLine -like '*--record=NUL*') -and ($p.CommandLine -notlike '*--no-audio*')))) {",
                "    $killed += $p.ProcessId",
                "    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue",
                "    & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null",
                "  }",
                "}",
                "if ($killed.Count -gt 0) { $killed -join ',' } else { '' }"
            ].join("; ");

            execFile(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", script],
                { windowsHide: true, timeout: 8000 },
                (err, stdout) => {
                    const text = String(stdout || "").trim();
                    if (text) {
                        console.log(`[SessionAudio] orphans --no-video tues: ${text}`);
                    } else if (err) {
                        console.warn(`[SessionAudio] orphan sweep:`, err.message || err);
                    }
                    resolve();
                }
            );
        });
    }

    _resolveDeviceKey(entry, niSession, serial) {
        return entry?.stableDeviceId
            || niSession?.stableDeviceId
            || entry?.deviceId
            || serial
            || null;
    }

    _buildArgs({ serial, displayId }) {
        // audio-source=output (défaut) : REMOTE_SUBMIX → pas de son sur le HP device.
        // Pas de --no-audio / --no-audio-playback : mute PC = volume remote 0, même process.
        const args = [
            "--serial", serial,
            "--no-video",
            "--no-window",
            "--no-control",
            "--audio-buffer=100"
        ];

        if (Number.isInteger(displayId)) {
            args.push(`--display-id=${displayId}`);
        }

        return args;
    }

    _attachLogging(sessionId, child) {
        child.stderr?.on("data", (chunk) => {
            const line = chunk.toString().trim();
            if (line) {
                console.log(`[SessionAudio ${sessionId}] ${line}`);
            }
        });
        child.on("exit", (code) => {
            const entry = this.processes.get(sessionId);
            if (entry?.child === child) {
                this.processes.delete(sessionId);
            }
            if (child.pid) {
                this._knownPids.delete(child.pid);
            }
            if (code && code !== 0) {
                console.warn(`[SessionAudio ${sessionId}] processus termine (code ${code})`);
            }
        });
    }

    isRunning(sessionId) {
        const entry = this.processes.get(sessionId);
        return Boolean(entry?.child && !entry.child.killed && entry.child.exitCode === null);
    }

    async stop(sessionId) {
        const entry = this.processes.get(sessionId);
        const child = entry?.child || null;
        const pid = entry?.pid || child?.pid || null;

        this.processes.delete(sessionId);

        if (!child && !pid) return;

        console.log(`[SessionAudio ${sessionId}] arret (pid=${pid || "?"})`);

        if (pid) {
            this._killPidTree(pid);
            this._knownPids.delete(pid);
        }

        try {
            if (child && !child.killed) {
                child.kill();
            }
        } catch (_) {
            /* ignore */
        }

        await new Promise((resolve) => {
            if (!child) {
                setTimeout(resolve, 150);
                return;
            }
            const timer = setTimeout(() => {
                if (pid) this._killPidTree(pid);
                resolve();
            }, 600);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    async start(sessionId, { serial, displayId = null, deviceKey = null } = {}) {
        if (!sessionId || !serial) return { success: false, error: "sessionId ou serial manquant" };
        if (!this.scrcpyBinaryPath) return { success: false, error: "scrcpy introuvable" };

        const fs = require("fs");
        if (!fs.existsSync(this.scrcpyBinaryPath)) {
            return { success: false, error: `scrcpy introuvable: ${this.scrcpyBinaryPath}` };
        }

        const key = deviceKey || serial;
        const normalizedDisplayId = Number.isInteger(displayId) ? displayId : null;
        const existing = this.processes.get(sessionId);
        if (
            existing
            && existing.serial === serial
            && existing.displayId === normalizedDisplayId
            && existing.deviceKey === key
            && this.isRunning(sessionId)
        ) {
            return { success: true, reused: true };
        }

        const args = this._buildArgs({
            serial,
            displayId: normalizedDisplayId
        });
        console.log(`[SessionAudio ${sessionId}] demarrage scrcpy audio (${args.join(" ")})`);

        await this.stop(sessionId);

        try {
            const child = this._spawnHidden(this.scrcpyBinaryPath, args);
            const pid = child.pid || null;
            if (pid) this._knownPids.add(pid);

            this.processes.set(sessionId, {
                child,
                serial,
                displayId: normalizedDisplayId,
                pid,
                deviceKey: key
            });
            this._attachLogging(sessionId, child);

            return { success: true };
        } catch (err) {
            return { success: false, error: err.message || "echec spawn scrcpy audio" };
        }
    }

    async refreshForGlobalAudio() {
        await this.syncAllActiveSessions();
    }

    setResolvers({ getBrowserViewManager, getNewInstanceManager } = {}) {
        this._getBrowserViewManager = typeof getBrowserViewManager === "function" ? getBrowserViewManager : null;
        this._getNewInstanceManager = typeof getNewInstanceManager === "function" ? getNewInstanceManager : null;
    }

    _listActiveSessionTargets() {
        const browserViewManager = this._getBrowserViewManager?.();
        if (!browserViewManager) return [];

        const sessions = browserViewManager.getAllSessions?.() || [];
        const targets = [];

        for (const session of sessions) {
            const sessionId = session?.sessionId;
            const entry = browserViewManager.getSessionEntry?.(sessionId);
            const niSession = entry?.type === "B"
                ? this._getNewInstanceManager?.()?.getNewInstanceSession?.(sessionId)
                : null;
            let serial = entry?.deviceId || niSession?.serial;
            if (!sessionId || !serial) continue;

            const deviceKey = this._resolveDeviceKey(entry, niSession, serial);
            let displayId = null;
            if (entry?.type === "B") {
                displayId = Number.isInteger(niSession?.displayId) ? niSession.displayId : null;
            }

            targets.push({ sessionId, serial, displayId, deviceKey, entry, niSession });
        }

        return targets;
    }

    async _resolveSerial(target) {
        let serial = target.serial;
        if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
            const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
                deviceId: target.entry?.stableDeviceId || target.niSession?.stableDeviceId || null,
                serial
            });
            if (resolved) serial = resolved;
        }
        return serial;
    }

    _matchesDeviceKey(target, deviceKey) {
        if (!deviceKey) return false;
        return target.deviceKey === deviceKey
            || target.serial === deviceKey
            || target.entry?.deviceId === deviceKey
            || target.entry?.stableDeviceId === deviceKey
            || target.niSession?.stableDeviceId === deviceKey
            || target.niSession?.serial === deviceKey;
    }

    /**
     * Garde une capture audio pour chaque session active.
     * Mute PC ne change rien ici (volume remote 0 côté overlay).
     */
    async syncAllActiveSessions() {
        const targets = this._listActiveSessionTargets();
        const activeIds = new Set();

        for (const target of targets) {
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            activeIds.add(target.sessionId);
            await this.start(target.sessionId, {
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey
            });
        }

        for (const sessionId of [...this.processes.keys()]) {
            if (!activeIds.has(sessionId)) {
                await this.stop(sessionId);
            }
        }
    }

    /**
     * ON/OFF device : s'assure que la capture tourne (ne redémarre pas pour mute).
     */
    async syncDeviceSessions(deviceKey, _muted) {
        const key = typeof deviceKey === "string" ? deviceKey.trim() : "";
        if (!key) return;

        for (const target of this._listActiveSessionTargets()) {
            if (!this._matchesDeviceKey(target, key)) continue;
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            await this.start(target.sessionId, {
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey || key
            });
        }
    }

    async stopAll() {
        const ids = [...this.processes.keys()];
        console.log(`[SessionAudio] stopAll (${ids.length} tracked, ${this._knownPids.size} pids connus)`);

        await Promise.allSettled(ids.map((id) => this.stop(id)));

        for (const pid of [...this._knownPids]) {
            console.log(`[SessionAudio] kill orphelin pid=${pid}`);
            this._killPidTree(pid);
            this._knownPids.delete(pid);
        }

        this.processes.clear();
        this._knownPids.clear();

        await this._killOrphanScrcpyAudioProcesses();
    }
}

module.exports = { SessionAudioProcessManager };
