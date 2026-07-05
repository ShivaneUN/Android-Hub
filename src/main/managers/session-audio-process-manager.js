const { spawn } = require("child_process");

const CREATE_NO_WINDOW = 0x08000000;

/**
 * Lecture audio PC via scrcpy.exe (--no-video).
 * Un processus par session ; le socket Hub reste vidéo seule (audio:false).
 */
class SessionAudioProcessManager {
    constructor(scrcpyBinaryPath) {
        this.scrcpyBinaryPath = scrcpyBinaryPath;
        /** @type {Map<string, { child: import('child_process').ChildProcess, serial: string, displayId: number|null }>} */
        this.processes = new Map();
    }

    _spawnHidden(command, args) {
        const options = { windowsHide: true, detached: false, stdio: ["ignore", "ignore", "pipe"] };
        if (process.platform === "win32") {
            options.creationFlags = CREATE_NO_WINDOW;
        }
        return spawn(command, args, options);
    }

    _buildArgs({ serial, displayId }) {
        const manager = global.globalAudioOutputManager;
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

        if (manager?.isGlobalMuted?.()) {
            args.push("--no-audio");
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
        if (!entry?.child || entry.child.killed) {
            this.processes.delete(sessionId);
            return;
        }

        const child = entry.child;
        this.processes.delete(sessionId);

        try {
            child.kill("SIGTERM");
        } catch (_) {
            /* ignore */
        }

        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    async start(sessionId, { serial, displayId = null } = {}) {
        if (!sessionId || !serial) return { success: false, error: "sessionId ou serial manquant" };
        if (!this.scrcpyBinaryPath) return { success: false, error: "scrcpy introuvable" };

        const fs = require("fs");
        if (!fs.existsSync(this.scrcpyBinaryPath)) {
            return { success: false, error: `scrcpy introuvable: ${this.scrcpyBinaryPath}` };
        }

        if (global.globalAudioOutputManager?.isGlobalMuted?.()) {
            await this.stop(sessionId);
            return { success: true, skipped: true, reason: "global-muted" };
        }

        const normalizedDisplayId = Number.isInteger(displayId) ? displayId : null;
        const existing = this.processes.get(sessionId);
        if (
            existing
            && existing.serial === serial
            && existing.displayId === normalizedDisplayId
            && this.isRunning(sessionId)
        ) {
            return { success: true, reused: true };
        }

        await this.stop(sessionId);

        const args = this._buildArgs({ serial, displayId: normalizedDisplayId });
        console.log(`[SessionAudio ${sessionId}] demarrage scrcpy audio (${args.join(" ")})`);

        try {
            const child = this._spawnHidden(this.scrcpyBinaryPath, args);
            this.processes.set(sessionId, {
                child,
                serial,
                displayId: normalizedDisplayId
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

    async syncAllActiveSessions() {
        if (global.globalAudioOutputManager?.isGlobalMuted?.()) {
            await this.stopAll();
            return;
        }

        const browserViewManager = this._getBrowserViewManager?.();
        if (!browserViewManager) return;

        const sessions = browserViewManager.getAllSessions?.() || [];
        const activeIds = new Set();

        for (const session of sessions) {
            const sessionId = session?.sessionId;
            const entry = browserViewManager.getSessionEntry?.(sessionId);
            const niSession = entry?.type === "B"
                ? this._getNewInstanceManager?.()?.getNewInstanceSession?.(sessionId)
                : null;
            let serial = entry?.deviceId || niSession?.serial;
            if (!sessionId || !serial) continue;

            if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
                const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
                    deviceId: entry?.stableDeviceId || niSession?.stableDeviceId || null,
                    serial
                });
                if (resolved) serial = resolved;
            }

            let displayId = null;
            if (entry?.type === "B") {
                displayId = Number.isInteger(niSession?.displayId) ? niSession.displayId : null;
            }

            activeIds.add(sessionId);
            await this.start(sessionId, { serial, displayId });
        }

        for (const sessionId of [...this.processes.keys()]) {
            if (!activeIds.has(sessionId)) {
                await this.stop(sessionId);
            }
        }
    }

    async stopAll() {
        const ids = [...this.processes.keys()];
        await Promise.allSettled(ids.map((id) => this.stop(id)));
    }
}

module.exports = { SessionAudioProcessManager };
