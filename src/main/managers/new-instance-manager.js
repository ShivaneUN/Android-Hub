const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { ScrcpySocketClient } = require("../../native/scrcpy/scrcpy-socket");
const { AdbInputController } = require("../../native/scrcpy/control/adb-input-controller");

class NewInstanceManager extends EventEmitter {
    constructor({ adbPath, serverJarPath, scrcpyBinaryPath, launchPackageOnDisplay }) {
        super();
        this.adbPath = adbPath;
        this.serverJarPath = serverJarPath;
        this.scrcpyBinaryPath = scrcpyBinaryPath;
        this.launchPackageOnDisplay = launchPackageOnDisplay;
        this.sessions = new Map();
    }

    createNewInstanceSession({ serial, packageName, userId = null, tabLabel = "Nouvelle instance" }) {
        if (!serial) {
            throw new Error("serial manquant");
        }
        if (!packageName) {
            throw new Error("packageName manquant");
        }

        const sessionId = `new-instance-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const session = {
            sessionId,
            serial,
            packageName,
            userId: Number.isInteger(userId) ? userId : null,
            tabLabel,
            state: "created",
            displayId: null,
            launcher: null,
            client: null,
            inputController: null,
            streamSize: null,
            launcherStopped: false
        };

        this.sessions.set(sessionId, session);
        return session;
    }

    listNewInstanceSessions() {
        return Array.from(this.sessions.values()).map((s) => ({
            sessionId: s.sessionId,
            serial: s.serial,
            packageName: s.packageName,
            userId: s.userId,
            tabLabel: s.tabLabel,
            state: s.state,
            displayId: s.displayId
        }));
    }

    getNewInstanceSession(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    async startNewInstanceSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session introuvable: ${sessionId}`);
        }
        if (session.state === "started") {
            return session;
        }

        session.state = "starting";
        this.emit("state", {
            sessionId,
            state: session.state,
            serial: session.serial,
            packageName: session.packageName
        });

        session.launcher = this._startLauncher(session);

        const launcherDisplayId = await this._waitForLauncherDisplay(session);
        session.displayId = Number.isInteger(launcherDisplayId) ? launcherDisplayId : null;

        const client = new ScrcpySocketClient(this.adbPath, session.serial);
        session.client = client;

        client.on("codec-meta", (meta) => {
            session.streamSize = { width: meta.width, height: meta.height };
            this.emit("video-codec-meta", { sessionId, ...meta });
        });

        client.on("raw-packet", (packet) => {
            this.emit("video-packet", {
                sessionId,
                pts: packet.pts.toString(),
                isConfig: packet.isConfig,
                isKeyFrame: packet.isKeyFrame,
                data: packet.data
            });
        });

        client.on("error", (err) => {
            this.emit("video-error", { sessionId, error: err.message });
        });

        client.on("closed", () => {
            if (session.state !== "stopped") {
                session.state = "stopped";
                this.emit("state", { sessionId, state: session.state });
            }
        });

        try {
            if (Number.isInteger(session.displayId)) {
                await client.start(this.serverJarPath, { displayId: session.displayId });
            } else {
                await client.start(this.serverJarPath, { newDisplay: "1920x1080" });
                if (this.launchPackageOnDisplay) {
                    await this.launchPackageOnDisplay(session.serial, session.packageName, client.getNewDisplayId(), {
                        userId: session.userId
                    });
                }
            }

            session.state = "started";
            this.emit("state", {
                sessionId,
                state: session.state,
                displayId: session.displayId,
                serial: session.serial,
                packageName: session.packageName
            });
            return session;
        } catch (err) {
            session.state = "error";
            this.emit("state", { sessionId, state: session.state, error: err.message });
            throw err;
        }
    }

    async stopNewInstanceSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.state = "stopping";

        if (session.client) {
            try {
                session.client.stop();
            } catch (_err) {
                // noop
            }
            session.client = null;
        }

        if (session.inputController) {
            try {
                session.inputController = null;
            } catch (_err) {
                // noop
            }
        }

        if (session.launcher && !session.launcher.killed) {
            try {
                session.launcherStopped = true;
                session.launcher.kill();
            } catch (_err) {
                // noop
            }
        }

        session.state = "stopped";
        this.emit("state", { sessionId, state: session.state });
        this.sessions.delete(sessionId);
    }

    async routeInputToSession(sessionId, payload = {}) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session introuvable: ${sessionId}`);
        }

        const { type, action, x, y, key, streamWidth, streamHeight } = payload;

        if (!session.inputController) {
            session.inputController = new AdbInputController(this.adbPath, session.serial);
            await session.inputController.init();
        }

        if (streamWidth && streamHeight) {
            session.streamSize = { width: streamWidth, height: streamHeight };
            if (session.inputController.setStreamSize) {
                session.inputController.setStreamSize(streamWidth, streamHeight);
            }
        }

        const client = session.client;
        const controlSize = session.streamSize || { width: streamWidth || 0, height: streamHeight || 0 };

        if (client && client.controlSocket) {
            if (type === "touch") {
                if (action === "down") return client.sendTouchEvent(0, x, y, controlSize.width, controlSize.height);
                if (action === "up") return client.sendTouchEvent(1, x, y, controlSize.width, controlSize.height);
                if (action === "move") return client.sendTouchEvent(2, x, y, controlSize.width, controlSize.height);
            }
            if (type === "key") {
                return session.inputController.sendKey(key);
            }
        }

        if (type === "touch") {
            return session.inputController.sendTouch(action, x, y, true);
        }
        if (type === "key") {
            return session.inputController.sendKey(key);
        }

        throw new Error(`Type input non supporte: ${type}`);
    }

    _startLauncher(session) {
        const args = [
            "--serial", session.serial,
            "--new-display=1920x1080",
            `--start-app=${session.packageName}`,
            "--no-window",
            "--record=NUL",
            "--record-format=mkv"
        ];

        const child = spawn(this.scrcpyBinaryPath, args, {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });

        const parseDisplayLine = (line) => {
            const text = String(line || "").trim();
            if (!text) return;
            const match = text.match(/New display:.*\(id=(\d+)\)/i);
            if (!match) return;
            const displayId = Number(match[1]);
            if (Number.isInteger(displayId)) {
                session.displayId = displayId;
                this.emit("state", {
                    sessionId: session.sessionId,
                    state: "display-ready",
                    displayId,
                    serial: session.serial,
                    packageName: session.packageName
                });
            }
        };

        child.stdout.on("data", (data) => {
            const lines = data.toString().split(/\r?\n/);
            lines.forEach(parseDisplayLine);
        });

        child.stderr.on("data", (data) => {
            const lines = data.toString().split(/\r?\n/);
            lines.forEach(parseDisplayLine);
        });

        child.on("exit", () => {
            if (!session.launcherStopped && session.state !== "stopped") {
                this.emit("state", {
                    sessionId: session.sessionId,
                    state: "launcher-exited",
                    serial: session.serial,
                    packageName: session.packageName
                });
            }
        });

        return child;
    }

    async _waitForLauncherDisplay(session, timeoutMs = 4500) {
        if (Number.isInteger(session.displayId)) {
            return session.displayId;
        }

        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve(null);
            }, timeoutMs);

            const onState = (payload) => {
                if (!payload || payload.sessionId !== session.sessionId) return;
                if (payload.state === "display-ready" && Number.isInteger(payload.displayId)) {
                    cleanup();
                    resolve(payload.displayId);
                }
            };

            const cleanup = () => {
                clearTimeout(timer);
                this.removeListener("state", onState);
            };

            this.on("state", onState);
        });
    }
}

module.exports = { NewInstanceManager };
