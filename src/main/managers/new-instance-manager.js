const { EventEmitter } = require("events");
const { exec, spawn } = require("child_process");
const { ScrcpySocketClient } = require("../../native/scrcpy/scrcpy-socket");
const { AdbInputController, KEYCODE_MAP } = require("../../native/scrcpy/control/adb-input-controller");
const { DEFAULT_STREAM_PARAMS, toScrcpyOptions } = require("../../shared/stream-params");
const { adbSerialArg } = require("../../shared/adb-serial-arg");
const { notifySessionStreamRestarting } = require("../ipc/wifiHandlers");

const KEY_ACTION_DOWN = 0;
const KEY_ACTION_UP = 1;
const CREATE_NO_WINDOW = 0x08000000;
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
    // Garde l'app vivante quand le display virtuel est détruit (reattach USB↔WiFi).
    merged.vdDestroyContent = scrcpyOptions.vdDestroyContent !== true
        && session?.streamOptions?.vdDestroyContent !== true
        ? false
        : true;
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

/** ADB shell via spawn (argv) — évite les bugs de quoting Windows de exec(). */
function spawnAdbShell(adbPath, serial, shellArgs) {
    return new Promise((resolve, reject) => {
        if (!adbPath || !serial) {
            reject(new Error("ADB ou serial manquant"));
            return;
        }
        const args = ["-s", String(serial), "shell", ...shellArgs.map(String)];
        const options = { windowsHide: true };
        if (process.platform === "win32") {
            options.creationFlags = CREATE_NO_WINDOW;
        }
        const child = spawn(adbPath, args, options);
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || stdout.trim() || `adb shell exit ${code}`));
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * Session Type B — `session.state` possible values:
 * "created" | "starting" | "display-ready" | "started" | "stopping" | "stopped" | "error"
 * | "reconnecting" (transport USB↔WiFi reattach — set only via beginTransportReconnect; unused until orchestration)
 */
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
        stableDeviceId = null,
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
        const initialOptions = streamOptions || {
            newDisplay: toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay
        };
        const session = {
            sessionId,
            serial,
            stableDeviceId: stableDeviceId || null,
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
            streamOptions: initialOptions
        };

        this.sessions.set(sessionId, session);
        if (Number.isInteger(session.displayId)) {
            this._prewarmInputController(session);
        }
        return session;
    }

    listNewInstanceSessions() {
        const now = Date.now();
        return Array.from(this.sessions.values()).map((s) => ({
            sessionId: s.sessionId,
            serial: s.serial,
            stableDeviceId: s.stableDeviceId || null,
            packageName: s.packageName,
            userId: s.userId,
            tabLabel: s.tabLabel,
            state: s.state,
            displayId: s.displayId,
            ignoreScrcpyClosed: Boolean(
                s.state === "reconnecting"
                || s._transportRebindActive
                || (s._reattachGraceUntil && now < s._reattachGraceUntil)
                || (s._ignoreScrcpyClosedUntil && now < s._ignoreScrcpyClosedUntil)
            )
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
            await execPromise(`"${this.adbPath}" -s ${adbSerialArg(serial)} shell svc power stayon true`);
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
            await execPromise(`"${this.adbPath}" -s ${adbSerialArg(session.serial)} shell input keyevent 223`);
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
            if (client?.controlSocket && typeof client.sendInjectText === "function") {
                return client.sendInjectText(key);
            }
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
            if (session.client !== client) return;
            if (Number.isInteger(displayId)) {
                session.displayId = displayId;
            }
        });

        client.on("codec-meta", (meta) => {
            if (session.client !== client) return;
            session.streamSize = { width: meta.width, height: meta.height };
            if (this.onStreamMeta) {
                this.onStreamMeta(session.serial, meta, session.sessionId);
            }
            this.emit("video-codec-meta", { sessionId: session.sessionId, ...meta });
        });

        client.on("raw-packet", (packet) => {
            if (session.client !== client) return;
            this.emit("video-packet", {
                sessionId: session.sessionId,
                pts: packet.pts.toString(),
                isConfig: packet.isConfig,
                isKeyFrame: packet.isKeyFrame,
                data: packet.data
            });
        });

        client.on("audio-codec-meta", (meta) => {
            if (session.client !== client) return;
            this.emit("audio-codec-meta", { sessionId: session.sessionId, ...meta });
        });

        client.on("raw-audio-packet", (packet) => {
            if (session.client !== client) return;
            this.emit("audio-packet", {
                sessionId: session.sessionId,
                pts: packet.pts.toString(),
                isConfig: packet.isConfig,
                isKeyFrame: packet.isKeyFrame,
                data: packet.data
            });
        });

        client.on("error", (err) => {
            if (session.client !== client) return;
            this.emit("video-error", { sessionId: session.sessionId, error: err.message });
        });

        client.on("closed", () => {
            if (session.client !== client) return;
            void this._onScrcpyClosed(session);
        });
    }

    async _onScrcpyClosed(session) {
        if (!session) return;

        // Transport reattach (USB↔WiFi) : ne pas force-stop / delete / emit pendant reconnecting.
        if (session.state === "reconnecting" || session._transportRebindActive) {
            console.log(
                `[NewInstanceManager] closed ignoré — reattach en cours (${session.sessionId}, state=${session.state})`
            );
            return;
        }

        if (session._reattachGraceUntil && Date.now() < session._reattachGraceUntil) {
            // Ne PAS cold-migrater ici : ça tuait le flux handoff fraîchement OK
            // (closed retardé de l'ancien client / blip ADB → destroy onglet).
            console.warn(
                `[NewInstanceManager] closed ignoré — grace reattach ${session.sessionId} (pas de recovery destructive)`
            );
            return;
        }

        // Closed retardé de l'ancien process/socket après un rebind réussi :
        // le même EventEmitter émet encore "closed" alors que le nouveau flux est vivant.
        const conn = session.client?.getConnectionState?.();
        const serverAlive = Boolean(
            session.client?.serverProcess
            && !session.client.serverProcess.killed
            && session.client.serverProcess.exitCode == null
        );
        if (conn?.hasVideo || serverAlive) {
            console.log(
                `[NewInstanceManager] closed ignoré — flux encore actif (${session.sessionId}, video=${Boolean(conn?.hasVideo)}, server=${serverAlive})`
            );
            return;
        }

        if (session._ignoreScrcpyClosedUntil && Date.now() < session._ignoreScrcpyClosedUntil) {
            console.warn(
                `[NewInstanceManager] closed ignoré — ignoreScrcpyClosedUntil ${session.sessionId}`
            );
            return;
        }

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
            if (typeof session.inputController.dispose === "function") {
                session.inputController.dispose();
            }
            session.inputController = null;
        }

        this.sessions.delete(session.sessionId);
        this.emit("state", { sessionId: session.sessionId, state: session.state });
        this.emit("scrcpy-closed", { sessionId: session.sessionId });
    }

    /**
     * Pose l'état "reconnecting" pour un reattach USB↔WiFi (Option A).
     * Non branché dans ce commit — prêt pour l'orchestration future.
     * @param {object} session
     */
    beginTransportReconnect(session) {
        if (!session) return;
        if (session.state !== "reconnecting") {
            session._preReconnectState = session.state;
        }
        session.state = "reconnecting";
        this.emit("state", { sessionId: session.sessionId, state: "reconnecting" });
    }

    /**
     * Sort de "reconnecting" après rebind (succès) ou échec.
     * Sortie échec simplifiée ici — affinera dans le commit d'orchestration.
     * @param {object} session
     * @param {{ success?: boolean }} [options]
     */
    endTransportReconnect(session, { success } = {}) {
        if (!session) return;
        const previous = session._preReconnectState;
        delete session._preReconnectState;

        if (success) {
            session.state = "started";
        } else if (
            previous
            && previous !== "reconnecting"
            && previous !== "stopping"
            && previous !== "stopped"
        ) {
            session.state = previous;
        } else {
            session.state = "stopped";
        }

        this.emit("state", {
            sessionId: session.sessionId,
            state: session.state,
            serial: session.serial,
            packageName: session.packageName
        });
    }

    /**
     * Destroy+recreate orchestré Type B (USB↔WiFi) — attach display_id existant, pas de new VD.
     * @returns {{ success: boolean, skipped?: boolean, error?: string }}
     */
    async switchSessionTransportTypeB(session, newSerial) {
        if (!session?.sessionId || !newSerial) {
            console.warn(
                `[switchSessionTransport] Type B skip — session/newSerial manquant session=${session?.sessionId || "?"} serial=${newSerial || "?"}`
            );
            return { success: false, error: "session ou newSerial manquant" };
        }

        if (session.state !== "reconnecting") {
            this.beginTransportReconnect(session);
        }

        console.log(
            `[switchSessionTransport] Type B begin session=${session.sessionId} newSerial=${newSerial}`
        );

        notifySessionStreamRestarting(session.sessionId);

        const preservedDisplayId = Number.isInteger(session.displayId)
            ? session.displayId
            : (Number.isInteger(session.presetDisplayId) ? session.presetDisplayId : null);

        if (!Number.isInteger(preservedDisplayId)) {
            console.warn(
                `[switchSessionTransport] Type B fail — displayId manquant session=${session.sessionId}`
            );
            this.endTransportReconnect(session, { success: false });
            return { success: false, error: "displayId manquant" };
        }

        session.presetDisplayId = preservedDisplayId;
        session.displayId = preservedDisplayId;

        const streamW = session.streamSize?.width || null;
        const streamH = session.streamSize?.height || null;

        session.serial = newSerial;
        session.skipPackageLaunch = true;

        if (session.inputController) {
            try {
                if (typeof session.inputController.dispose === "function") {
                    session.inputController.dispose();
                }
            } catch (err) {
                console.warn(
                    `[switchSessionTransport] Type B dispose input session=${session.sessionId}:`,
                    err?.message || err
                );
            }
            session.inputController = null;
        }
        session._inputPrewarmStarted = false;

        if (session.client) {
            const oldClient = session.client;
            session.client = null;
            try {
                oldClient.stop();
            } catch (err) {
                console.warn(
                    `[switchSessionTransport] Type B stop ancien client session=${session.sessionId}:`,
                    err?.message || err
                );
            }
        }

        try {
            const attachOptions = {
                ...(session.streamOptions || {}),
                displayId: preservedDisplayId,
                skipPackageLaunch: true
            };
            delete attachOptions.newDisplay;

            await this._runClientStart(session, attachOptions);
            await this._ensureSessionInputController(session, streamW, streamH);

            this.endTransportReconnect(session, { success: true });
            console.log(
                `[switchSessionTransport] Type B ok session=${session.sessionId} newSerial=${newSerial} displayId=${preservedDisplayId}`
            );
            return { success: true };
        } catch (err) {
            try {
                session.client?.stop?.();
            } catch (_err) {
                // noop
            }
            session.client = null;
            this.endTransportReconnect(session, { success: false });
            console.warn(
                `[switchSessionTransport] Type B fail session=${session.sessionId}:`,
                err?.message || err
            );
            return { success: false, error: err?.message || "Échec start vidéo" };
        }
    }

    /**
     * Switch toutes les sessions Type B en state=reconnecting pour ce device.
     * @returns {{ success: boolean, count: number }}
     */
    async switchTypeBSessionsForDevice(deviceId, newSerial) {
        if (!deviceId || !newSerial) {
            return { success: false, count: 0 };
        }

        const sessions = [];
        for (const summary of this.listNewInstanceSessions() || []) {
            if (summary.state !== "reconnecting") continue;
            if (summary.stableDeviceId !== deviceId && summary.serial !== deviceId) continue;
            const session = this.getNewInstanceSession(summary.sessionId);
            if (session) sessions.push(session);
        }

        console.log(
            `[switchSessionTransport] Type B device=${deviceId} sessions=${sessions.length} newSerial=${newSerial}`
        );

        if (sessions.length === 0) {
            return { success: true, count: 0 };
        }

        let allOk = true;
        for (const session of sessions) {
            const outcome = await this.switchSessionTransportTypeB(session, newSerial);
            if (!outcome?.success) {
                allOk = false;
            }
        }
        return { success: allOk, count: sessions.length };
    }

    async _runClientStart(session, scrcpyOptions = {}) {
        const sessionId = session.sessionId;
        const client = new ScrcpySocketClient(this.adbPath, session.serial);
        session.client = client;
        this._attachClientEvents(session, client);

        const displayIdPromise = this._waitForClientDisplayId(client);
        const mergedOptions = mergeTypeBScrcpyOptions(scrcpyOptions, session);
        const requestedNewDisplay = scrcpyOptions.newDisplay || null;
        const hasPresetDisplay = Number.isInteger(session.presetDisplayId);

        // Bootstrap externe : se rattacher au VD déjà créé (app déjà lancée).
        // Ne PAS recréer un 2e new_display (sinon force-stop + relaunch → letterbox / demi-image).
        if (hasPresetDisplay && session.skipPackageLaunch) {
            mergedOptions.displayId = session.presetDisplayId;
            delete mergedOptions.newDisplay;
        } else if (requestedNewDisplay) {
            // Panneau Contrôle : newDisplay explicite → recréer le display aux dimensions demandées
            mergedOptions.newDisplay = requestedNewDisplay;
            delete mergedOptions.displayId;
        } else if (hasPresetDisplay) {
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
        session.displayId = Number.isInteger(targetDisplayId)
            ? targetDisplayId
            : (hasPresetDisplay ? session.presetDisplayId : this._syncSessionDisplayId(session));

        if (recreateDisplay && Number.isInteger(session.displayId)) {
            session.presetDisplayId = session.displayId;
        }
        if (!Number.isInteger(session.presetDisplayId) && Number.isInteger(session.displayId)) {
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

        // Jamais force-stop si l'app tourne déjà sur le VD bootstrap (skipPackageLaunch).
        if (recreateDisplay && !session.skipPackageLaunch && session.packageName && session.serial) {
            await this.forceStopAppOnDevice({
                serial: session.serial,
                packageName: session.packageName,
                userId: session.userId,
                sessionId: session.sessionId
            });
        }

        if (this.launchPackageOnDisplay && session.packageName && !session.skipPackageLaunch) {
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
            const launchOptions = session.streamOptions || {};
            if (launchOptions.videoCodec === "h265") {
                console.warn(
                    `[NewInstance] H265 non supporté par cet appareil — bascule sur H264 (${sessionId})`
                );
                try {
                    session.client?.stop();
                } catch (_err) {
                    // noop
                }
                session.client = null;
                session.state = "starting";
                this.emit("state", {
                    sessionId,
                    state: session.state,
                    serial: session.serial,
                    packageName: session.packageName
                });

                const fallbackOptions = {
                    ...launchOptions,
                    videoCodec: "h264"
                };
                session.streamOptions = fallbackOptions;

                try {
                    const result = await this._runClientStart(session, fallbackOptions);
                    this.emit("video-error", {
                        sessionId,
                        codecFallback: true,
                        error: "H265 non supporté par cet appareil — bascule sur H264"
                    });
                    return result;
                } catch (fallbackErr) {
                    session.state = "error";
                    this.emit("state", { sessionId, state: session.state, error: fallbackErr.message });
                    try {
                        session.client?.stop();
                    } catch (_err) {
                        // noop
                    }
                    session.client = null;
                    throw fallbackErr;
                }
            }

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

    async forceStopAppOnDevice({ serial, packageName, userId = null, sessionId = null, stableDeviceId = null }) {
        if (!packageName) return;

        let adbSerial = serial || null;
        // Évite listUnifiedDevices (lent) si on a déjà un serial transport utilisable.
        const looksLikeTransport = Boolean(adbSerial)
            && (adbSerial.includes(":") || /^[A-Za-z0-9]+$/.test(adbSerial));
        if (!looksLikeTransport && typeof global.resolveAdbSerialForDims === "function") {
            try {
                const resolved = await global.resolveAdbSerialForDims(serial, stableDeviceId || null);
                if (resolved) adbSerial = resolved;
            } catch (_err) {
                // garder serial fourni
            }
        }
        if (!adbSerial && global.deviceRegistry?.resolveEffectiveAdbSerial) {
            try {
                adbSerial = await global.deviceRegistry.resolveEffectiveAdbSerial({
                    deviceId: stableDeviceId || null,
                    serial: serial || null
                });
            } catch (_err) {
                // garder serial fourni
            }
        }
        if (!adbSerial) {
            console.warn(`[NewInstanceManager] force-stop ignore — serial manquant (${packageName})`);
            return;
        }

        const label = sessionId ? ` (${sessionId})` : "";
        // Un seul user : base (0) et clone (10/999) partagent le package — ne pas tuer les deux.
        const targetUserId = Number.isInteger(userId) ? userId : 0;

        let stopped = false;
        try {
            await spawnAdbShell(this.adbPath, adbSerial, [
                "am", "force-stop", "--user", String(targetUserId), packageName
            ]);
            stopped = true;
            console.log(`[NewInstanceManager] Application arretee: ${packageName}${label} user=${targetUserId}`);
        } catch (err) {
            console.warn(
                `[NewInstanceManager] App stop echec (user=${targetUserId}):`,
                err?.message || err
            );
        }

        await this._removeAppTasksFromRecents(adbSerial, packageName, targetUserId);

        // Ne coupe pas stayon si une autre session Type B tourne encore sur ce device.
        const otherSessionAlive = Array.from(this.sessions.values()).some((s) => (
            s.sessionId !== sessionId
            && s.serial === serial
            && s.state !== "stopped"
            && s.state !== "stopping"
        ));
        if (!otherSessionAlive) {
            void spawnAdbShell(this.adbPath, adbSerial, ["svc", "power", "stayon", "false"]).catch(() => {});
        }
    }

    async _removeAppTasksFromRecents(serial, packageName, userId = 0) {
        if (!serial || !packageName) return;
        const targetUserId = Number.isInteger(userId) ? userId : 0;
        let dump = "";
        try {
            dump = await spawnAdbShell(this.adbPath, serial, ["dumpsys", "activity", "recents"]);
        } catch (_err) {
            try {
                dump = await spawnAdbShell(this.adbPath, serial, ["dumpsys", "activity", "activities"]);
            } catch (_err2) {
                return;
            }
        }

        const taskIds = new Set();
        const lines = String(dump).split(/\r?\n/);
        const userMatchers = [
            new RegExp(`\\bU=${targetUserId}\\b`),
            new RegExp(`\\buserId=${targetUserId}\\b`),
            new RegExp(`\\bu${targetUserId}\\b`)
        ];

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (!line.includes(packageName)) continue;
            const window = lines.slice(Math.max(0, i - 4), i + 6).join("\n");
            if (!userMatchers.some((re) => re.test(window))) continue;

            for (const match of window.matchAll(/\btaskId\s*=\s*(\d+)/gi)) {
                taskIds.add(match[1]);
            }
            for (const match of window.matchAll(/\brootTaskId\s*=\s*(\d+)/gi)) {
                taskIds.add(match[1]);
            }
            for (const match of window.matchAll(/Task\{[^\s]*\s+#(\d+)/g)) {
                taskIds.add(match[1]);
            }
        }

        // MIUI / Android moderne : `am stack remove` (pas `am task remove`).
        const removeAttempts = (taskId) => ([
            ["am", "stack", "remove", taskId],
            ["am", "task", "remove", taskId],
            ["cmd", "activity", "remove-task", taskId]
        ]);

        for (const taskId of taskIds) {
            // Évite de casser le stack Home (souvent 1 / 2).
            if (taskId === "1" || taskId === "2") continue;

            let removed = false;
            for (const shellArgs of removeAttempts(taskId)) {
                try {
                    await spawnAdbShell(this.adbPath, serial, shellArgs);
                    removed = true;
                    console.log(
                        `[NewInstanceManager] Task/stack retire: ${shellArgs.join(" ")} (${packageName} user=${targetUserId})`
                    );
                    break;
                } catch (_err) {
                    // essayer la commande suivante
                }
            }
            if (!removed) {
                console.warn(
                    `[NewInstanceManager] Impossible de retirer task ${taskId} (${packageName} user=${targetUserId})`
                );
            }
        }
    }

    async _killAppOnDevice(session) {
        if (!session?.packageName || !session.serial) return;
        await this.forceStopAppOnDevice({
            serial: session.serial,
            packageName: session.packageName,
            userId: session.userId,
            sessionId: session.sessionId,
            stableDeviceId: session.stableDeviceId || null
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
            sessionId,
            stableDeviceId: entry.stableDeviceId || null
        });

        if (typeof global.killExternalScrcpyLaunchesForApp === "function") {
            try {
                await global.killExternalScrcpyLaunchesForApp(
                    entry.deviceId,
                    entry.packageName,
                    entry.userId
                );
            } catch (err) {
                console.warn(`[NewInstanceManager] kill scrcpy externe (fallback):`, err?.message || err);
            }
        }
    }

    async stopNewInstanceSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        console.warn(
            `[NewInstanceManager] stopNewInstanceSession ${sessionId} state=${session.state} intentional=${Boolean(session._intentionalStop)}`
        );

        session.state = "stopping";
        session._intentionalStop = true;

        const killPayload = {
            serial: session.serial,
            packageName: session.packageName,
            userId: session.userId,
            sessionId: session.sessionId,
            stableDeviceId: session.stableDeviceId || null
        };
        const externalLaunchId = session.externalLaunchId || null;

        // Arrêt Hub immédiat (comme Type A) — le kill device part en parallèle.
        if (session.client) {
            const client = session.client;
            session.client = null;
            try {
                client.stop();
            } catch (_err) {
                // noop
            }
        }

        if (session.inputController) {
            if (typeof session.inputController.dispose === "function") {
                session.inputController.dispose();
            }
            session.inputController = null;
        }

        if (typeof global.releaseSessionInputResources === "function") {
            global.releaseSessionInputResources(sessionId);
        }

        session.state = "stopped";
        this.emit("state", { sessionId, state: session.state });
        this.sessions.delete(sessionId);

        // Cleanup device + scrcpy externe hors du chemin critique UI.
        if (!session._appForceStopped && killPayload.packageName) {
            session._appForceStopped = true;
            void this.forceStopAppOnDevice(killPayload).catch((err) => {
                console.warn(`[NewInstanceManager] force-stop background:`, err?.message || err);
            });
        }

        if (externalLaunchId && typeof global.killExternalScrcpyLaunch === "function") {
            void global.killExternalScrcpyLaunch(externalLaunchId).catch((err) => {
                console.warn(`[NewInstanceManager] kill scrcpy externe:`, err?.message || err);
            });
        }
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

        const preferAdbTouchForVirtualDisplay = hasVirtualDisplay && type === "touch";

        if (hasLiveControl && type === "touch" && !preferAdbTouchForVirtualDisplay) {
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
