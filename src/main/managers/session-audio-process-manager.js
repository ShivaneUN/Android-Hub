const { spawn, execFile } = require("child_process");

const CREATE_NO_WINDOW = 0x08000000;

/**
 * Capture audio device → PC via scrcpy.exe dédié.
 * Args : --no-video --no-window --no-control --audio-buffer=100
 * (source = output / REMOTE_SUBMIX → HP device toujours muet tant que la capture vit).
 *
 * Principe (comme screen OFF) :
 * - Lancement / OFF : pas de son PC (--no-audio-playback) + HP muet (capture)
 * - ON global / device : son PC + HP toujours muet (même capture, lecture activée)
 */
class SessionAudioProcessManager {
    constructor(scrcpyBinaryPath) {
        this.scrcpyBinaryPath = scrcpyBinaryPath;
        /** @type {Map<string, { child: import('child_process').ChildProcess, serial: string, displayId: number|null, pid: number|null, deviceKey: string|null, pcPlayback: boolean }>} */
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

    /** Lecture PC : défaut OFF (mute HP via capture, pas de son PC). */
    _wantPcPlayback(deviceKey, aliasKeys = []) {
        const audio = global.globalAudioOutputManager;
        if (!audio?.isDeviceAudioEnabled) return false;
        return Boolean(audio.isDeviceAudioEnabled(deviceKey, aliasKeys));
    }

    _buildArgs({ serial, displayId, pcPlayback }) {
        // audio-source=output (défaut) : REMOTE_SUBMIX → pas de son sur le HP device.
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

        // OFF PC : coupe la lecture sur le PC, garde la capture (HP device silencieux).
        if (!pcPlayback) {
            args.push("--no-audio-playback");
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

    /** true si une capture scrcpy audio Hub tourne pour ce serial / deviceKey. */
    hasCaptureForSerial(serial, deviceKey = null) {
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();
        if (!needle && !key) return false;
        for (const [sessionId, entry] of this.processes.entries()) {
            if (!entry || !this.isRunning(sessionId)) continue;
            if (needle && entry.serial === needle) return true;
            if (key && entry.deviceKey && entry.deviceKey === key) return true;
            if (needle && entry.serial && (
                needle.startsWith(entry.serial)
                || entry.serial.startsWith(needle)
            )) {
                return true;
            }
        }
        return false;
    }

    /**
     * Réattache une capture existante (ex. launch-*) sur le vrai sessionId
     * sans relâcher REMOTE_SUBMIX.
     */
    adoptCaptureForSession(sessionId, { serial = null, deviceKey = null } = {}) {
        if (!sessionId) return false;
        if (this.isRunning(sessionId)) return true;
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();
        if (!needle && !key) return false;
        for (const [id, entry] of this.processes.entries()) {
            if (id === sessionId || !entry || !this.isRunning(id)) continue;
            const sameSerial = needle && entry.serial && (
                entry.serial === needle
                || needle.startsWith(entry.serial)
                || entry.serial.startsWith(needle)
            );
            const sameKey = key && entry.deviceKey && entry.deviceKey === key;
            if (!sameSerial && !sameKey) continue;
            this.processes.delete(id);
            this.processes.set(sessionId, entry);
            console.log(`[SessionAudio] adopt ${id} → ${sessionId} (serial=${entry.serial})`);
            return true;
        }
        return false;
    }

    /**
     * Arrête les captures pour un serial (ex. handoff launchId → sessionId),
     * en gardant éventuellement une session.
     */
    async stopBySerial(serial, { exceptSessionId = null, deviceKey = null } = {}) {
        const needle = String(serial || "").trim();
        const key = String(deviceKey || "").trim();
        if (!needle && !key) return;
        const toStop = [];
        for (const [sessionId, entry] of this.processes.entries()) {
            if (exceptSessionId && sessionId === exceptSessionId) continue;
            if (!entry) continue;
            const sameSerial = needle && entry.serial && (
                entry.serial === needle
                || needle.startsWith(entry.serial)
                || entry.serial.startsWith(needle)
            );
            const sameKey = key && entry.deviceKey && entry.deviceKey === key;
            if (sameSerial || sameKey) toStop.push(sessionId);
        }
        for (const sessionId of toStop) {
            await this.stop(sessionId);
        }
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

    async start(sessionId, { serial, displayId = null, deviceKey = null, pcPlayback = null } = {}) {
        if (!sessionId || !serial) return { success: false, error: "sessionId ou serial manquant" };
        if (!this.scrcpyBinaryPath) return { success: false, error: "scrcpy introuvable" };

        const fs = require("fs");
        if (!fs.existsSync(this.scrcpyBinaryPath)) {
            return { success: false, error: `scrcpy introuvable: ${this.scrcpyBinaryPath}` };
        }

        const key = deviceKey || serial;
        const wantPlayback = typeof pcPlayback === "boolean"
            ? pcPlayback
            : this._wantPcPlayback(key);
        const normalizedDisplayId = Number.isInteger(displayId) ? displayId : null;
        const existing = this.processes.get(sessionId);
        if (
            existing
            && existing.serial === serial
            && existing.displayId === normalizedDisplayId
            && existing.deviceKey === key
            && existing.pcPlayback === wantPlayback
            && this.isRunning(sessionId)
        ) {
            return { success: true, reused: true, pcPlayback: wantPlayback };
        }

        const args = this._buildArgs({
            serial,
            displayId: normalizedDisplayId,
            pcPlayback: wantPlayback
        });
        console.log(
            `[SessionAudio ${sessionId}] demarrage scrcpy audio `
            + `(pcPlayback=${wantPlayback ? "on" : "off"} ; ${args.join(" ")})`
        );

        // Hot-swap si seul pcPlayback change : nouveau process AVANT de tuer l'ancien
        // pour ne pas relâcher REMOTE_SUBMIX (sinon son sur le HP device).
        const canHotSwap = Boolean(
            existing
            && this.isRunning(sessionId)
            && existing.serial === serial
            && existing.displayId === normalizedDisplayId
            && existing.deviceKey === key
            && existing.pcPlayback !== wantPlayback
        );

        let oldEntry = null;
        if (canHotSwap) {
            oldEntry = existing;
            this.processes.delete(sessionId);
        } else {
            await this.stop(sessionId);
        }

        try {
            const child = this._spawnHidden(this.scrcpyBinaryPath, args);
            const pid = child.pid || null;
            if (pid) this._knownPids.add(pid);

            this.processes.set(sessionId, {
                child,
                serial,
                displayId: normalizedDisplayId,
                pid,
                deviceKey: key,
                pcPlayback: wantPlayback
            });
            this._attachLogging(sessionId, child);

            if (oldEntry) {
                setTimeout(() => {
                    const oldPid = oldEntry.pid || oldEntry.child?.pid || null;
                    if (oldPid) {
                        this._killPidTree(oldPid);
                        this._knownPids.delete(oldPid);
                    }
                    try {
                        if (oldEntry.child && !oldEntry.child.killed) oldEntry.child.kill();
                    } catch (_err) {
                        /* ignore */
                    }
                }, 280);
            }

            return { success: true, pcPlayback: wantPlayback, hotSwap: Boolean(oldEntry) };
        } catch (err) {
            if (oldEntry) {
                this.processes.set(sessionId, oldEntry);
            }
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

    /**
     * Captures scrcpy audio encore vivantes (y compris launch-* avant handoff).
     */
    getRunningCaptures() {
        const out = [];
        for (const [sessionId, entry] of this.processes.entries()) {
            if (!entry || !this.isRunning(sessionId)) continue;
            out.push({
                sessionId,
                serial: entry.serial,
                displayId: entry.displayId,
                deviceKey: entry.deviceKey || entry.serial,
                pcPlayback: Boolean(entry.pcPlayback)
            });
        }
        return out;
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
            // Préférer le serial ADB (niSession / deviceId transport), pas seulement stableId.
            let serial = niSession?.serial || entry?.deviceId || session?.deviceId || null;
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
     * Cibles audio actives (une entrée par session), serial ADB résolu.
     */
    async getActiveAudioTargets() {
        const out = [];
        for (const target of this._listActiveSessionTargets()) {
            const serial = await this._resolveSerial(target);
            if (!serial) continue;
            out.push({
                sessionId: target.sessionId,
                serial,
                displayId: target.displayId,
                deviceKey: target.deviceKey
            });
        }
        return out;
    }

    /**
     * Une capture par session, avec pcPlayback selon mute global/device.
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
     * Resync capture(s) d'un device — redémarre si ON/OFF (pcPlayback) a changé.
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

    async syncDeviceSessionsWithAliases(deviceKey, aliasKeys = [], muted) {
        const keys = [deviceKey, ...(Array.isArray(aliasKeys) ? aliasKeys : [])]
            .map((k) => String(k || "").trim())
            .filter(Boolean);
        const unique = [...new Set(keys)];
        if (!unique.length) return;
        for (const key of unique) {
            await this.syncDeviceSessions(key, muted);
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
