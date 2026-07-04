const { EventEmitter } = require("events");
const { exec } = require("child_process");
const { ScrcpySocketClient } = require("../../native/scrcpy/scrcpy-socket");
const { AdbInputController, KEYCODE_MAP } = require("../../native/scrcpy/control/adb-input-controller");
const { DEFAULT_STREAM_PARAMS, toScrcpyOptions } = require("../../shared/stream-params");

const KEY_ACTION_DOWN = 0;
const KEY_ACTION_UP = 1;
const TOUCH_ACTION_MAP = {
    down: 0,
    up: 1,
    move: 2
};

async function sendTouchViaScrcpyClient(client, action, x, y, controlSize) {
    if (action === "tap") {
        return client.sendTap(x, y, controlSize.width, controlSize.height);
    }
    const mapped = TOUCH_ACTION_MAP[action];
    if (mapped === undefined) {
        throw new Error(`Action touch inconnue: ${action}`);
    }
    return client.sendTouchEvent(mapped, x, y, controlSize.width, controlSize.height);
}

function mergeTypeBScrcpyOptions(scrcpyOptions = {}, session = null) {
    const merged = {
        ...(session?.streamOptions || {}),
        ...scrcpyOptions
    };
    merged.newDisplay = scrcpyOptions.newDisplay
        || session?.streamOptions?.newDisplay
        || toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay;
    merged.stayAwake = true;
    merged.turnScreenOff = true;
    merged.audio = scrcpyOptions.audio === true;
    return merged;
}

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

class NewInstanceManager extends EventEmitter {
    constructor({ adbPath, serverJarPath, scrcpyBinaryPath, launchPackageOnDisplay, onStreamMeta }) {
        super();
        this.adbPath = adbPath;
        this.serverJarPath = serverJarPath;
        this.scrcpyBinaryPath = scrcpyBinaryPath;
        this.launchPackageOnDisplay = launchPackageOnDisplay;
        this.onStreamMeta = typeof onStreamMeta === "function" ? onStreamMeta : null;
        this.sessions = new Map();
    }

    createNewInstanceSession({
        serial,
        packageName,
        userId = null,
        tabLabel = "Nouvelle instance",
        streamOptions = null,
        presetDisplayId = null,
        skipPackageLaunch = false,
        externalLaunchId = null
    }) {
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
            displayId: Number.isInteger(presetDisplayId) ? presetDisplayId : null,
            presetDisplayId: Number.isInteger(presetDisplayId) ? presetDisplayId : null,
            skipPackageLaunch: Boolean(skipPackageLaunch),
            externalLaunchId: externalLaunchId || null,
            client: null,
            inputController: null,
            streamSize: null,
            streamOptions: streamOptions || { newDisplay: toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay }
        };

        this.sessions.set(sessionId, session);
        if (Number.isInteger(session.displayId)) {
            this._prewarmInputController(session);
        }
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

    isExternalLaunchOwned(externalLaunchId) {
        if (!externalLaunchId) return false;
        for (const session of this.sessions.values()) {
            if (session.externalLaunchId !== externalLaunchId) continue;
            if (session.state === "stopped" || session.state === "stopping") continue;
            return true;
        }
        return false;
    }

    _waitForClientDisplayId(client, timeoutMs = 10000) {
        const existing = client.getNewDisplayId();
        if (Number.isInteger(existing)) {
            return Promise.resolve(existing);
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve(client.getNewDisplayId());
            }, timeoutMs);

            const onDisplayReady = ({ displayId }) => {
                if (Number.isInteger(displayId)) {
                    cleanup();
                    resolve(displayId);
                }
            };

            const cleanup = () => {
                clearTimeout(timer);
                client.removeListener("new-display-id", onDisplayReady);
            };

            client.on("new-display-id", onDisplayReady);
        });
    }

    async _ensureDeviceStayAwake(serial) {
        if (!serial) return;
        try {
            await execPromise(`"${this.adbPath}" -s ${serial} shell svc power stayon true`);
        } catch (err) {
            console.warn(`[NewInstanceManager] stayon ${serial}:`, err.message);
        }
    }

    async _turnOffPhysicalScreen(session) {
        if (!session?.serial) return;

        await this._ensureDeviceStayAwake(session.serial);

        const isVirtualDisplay = Number.isInteger(session.presetDisplayId)
            || (Number.isInteger(session.displayId) && session.displayId !== 0);

        const client = session.client;
        if (!isVirtualDisplay && client?.controlSocket && typeof client.setDisplayPower === "function") {
            try {
                await client.setDisplayPower(false);
                session.physicalScreenOff = true;
                console.log(`[NewInstanceManager] Ecran physique eteint (${session.sessionId})`);
                return;
            } catch (err) {
                console.warn(`[NewInstanceManager] setDisplayPower(false):`, err.message);
            }
        }

        try {
            await execPromise(`"${this.adbPath}" -s ${session.serial} shell input keyevent 223`);
            session.physicalScreenOff = true;
            console.log(`[NewInstanceManager] Ecran physique eteint via keyevent (${session.sessionId})`);
        } catch (err) {
            console.warn(`[NewInstanceManager] fallback keyevent sleep:`, err.message);
        }
    }

    _syncSessionDisplayId(session) {
        if (Number.isInteger(session.displayId)) return session.displayId;

        const fromClient = session.client?.getNewDisplayId?.();
        if (Number.isInteger(fromClient)) {
            session.displayId = fromClient;
            return fromClient;
        }

        if (Number.isInteger(session.presetDisplayId)) {
            session.displayId = session.presetDisplayId;
            return session.presetDisplayId;
        }

        return null;
    }

    _resolveControlSize(session, client, streamWidth, streamHeight) {
        if (streamWidth > 0 && streamHeight > 0) {
            return { width: streamWidth, height: streamHeight };
        }
        if (session.streamSize?.width > 0 && session.streamSize?.height > 0) {
            return { width: session.streamSize.width, height: session.streamSize.height };
        }
        const videoSize = client?.getVideoStreamSize?.();
        if (videoSize?.width > 0 && videoSize?.height > 0) {
            return videoSize;
        }
        if (session.inputController?.deviceWidth > 0 && session.inputController?.deviceHeight > 0) {
            return {
                width: session.inputController.deviceWidth,
                height: session.inputController.deviceHeight
            };
        }
        return { width: 1920, height: 1080 };
    }

    async _ensureSessionInputController(session, streamWidth, streamHeight) {
        if (!session.inputController) {
            session.inputController = new AdbInputController(this.adbPath, session.serial);
            await session.inputController.init();
        }

        this._syncSessionDisplayId(session);

        if (Number.isInteger(session.displayId)) {
            session.inputController.setDisplayId(session.displayId);
        }

        if (streamWidth > 0 && streamHeight > 0) {
            session.streamSize = { width: streamWidth, height: streamHeight };
            session.inputController.setStreamSize(streamWidth, streamHeight);
        } else if (session.streamSize?.width > 0 && session.streamSize?.height > 0) {
            session.inputController.setStreamSize(session.streamSize.width, session.streamSize.height);
        }

        return session.inputController;
    }

    _prewarmInputController(session) {
        if (session._inputPrewarmStarted) return;
        session._inputPrewarmStarted = true;

        void this._ensureSessionInputController(session, null, null)
            .then(() => {
                console.log(
                    `[NewInstance] Input ADB pret pour ${session.sessionId}`,
                    Number.isInteger(session.displayId) ? `(displayId=${session.displayId})` : ""
                );
            })
            .catch((err) => {
                session._inputPrewarmStarted = false;
                console.warn(`[NewInstance] prewarm input ${session.sessionId}:`, err.message);
            });
    }

    async _sendTouchViaScrcpy(client, action, x, y, controlSize) {
        return sendTouchViaScrcpyClient(client, action, x, y, controlSize);
    }

    async _sendKeyViaScrcpy(client, key, session) {
        if (key.length === 1) {
            if (!session.inputController) {
                session.inputController = new AdbInputController(this.adbPath, session.serial);
                await session.inputController.init();
                this._syncSessionDisplayId(session);
                if (Number.isInteger(session.displayId)) {
                    session.inputController.setDisplayId(session.displayId);
                }
            }
            return session.inputController.sendKey(key);
        }

        const keycode = KEYCODE_MAP[key] ?? Number(key);
        if (!Number.isFinite(keycode)) {
            throw new Error(`Touche Android inconnue: ${key}`);
        }

        await client.sendKeyCode(KEY_ACTION_DOWN, keycode);
        return client.sendKeyCode(KEY_ACTION_UP, keycode);
    }

    _attachClientEvents(session, client) {
        client.on("new-display-id", ({ displayId }) => {
            if (Number.isInteger(displayId)) {
                session.displayId = displayId;
            }
        });

        client.on("codec-meta", (meta) => {
            session.streamSize = { width: meta.width, height: meta.height };
            if (this.onStreamMeta) {
                this.onStreamMeta(session.serial, meta, session.sessionId);
            }
            this.emit("video-codec-meta", { sessionId: session.sessionId, ...meta });
        });

        client.on("raw-packet", (packet) => {
            this.emit("video-packet", {
                sessionId: session.sessionId,
                pts: packet.pts.toString(),
                isConfig: packet.isConfig,
                isKeyFrame: packet.isKeyFrame,
                data: packet.data
            });
        });

        client.on("audio-codec-meta", (meta) => {
            this.emit("audio-codec-meta", { sessionId: session.sessionId, ...meta });
        });

        client.on("raw-audio-packet", (packet) => {
            this.emit("audio-packet", {
                sessionId: session.sessionId,
                pts: packet.pts.toString(),
                isConfig: packet.isConfig,
                isKeyFrame: packet.isKeyFrame,
                data: packet.data
            });
        });

        client.on("error", (err) => {
            this.emit("video-error", { sessionId: session.sessionId, error: err.message });
        });

        client.on("closed", () => {
            void this._onScrcpyClosed(session);
        });
    }

    async _onScrcpyClosed(session) {
        if (!session) return;

        if (session._intentionalStop || session._appForceStopped) {
            if (session.state !== "stopped" && session.state !== "stopping") {
                session.state = "stopped";
                this.emit("state", { sessionId: session.sessionId, state: session.state });
            }
            return;
        }

        const wasActive = session.state === "started"
            || session.state === "starting"
            || session.state === "display-ready";
        if (!wasActive || !session.packageName || !session.serial) {
            if (session.state !== "stopped") {
                session.state = "stopped";
                this.emit("state", { sessionId: session.sessionId, state: session.state });
            }
            return;
        }

        console.log(`[NewInstanceManager] Scrcpy ferme — force-stop ${session.packageName} (${session.sessionId})`);
        session._appForceStopped = true;
        session.state = "stopped";
        session.client = null;

        await this.forceStopAppOnDevice({
            serial: session.serial,
            packageName: session.packageName,
            userId: session.userId,
            sessionId: session.sessionId
        });

        if (session.inputController) {
            session.inputController = null;
        }

        this.sessions.delete(session.sessionId);
        this.emit("state", { sessionId: session.sessionId, state: session.state });
        this.emit("scrcpy-closed", { sessionId: session.sessionId });
    }

    async _runClientStart(session, scrcpyOptions = {}) {
        const sessionId = session.sessionId;
        const client = new ScrcpySocketClient(this.adbPath, session.serial);
        session.client = client;
        this._attachClientEvents(session, client);

        const displayIdPromise = this._waitForClientDisplayId(client);
        const mergedOptions = mergeTypeBScrcpyOptions(scrcpyOptions, session);
        const requestedNewDisplay = scrcpyOptions.newDisplay || null;

        // Panneau Contrôle : newDisplay explicite → recréer le display aux dimensions demandées
        if (requestedNewDisplay) {
            mergedOptions.newDisplay = requestedNewDisplay;
            delete mergedOptions.displayId;
        } else if (Number.isInteger(session.presetDisplayId)) {
            mergedOptions.displayId = session.presetDisplayId;
            delete mergedOptions.newDisplay;
        }

        const recreateDisplay = Boolean(mergedOptions.newDisplay && mergedOptions.displayId === undefined);

        session.streamOptions = mergedOptions;

        console.log(
            `[NewInstance] ${sessionId} scrcpy-server:`,
            `stay_awake=true`,
            mergedOptions.turnScreenOff ? "turn_screen_off=client" : "",
            mergedOptions.displayId !== undefined
                ? `display_id=${mergedOptions.displayId}`
                : `new_display=${mergedOptions.newDisplay}`,
            `audio=${mergedOptions.audio}`,
            session.skipPackageLaunch ? "start-app=deja_lance" : `start-app=${session.packageName}`
        );

        await client.start(this.serverJarPath, mergedOptions);

        const targetDisplayId = await displayIdPromise;
        session.displayId = Number.isInteger(targetDisplayId) ? targetDisplayId : this._syncSessionDisplayId(session);

        if (recreateDisplay && Number.isInteger(session.displayId)) {
            session.presetDisplayId = session.displayId;
        }

        if (session.displayId !== null) {
            this.emit("state", {
                sessionId,
                state: "display-ready",
                displayId: session.displayId,
                serial: session.serial,
                packageName: session.packageName
            });
            this._prewarmInputController(session);
        }

        if (recreateDisplay && session.packageName && session.serial) {
            await this.forceStopAppOnDevice({
                serial: session.serial,
                packageName: session.packageName,
                userId: session.userId,
                sessionId: session.sessionId
            });
        }

        if (this.launchPackageOnDisplay && session.packageName && (recreateDisplay || !session.skipPackageLaunch)) {
            await this.launchPackageOnDisplay(session.serial, session.packageName, session.displayId, {
                userId: session.userId
            });
        }

        if (mergedOptions.stayAwake) {
            await this._ensureDeviceStayAwake(session.serial);
        }

        if (mergedOptions.turnScreenOff && !session.externalLaunchId) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await this._turnOffPhysicalScreen(session);
        }

        session.state = "started";
        this.emit("state", {
            sessionId,
            state: session.state,
            displayId: session.displayId,
            serial: session.serial,
            packageName: session.packageName
        });

        this._prewarmInputController(session);

        if (session.externalLaunchId && typeof global.handoffExternalScrcpyLaunch === "function") {
            global.handoffExternalScrcpyLaunch(session.externalLaunchId);
        }

        return session;
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

        try {
            return await this._runClientStart(session, session.streamOptions || {});
        } catch (err) {
            session.state = "error";
            this.emit("state", { sessionId, state: session.state, error: err.message });
            try {
                session.client?.stop();
            } catch (_err) {
                // noop
            }
            session.client = null;
            throw err;
        }
    }

    async restartWithStreamOptions(sessionId, scrcpyOptions = {}, meta = {}) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session introuvable: ${sessionId}`);
        }

        if (Number.isInteger(meta.userId)) {
            session.userId = meta.userId;
        }

        // Évite _onScrcpyClosed (force-stop + suppression) pendant un redémarrage paramètres
        session._intentionalStop = true;
        session.state = "stopping";

        if (session.client) {
            const client = session.client;
            session.client = null;
            try {
                client.stop();
            } catch (_err) {
                // noop
            }
        }

        session.state = "starting";
        session.displayId = null;
        this.emit("state", {
            sessionId,
            state: session.state,
            serial: session.serial,
            packageName: session.packageName
        });

        try {
            const result = await this._runClientStart(session, scrcpyOptions);
            session._intentionalStop = false;
            return result;
        } catch (err) {
            session._intentionalStop = false;
            session.state = "error";
            this.emit("state", { sessionId, state: session.state, error: err.message });
            session.client = null;
            throw err;
        }
    }

    async forceStopAppOnDevice({ serial, packageName, userId = null, sessionId = null }) {
        if (!serial || !packageName) return;

        const userArg = Number.isInteger(userId) ? ` --user ${userId}` : "";
        const label = sessionId ? ` (${sessionId})` : "";

        const commands = [
            `"${this.adbPath}" -s ${serial} shell am force-stop${userArg} ${packageName}`,
            `"${this.adbPath}" -s ${serial} shell am force-stop ${packageName}`
        ];

        for (const command of commands) {
            try {
                await execPromise(command);
                console.log(`[NewInstanceManager] Application force-stop: ${packageName}${label}`);
                break;
            } catch (err) {
                console.warn(`[NewInstanceManager] force-stop echoue (${packageName}):`, err.message);
            }
        }

        try {
            await execPromise(`"${this.adbPath}" -s ${serial} shell svc power stayon false`);
        } catch (_err) {
            // noop
        }
    }

    async _killAppOnDevice(session) {
        if (!session?.packageName || !session.serial) return;
        await this.forceStopAppOnDevice({
            serial: session.serial,
            packageName: session.packageName,
            userId: session.userId,
            sessionId: session.sessionId
        });
    }

    async ensureAppStoppedForSessionClose(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            await this.stopNewInstanceSession(sessionId);
            return;
        }

        const entry = global.browserViewManager?.getSessionEntry(sessionId);
        if (!entry || entry.type !== "B" || !entry.packageName || !entry.deviceId) {
            return;
        }

        await this.forceStopAppOnDevice({
            serial: entry.deviceId,
            packageName: entry.packageName,
            userId: entry.userId,
            sessionId
        });
    }

    async stopNewInstanceSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.state = "stopping";
        session._intentionalStop = true;

        if (session.client) {
            const client = session.client;
            session.client = null;
            try {
                client.stop();
            } catch (_err) {
                // noop
            }
        }

        if (!session._appForceStopped) {
            session._appForceStopped = true;
            await this._killAppOnDevice(session);
        }

        if (session.inputController) {
            session.inputController = null;
        }

        if (typeof global.releaseSessionInputResources === "function") {
            global.releaseSessionInputResources(sessionId);
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

        const { type, action, x, y, key, streamWidth, streamHeight, x2, y2 } = payload;
        const client = session.client;

        this._syncSessionDisplayId(session);

        const hasControl = Boolean(client?.controlSocket);
        const hasVirtualDisplay = Number.isInteger(session.displayId);
        const inputReady = hasControl
            || hasVirtualDisplay
            || session.state === "starting"
            || session.state === "started"
            || session.state === "display-ready";

        if (!inputReady) {
            throw new Error(`Session non prete pour input (etat: ${session.state})`);
        }

        const logParts = [`[Input] Type B session=${sessionId}`, `device=${session.serial}`, `type=${type}`];
        if (action) logParts.push(`action=${action}`);
        if (x !== undefined && y !== undefined) logParts.push(`x=${x} y=${y}`);
        if (streamWidth && streamHeight) logParts.push(`stream=${streamWidth}x${streamHeight}`);
        if (Number.isInteger(session.displayId)) logParts.push(`displayId=${session.displayId}`);
        if (key) logParts.push(`key=${key}`);

        const controlSize = this._resolveControlSize(session, client, streamWidth, streamHeight);
        const hasLiveControl = Boolean(
            client?.controlSocket
            && !client.controlSocket.destroyed
            && client.controlSocket.writable
        );

        if (hasLiveControl && type === "touch") {
            try {
                logParts.push("path=scrcpy");
                console.log(logParts.join(" "));
                return sendTouchViaScrcpyClient(client, action, x, y, controlSize);
            } catch (err) {
                console.warn(
                    `[NewInstance] scrcpy touch echoue (${sessionId}), fallback ADB:`,
                    err.message
                );
            }
        }

        if (hasLiveControl && type === "key" && key) {
            try {
                logParts.push("path=scrcpy-key");
                console.log(logParts.join(" "));
                return this._sendKeyViaScrcpy(client, key, session);
            } catch (err) {
                console.warn(`[NewInstance] scrcpy key echoue (${sessionId}), fallback ADB:`, err.message);
            }
        }

        logParts.push("path=adb");
        console.log(logParts.join(" "));

        const controller = await this._ensureSessionInputController(session, streamWidth, streamHeight);

        if (type === "touch") {
            const adbAction = action === "tap" ? "tap" : action;
            return controller.sendTouch(adbAction, x, y, true);
        }
        if (type === "key") {
            return controller.sendKey(key);
        }
        if (type === "scroll") {
            return controller.sendScroll(x, y, x2, y2, true);
        }

        throw new Error(`Type input non supporte: ${type}`);
    }
}

module.exports = { NewInstanceManager };
