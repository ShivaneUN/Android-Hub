const { EventEmitter } = require("events");
const { exec, spawn } = require("child_process");
const { ScrcpySocketClient } = require("../../native/scrcpy/scrcpy-socket");
const { AdbInputController, KEYCODE_MAP } = require("../../native/scrcpy/control/adb-input-controller");
const { DEFAULT_STREAM_PARAMS, toScrcpyOptions, formatNewDisplay } = require("../../shared/stream-params");
const { buildTypeBHandoffScrcpyOptions } = require("../../shared/typeb-handoff-options");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

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

/** Conserve les dimensions/DPI du display Type B pour les handoffs USB↔WiFi. */
function resolveTypeBNewDisplay(session) {
    if (!session) {
        return toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay;
    }
    if (session.preferredNewDisplay) {
        return session.preferredNewDisplay;
    }
    if (session.streamOptions?.newDisplay) {
        return session.streamOptions.newDisplay;
    }

    const entry = global.browserViewManager?.getSessionEntry?.(session.sessionId);
    const params = entry?.streamParams || null;
    if (params?.width > 0 && params?.height > 0) {
        return formatNewDisplay(params);
    }

    const w = session.streamSize?.width;
    const h = session.streamSize?.height;
    if (w > 0 && h > 0) {
        // Ne pas figer un ratio inversé (ex. 1080x1920 après un mauvais capture_orientation).
        const configured = session.streamOptions?.newDisplay || session.preferredNewDisplay;
        const parsed = configured ? String(configured).match(/^(\d+)x(\d+)/i) : null;
        if (parsed) {
            const cw = Number(parsed[1]);
            const ch = Number(parsed[2]);
            const configLandscape = cw >= ch;
            const liveLandscape = w >= h;
            if (configLandscape !== liveLandscape) {
                return configured.includes("/")
                    ? configured
                    : `${cw}x${ch}/${DEFAULT_STREAM_PARAMS.dpi}`;
            }
        }
        const dpi = Number.isFinite(params?.dpi) ? params.dpi : DEFAULT_STREAM_PARAMS.dpi;
        return `${w}x${h}/${dpi}`;
    }

    return toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay;
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
            streamOptions: initialOptions,
            preferredNewDisplay: initialOptions.newDisplay || null
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

    /**
     * Après mort du scrcpy.exe bootstrap : refresh display_id sur le shell courant.
     */
    async recoverAfterExternalDisplayOwnerLost(externalLaunchId) {
        for (const session of this.sessions.values()) {
            if (session.externalLaunchId !== externalLaunchId) continue;
            if (session.state === "stopped" || session.state === "stopping") continue;
            if (session._intentionalStop || session._appForceStopped) continue;

            const shellSerial = session.client?.shellSerial || session.serial;
            if (!shellSerial) continue;

            console.warn(
                `[NewInstanceManager] externe perdu → refresh display ${session.sessionId} shell=${shellSerial}`
            );
            session.externalLaunchId = null;
            this.beginTransportReconnect(session);
            try {
                if (typeof global.browserViewManager?.sendToSessionView === "function") {
                    global.browserViewManager.sendToSessionView(session.sessionId, "stream-restarting", {
                        sessionId: session.sessionId
                    });
                }
                const result = await this._handoffSessionTransport(session, shellSerial, {
                    notifyStreamRestarting: (sessionId) => {
                        try {
                            global.browserViewManager?.sendToSessionView?.(sessionId, "stream-restarting", {
                                sessionId
                            });
                        } catch (_e) {
                            // noop
                        }
                    }
                });
                this.endTransportReconnect(session, { success: true });
                return result;
            } catch (err) {
                this.endTransportReconnect(session, { success: false });
                throw err;
            }
        }
        return null;
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

    _waitForClientVideoReady(client, timeoutMs = 15000) {
        if (client?.getConnectionState?.().hasVideo) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                if (client.getConnectionState?.().hasVideo) {
                    resolve();
                } else {
                    reject(new Error("Timeout: flux vidéo handoff non prêt"));
                }
            }, timeoutMs);

            const onReady = () => {
                cleanup();
                resolve();
            };

            const cleanup = () => {
                clearTimeout(timer);
                client.removeListener("codec-meta", onReady);
                client.removeListener("raw-packet", onReady);
            };

            client.once("codec-meta", onReady);
            client.once("raw-packet", onReady);
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

        // Shell USB mort alors que le mode WiFi est actif → bascule au lieu de tuer la session.
        if (await this._tryWifiFallbackOnShellDeath(session)) {
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
     * Si le shell USB meurt (débranchement) alors que WiFi est activé, migrate vers WiFi
     * au lieu de force-stop / supprimer la session.
     */
    async _tryWifiFallbackOnShellDeath(session) {
        if (!session?.stableDeviceId || session._intentionalStop || session._appForceStopped) {
            return false;
        }

        const shellSerial = session.client?.shellSerial || session.serial;
        const wifiService = global.wifiAdbService;
        if (wifiService?.isWifiSerial?.(shellSerial)) {
            // Déjà sur WiFi — mort réelle du tunnel, pas un simple unplug USB.
            return false;
        }

        const wifiConfig = global.wifiDevicesManager?.getByDeviceId?.(session.stableDeviceId);
        if (!wifiConfig?.wifiEnabled) return false;

        let wifiSerial = null;
        try {
            wifiSerial = await global.deviceRegistry?.resolveEffectiveAdbSerial?.({
                deviceId: session.stableDeviceId,
                forceFresh: true
            });
        } catch (_err) {
            return false;
        }

        if (!wifiSerial || !wifiService?.isWifiSerial?.(wifiSerial)) {
            return false;
        }

        console.log(
            `[NewInstanceManager] shell USB mort → fallback WiFi ${session.sessionId} → ${wifiSerial}`
        );
        this.beginTransportReconnect(session);

        try {
            const win = global.browserViewManager?.mainWindow;
            if (win && !win.isDestroyed()) {
                win.webContents.send("transport:reattach-state", {
                    deviceId: session.stableDeviceId,
                    phase: "start"
                });
            }
        } catch (_err) {
            // noop
        }

        void this.reattachSessionTransport(session, wifiSerial, {
            notifyStreamRestarting: (sessionId) => {
                try {
                    global.browserViewManager?.sendToSessionView?.(sessionId, "stream-restarting", {
                        sessionId
                    });
                    const mainWin = global.browserViewManager?.mainWindow;
                    if (mainWin && !mainWin.isDestroyed()) {
                        mainWin.webContents.send("stream-restarting", { sessionId });
                    }
                } catch (_e) {
                    // noop
                }
            }
        }).then(() => {
            try {
                const win = global.browserViewManager?.mainWindow;
                if (win && !win.isDestroyed()) {
                    win.webContents.send("transport:reattach-state", {
                        deviceId: session.stableDeviceId,
                        phase: "end"
                    });
                }
            } catch (_e) {
                // noop
            }
        }).catch((err) => {
            console.error(
                `[NewInstanceManager] fallback WiFi failed ${session.sessionId}:`,
                err?.message || err
            );
            this.endTransportReconnect(session, { success: false });
            try {
                const win = global.browserViewManager?.mainWindow;
                if (win && !win.isDestroyed()) {
                    win.webContents.send("transport:reattach-state", {
                        deviceId: session.stableDeviceId,
                        phase: "error"
                    });
                }
            } catch (_e) {
                // noop
            }
        });

        return true;
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
     * Reattach Type B apres bascule USB/WiFi.
     *
     * Approche rebind in-place abandonnée. Corps remplacé par no-op sûr en attendant
     * switchSessionTransport (destroy+recreate orchestré).
     *
     * @param {object} session
     * @param {string} newSerial
     * @param {{ notifyStreamRestarting?: function, forceMigrate?: boolean }} [hooks]
     * @returns {Promise<{ session: object, mode: "noop-pending-switch" }>}
     */
    async reattachSessionTransport(session, newSerial, hooks = {}) {
        if (!session || !newSerial) {
            throw new Error("session ou serial manquant pour reattach");
        }

        // TODO(Commit suivant): appeler switchSessionTransport(session, newSerial) ici.
        console.warn(
            `[NewInstanceManager][reattach] no-op — rebind retiré, switchSessionTransport pending ` +
            `${session.sessionId} → ${newSerial}`
        );

        session._transportRebindActive = true;
        try {
            if (typeof global.invalidateSessionAdbSerialCache === "function") {
                global.invalidateSessionAdbSerialCache(session.sessionId);
            }
            // Repli sûr : lever "reconnecting" sans toucher au client (évite crash / état coincé).
            // (ignore deferEndReconnect — no-op ne doit pas laisser state=reconnecting.)
            this.endTransportReconnect(session, { success: false });
            return { session, mode: "noop-pending-switch" };
        } finally {
            const target = session;
            target._reattachGraceUntil = Date.now() + 20000;
            target._ignoreScrcpyClosedUntil = Date.now() + 25000;
            setTimeout(() => {
                target._transportRebindActive = false;
            }, 20000);
        }
    }

    _finishTransportReconnect(session, hooks = {}, { success = true } = {}) {
        if (!session) return;
        // Fenêtre anti fermeture UI (scrcpy-closed) après handoff USB↔WiFi.
        session._reattachGraceUntil = Date.now() + (hooks.deferEndReconnect ? 25000 : 20000);
        session._ignoreScrcpyClosedUntil = Date.now() + 25000;
        if (hooks.deferEndReconnect) {
            console.log(
                `[NewInstanceManager][reattach] defer endReconnect ${session.sessionId} (attente disconnect/settle)`
            );
            return;
        }
        this.endTransportReconnect(session, { success });
    }

    /**
     * Claim VD désactivé — USB↔WiFi = refresh display_id uniquement.
     */
    async _claimVirtualDisplayOwnership(session) {
        return session;
    }

    /**
     * Parse dumpsys pour retrouver taskId / rootTaskId / displayId d'un package (user-aware).
     * @returns {Promise<Array<{ taskId: number, rootTaskId: number|null, displayId: number|null, userId: number|null }>>}
     */
    async _findPackageTaskRefs(serial, packageName, userId = null) {
        if (!serial || !packageName) return [];

        const userIdNum = Number.isInteger(userId) ? userId : null;
        const dumps = [];
        const tryDump = async (shellArgs) => {
            try {
                dumps.push(await spawnAdbShell(this.adbPath, serial, shellArgs));
            } catch (_err) {
                // noop
            }
        };

        if (userIdNum !== null) {
            await tryDump(["dumpsys", "activity", "--user", String(userIdNum), "activities"]);
        }
        await tryDump(["dumpsys", "activity", "recents"]);
        await tryDump(["dumpsys", "activity", "activities"]);
        await tryDump(["cmd", "activity", "stack", "list"]);

        const dump = dumps.join("\n");
        if (!dump.includes(packageName)) return [];

        /** @type {Map<number, { taskId: number, rootTaskId: number|null, displayId: number|null, userId: number|null }>} */
        const byTask = new Map();
        const lines = dump.split(/\r?\n/);
        const escaped = packageName.replace(/\./g, "\\.");
        let currentDisplayId = null;

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            const displayHeader = line.match(/^\s*Display\s+#(\d+)\b/i)
                || line.match(/\bdisplayId\s*=\s*(\d+)\b/i);
            if (displayHeader?.[1] && /Display\s+#/i.test(line)) {
                const did = Number(displayHeader[1]);
                if (Number.isInteger(did) && did >= 0) currentDisplayId = did;
            }

            if (!line.includes(packageName)) continue;
            const window = lines.slice(Math.max(0, i - 6), i + 10).join("\n");

            let taskId = null;
            const taskPatterns = [
                /Task\{[^\s]*\s+#(\d+)/,
                /\btaskId\s*=\s*(\d+)/i,
                new RegExp(`#(\\d+)\\s+[^\\n]*${escaped}`, "i")
            ];
            for (const re of taskPatterns) {
                const m = window.match(re);
                if (m?.[1]) {
                    taskId = Number(m[1]);
                    if (Number.isInteger(taskId) && taskId > 0) break;
                    taskId = null;
                }
            }
            if (!Number.isInteger(taskId)) continue;

            let rootTaskId = null;
            const rootMatch = window.match(/\brootTaskId\s*=\s*(\d+)/i)
                || window.match(/\bRootTask#(\d+)/i);
            if (rootMatch?.[1]) {
                const rid = Number(rootMatch[1]);
                if (Number.isInteger(rid) && rid > 0) rootTaskId = rid;
            }

            let displayId = currentDisplayId;
            const displayMatch = window.match(/\bmDisplayId\s*=\s*(-?\d+)/i)
                || window.match(/\bdisplayId\s*=\s*(-?\d+)/i)
                || window.match(/\bdisplay=(\d+)/i);
            if (displayMatch?.[1]) {
                const did = Number(displayMatch[1]);
                if (Number.isInteger(did) && did >= 0) displayId = did;
            }

            let refUserId = null;
            const userMatch = window.match(/\bU=(\d+)/) || window.match(/\buserId\s*=\s*(\d+)/i);
            if (userMatch?.[1]) {
                const uid = Number(userMatch[1]);
                if (Number.isInteger(uid)) refUserId = uid;
            }

            if (userIdNum !== null && refUserId !== null && refUserId !== userIdNum) {
                continue;
            }

            const prev = byTask.get(taskId);
            byTask.set(taskId, {
                taskId,
                rootTaskId: rootTaskId ?? prev?.rootTaskId ?? null,
                displayId: displayId ?? prev?.displayId ?? null,
                userId: refUserId ?? prev?.userId ?? null
            });
        }

        // Fallback regex global si le scan ligne-à-ligne n'a rien trouvé.
        if (byTask.size === 0) {
            const fallbackRes = [
                new RegExp(`Task\\{[^\\}]*#(\\d+)[^\\}]*${escaped}`, "gi"),
                new RegExp(`taskId[=\\s]+(\\d+)[\\s\\S]{0,160}?${escaped}`, "gi"),
                new RegExp(`${escaped}[\\s\\S]{0,120}?taskId[=\\s]+(\\d+)`, "gi")
            ];
            for (const re of fallbackRes) {
                let m = re.exec(dump);
                while (m) {
                    const id = Number(m[1]);
                    if (Number.isInteger(id) && id > 0 && !byTask.has(id)) {
                        byTask.set(id, { taskId: id, rootTaskId: null, displayId: null, userId: userIdNum });
                    }
                    m = re.exec(dump);
                }
            }
        }

        // MIUI : mUserRootTaskInFront={999=2251} — root stack frontale du profil travail.
        if (userIdNum !== null) {
            const frontMatch = dump.match(/mUserRootTaskInFront=\{([^}]+)\}/);
            if (frontMatch?.[1]) {
                const entryRe = /(\d+)=(\d+)/g;
                let em = entryRe.exec(frontMatch[1]);
                while (em) {
                    const uid = Number(em[1]);
                    const stackId = Number(em[2]);
                    if (uid === userIdNum && Number.isInteger(stackId) && stackId > 0) {
                        const prev = byTask.get(stackId);
                        byTask.set(stackId, {
                            taskId: stackId,
                            rootTaskId: stackId,
                            displayId: prev?.displayId ?? null,
                            userId: userIdNum
                        });
                    }
                    em = entryRe.exec(frontMatch[1]);
                }
            }
        }

        return [...byTask.values()];
    }

    async _isPackageOnDisplay(serial, packageName, displayId, userId = null) {
        if (!Number.isInteger(displayId)) return false;
        const refs = await this._findPackageTaskRefs(serial, packageName, userId);
        return refs.some((ref) => ref.displayId === displayId);
    }

    /**
     * Déplace la task vers un display (évite start_app / letterbox).
     * @returns {Promise<boolean>}
     */
    async _movePackageTaskToDisplay(serial, packageName, displayId, userId = null) {
        if (!serial || !packageName || !Number.isInteger(displayId)) return false;

        try {
            if (await this._isPackageOnDisplay(serial, packageName, displayId, userId)) {
                console.log(
                    `[NewInstanceManager] move-task: déjà sur display=${displayId} (${packageName})`
                );
                return true;
            }

            let refs = await this._findPackageTaskRefs(serial, packageName, userId);
            if (refs.length === 0) {
                await new Promise((resolve) => setTimeout(resolve, 350));
                refs = await this._findPackageTaskRefs(serial, packageName, userId);
            }
            if (refs.length === 0) {
                console.warn(
                    `[NewInstanceManager] move-task: taskId introuvable pour ${packageName}` +
                    `${Number.isInteger(userId) ? ` user=${userId}` : ""}`
                );
                return false;
            }

            const moveIds = [];
            for (const ref of refs) {
                if (Number.isInteger(ref.rootTaskId) && !moveIds.includes(ref.rootTaskId)) {
                    moveIds.push(ref.rootTaskId);
                }
                if (Number.isInteger(ref.taskId) && !moveIds.includes(ref.taskId)) {
                    moveIds.push(ref.taskId);
                }
            }

            // Xiaomi / AOSP 13 : la commande qui marche est
            //   cmd activity display move-stack <STACK_ID> <DISPLAY_ID>
            // (pas am task move-to-display / move-root-task-to-display).
            const moveCmdsFor = (id) => [
                ["cmd", "activity", "display", "move-stack", String(id), String(displayId)],
                ["am", "display", "move-stack", String(id), String(displayId)],
                ["cmd", "activity", "move-root-task-to-display", String(id), String(displayId)],
                ["am", "task", "move-to-display", String(id), String(displayId)]
            ];

            const errors = [];
            for (const id of moveIds) {
                for (const shellArgs of moveCmdsFor(id)) {
                    try {
                        const out = await spawnAdbShell(this.adbPath, serial, shellArgs);
                        const combined = String(out || "").toLowerCase();
                        if (
                            combined.includes("unknown command")
                            || combined.includes("error:")
                            || combined.includes("exception")
                            || combined.includes("not found")
                            || combined.includes("illegalargument")
                        ) {
                            errors.push(`${shellArgs.join(" ")} => ${String(out || "").slice(0, 120)}`);
                            continue;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 250));
                        if (await this._isPackageOnDisplay(serial, packageName, displayId, userId)) {
                            console.log(
                                `[NewInstanceManager] move-task OK id=${id} → display=${displayId} via ${shellArgs.join(" ")}`
                            );
                            return true;
                        }
                        // Sur MIUI, dumpsys peut être lent / incomplet : si move-stack
                        // a accepté la commande, on considère le move réussi.
                        if (shellArgs.includes("move-stack")) {
                            console.log(
                                `[NewInstanceManager] move-task OK (trust move-stack) id=${id} → display=${displayId}`
                            );
                            return true;
                        }
                    } catch (err) {
                        errors.push(`${shellArgs.join(" ")} => ${err?.message || err}`);
                    }
                }
            }

            console.warn(
                `[NewInstanceManager] move-task échec ids=[${moveIds.join(",")}] display=${displayId}` +
                `${Number.isInteger(userId) ? ` user=${userId}` : ""}`
            );
            if (errors.length) {
                console.warn(
                    `[NewInstanceManager] move-task détails: ${errors.slice(0, 4).join(" | ")}`
                );
            }
            return false;
        } catch (err) {
            console.warn(`[NewInstanceManager] move-task:`, err?.message || err);
            return false;
        }
    }

    /**
     * Place l'app sur un display sans cold-start si possible (move → bringToFront).
     * @returns {Promise<boolean>}
     */
    async _placePackageOnDisplay(serial, packageName, displayId, userId = null, options = {}) {
        if (!packageName || !Number.isInteger(displayId)) return false;
        const allowColdStart = options.allowColdStart === true;

        const moved = await this._movePackageTaskToDisplay(serial, packageName, displayId, userId);
        if (moved) return true;

        if (this.launchPackageOnDisplay) {
            try {
                await this.launchPackageOnDisplay(serial, packageName, displayId, {
                    userId,
                    bringToFront: true
                });
            } catch (err) {
                console.warn(`[NewInstanceManager] bringToFront:`, err?.message || err);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (await this._isPackageOnDisplay(serial, packageName, displayId, userId)) {
                console.log(
                    `[NewInstanceManager] bringToFront OK ${packageName} → display=${displayId}` +
                    `${Number.isInteger(userId) ? ` user=${userId}` : ""}`
                );
                return true;
            }
        }

        if (!allowColdStart) {
            console.warn(
                `[NewInstanceManager] place-on-display refusé (pas de cold-start) ${packageName} display=${displayId}`
            );
            return false;
        }

        // Dernier recours — peut letterbox / relancer l'instance.
        try {
            await this._launchPackageOnDisplayPreferred(serial, packageName, displayId, userId, null);
            await new Promise((resolve) => setTimeout(resolve, 250));
            return this._isPackageOnDisplay(serial, packageName, displayId, userId);
        } catch (err) {
            console.warn(`[NewInstanceManager] cold-start display:`, err?.message || err);
            return false;
        }
    }

    /**
     * Relance l'app sur un display en respectant userId.
     * Préfère am start --user (profil travail) à scrcpy start_app (user 0).
     */
    async _launchPackageOnDisplayPreferred(serial, packageName, displayId, userId = null, scrcpyClient = null) {
        if (!packageName || !Number.isInteger(displayId)) return;
        if (this.launchPackageOnDisplay) {
            await this.launchPackageOnDisplay(serial, packageName, displayId, { userId });
            return;
        }
        // scrcpy start_app ignore le userId (FakeContext user 0) — interdit pour profil travail.
        if (Number.isInteger(userId) && userId !== 0) {
            console.warn(
                `[NewInstanceManager] start_app scrcpy ignoré (user=${userId}) — pas de launchPackageOnDisplay`
            );
            return;
        }
        if (scrcpyClient && typeof scrcpyClient.sendStartApp === "function") {
            await scrcpyClient.sendStartApp(packageName);
        }
    }

    /**
     * Buffer codec-meta + paquets pendant le warm-up, puis replay apres stream-restarting
     * (sinon le decodeur reste noir : meta deja consommee avant l'attach).
     */
    async _handoffSessionTransport(session, newSerial, hooks = {}) {
        const oldClient = session.client;
        const shellSerial = oldClient.shellSerial || oldClient.serial;
        const sessionId = session.sessionId;

        // Les 2 sens : même refresh — rattache le display_id existant (pas de new_display / move / start_app).
        const startOptions = buildTypeBHandoffScrcpyOptions(session, {});
        const reuseDisplayId = Number.isInteger(startOptions.displayId) ? startOptions.displayId : null;
        if (!Number.isInteger(reuseDisplayId)) {
            throw new Error(`Handoff refresh impossible sans displayId (${sessionId})`);
        }
        const newDisplay = session.preferredNewDisplay
            || session.streamOptions?.newDisplay
            || null;
        if (newDisplay) {
            session.preferredNewDisplay = newDisplay;
        }

        const newClient = new ScrcpySocketClient(this.adbPath, newSerial);
        console.log(
            `[NewInstanceManager][handoff] ${sessionId} refresh ${shellSerial} → ${newSerial} ` +
            `display_id=${reuseDisplayId} capture_orientation=null`
        );

        let pendingMeta = null;
        const pendingPackets = [];
        const onMeta = (meta) => {
            pendingMeta = meta;
        };
        const onPacket = (packet) => {
            if (pendingPackets.length < 240) {
                pendingPackets.push(packet);
            }
        };
        newClient.on("codec-meta", onMeta);
        newClient.on("raw-packet", onPacket);

        const displayIdPromise = Promise.resolve(reuseDisplayId);

        const waitForBufferedMeta = (timeoutMs, { requireKeyframe = false } = {}) => new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = setInterval(() => {
                const hasConfig = pendingPackets.some((p) => p.isConfig);
                const hasKey = pendingPackets.some((p) => p.isKeyFrame);
                if (pendingMeta && (!requireKeyframe || (hasConfig && hasKey) || hasKey)) {
                    clearInterval(timer);
                    resolve();
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    clearInterval(timer);
                    if (pendingMeta) {
                        resolve();
                        return;
                    }
                    reject(new Error("Timeout: codec-meta handoff non reçu"));
                }
            }, 40);
        });

        /** Garde config + keyframe utiles pour le decodeur après reset. */
        const trimPacketsForReplay = () => {
            let configIdx = -1;
            for (let i = pendingPackets.length - 1; i >= 0; i -= 1) {
                if (pendingPackets[i].isConfig) {
                    configIdx = i;
                    break;
                }
            }
            if (configIdx >= 0) {
                pendingPackets.splice(0, configIdx);
                return;
            }
            let keyIdx = -1;
            for (let i = pendingPackets.length - 1; i >= 0; i -= 1) {
                if (pendingPackets[i].isKeyFrame) {
                    keyIdx = i;
                    break;
                }
            }
            if (keyIdx > 0) {
                pendingPackets.splice(0, keyIdx);
            }
        };

        try {
            await newClient.start(this.serverJarPath, startOptions);
            await displayIdPromise;

            // Critique : hasVideo = socket seul. Il FAUT attendre codec-meta.
            await waitForBufferedMeta(15000, { requireKeyframe: false });

            const displayId = reuseDisplayId;

            // Refresh keyframe uniquement — jamais move / start_app / new_display.
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (typeof newClient.sendResetVideo === "function") {
                const savedMeta = pendingMeta;
                pendingPackets.length = 0;
                try {
                    await newClient.sendResetVideo();
                    await waitForBufferedMeta(8000, { requireKeyframe: true });
                } catch (err) {
                    console.warn(`[NewInstanceManager][handoff] reset_video:`, err?.message || err);
                    if (!pendingMeta) {
                        pendingMeta = savedMeta;
                    }
                    if (!pendingMeta) {
                        await waitForBufferedMeta(8000, { requireKeyframe: false });
                    }
                }
                if (!pendingMeta) {
                    pendingMeta = savedMeta;
                }
            }

            trimPacketsForReplay();

            if (typeof hooks.notifyStreamRestarting === "function") {
                hooks.notifyStreamRestarting(sessionId);
                // IPC async : laisser le BrowserView vider le decodeur AVANT le replay.
                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            // Stop buffer listeners before attach (évite double handling).
            newClient.removeListener("codec-meta", onMeta);
            newClient.removeListener("raw-packet", onPacket);

            session.client = newClient;
            this._attachClientEvents(session, newClient);
            session.serial = newSerial;
            session.displayId = displayId;
            session.presetDisplayId = displayId;
            session.streamOptions = {
                ...startOptions,
                displayId
            };
            delete session.streamOptions.newDisplay;
            delete session.streamOptions.serverJarPath;
            if (newDisplay) {
                session.preferredNewDisplay = newDisplay;
            }

            if (session.inputController?.setDisplayId) {
                session.inputController.setDisplayId(displayId);
            }
            // Approche rebind abandonnée — dispose pour forcer recreate lazy via _ensureSessionInputController.
            // TODO(Commit suivant): recreate AdbInputController dans switchSessionTransport().
            if (session.inputController) {
                try {
                    if (typeof session.inputController.dispose === "function") {
                        session.inputController.dispose();
                    }
                } catch (_err) {
                    // noop
                }
                session.inputController = null;
                session._inputPrewarmStarted = false;
            }

            // Replay obligatoire : le decodeur a ete reset et la meta warm-up est deja passee.
            if (pendingMeta) {
                session.streamSize = { width: pendingMeta.width, height: pendingMeta.height };
                if (this.onStreamMeta) {
                    this.onStreamMeta(newSerial, pendingMeta, sessionId);
                }
                this.emit("video-codec-meta", { sessionId, ...pendingMeta });
            } else {
                console.warn(`[NewInstanceManager][handoff] PAS de codec-meta à rejouer (${sessionId})`);
            }
            for (const packet of pendingPackets) {
                this.emit("video-packet", {
                    sessionId,
                    pts: packet.pts.toString(),
                    isConfig: packet.isConfig,
                    isKeyFrame: packet.isKeyFrame,
                    data: packet.data
                });
            }
            console.log(
                `[NewInstanceManager][handoff] replay meta=${Boolean(pendingMeta)} packets=${pendingPackets.length}`
            );

            try {
                // Ancien client handoff : stop() ne doit plus remonter en scrcpy-closed.
                if (!session._handoffOldClientStopped) {
                    oldClient._suppressClosedEvent = true;
                    oldClient.removeAllListeners();
                    oldClient.stop();
                }
            } catch (err) {
                console.warn(
                    `[NewInstanceManager][handoff] stop ancien client:`,
                    err?.message || err
                );
            } finally {
                delete session._handoffOldClientStopped;
            }

            await this._ensureDeviceStayAwake(newSerial);
            this._finishTransportReconnect(session, hooks, { success: true });
            console.log(
                `[NewInstanceManager][handoff] OK ${sessionId} displayId=${displayId} shell=${newClient.shellSerial}`
            );
            return { session, mode: "handoff" };
        } catch (err) {
            try {
                newClient.removeListener("codec-meta", onMeta);
                newClient.removeListener("raw-packet", onPacket);
                newClient.removeAllListeners();
                newClient.stop();
            } catch (_e) {
                // noop
            }
            throw err;
        }
    }

    async _coldMigrateSessionTransport(session, newSerial, hooks = {}) {
        // Approche rebind in-place abandonnée (client.rebind retiré).
        // TODO(Commit suivant): appeler switchSessionTransport() ici (destroy+recreate).
        console.warn(
            `[NewInstanceManager][reattach] MIGRATE no-op — rebind retiré, switchSessionTransport pending ` +
            `${session?.sessionId} → ${newSerial}`
        );
        this._finishTransportReconnect(session, hooks, { success: false });
        return { session, mode: "noop-pending-switch" };
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
        if (mergedOptions.newDisplay) {
            session.preferredNewDisplay = mergedOptions.newDisplay;
        }
        // Garder la géométrie préférée même en mode display_id (pour handoffs ultérieurs).
        if (!session.preferredNewDisplay && requestedNewDisplay) {
            session.preferredNewDisplay = requestedNewDisplay;
        }

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
        // Pas de `pm list users` (lent) : user de la session + profils Xiaomi courants.
        const userIds = this._resolveForceStopUserIdsFast(userId);

        // Un seul force-stop par user, en parallèle — suffisant et bien plus rapide.
        const stopResults = await Promise.allSettled(
            userIds.map((uid) => spawnAdbShell(this.adbPath, adbSerial, [
                "am", "force-stop", "--user", String(uid), packageName
            ]))
        );
        const withoutUser = await Promise.allSettled([
            spawnAdbShell(this.adbPath, adbSerial, ["am", "force-stop", packageName])
        ]);

        const stopped = stopResults.some((r) => r.status === "fulfilled")
            || withoutUser.some((r) => r.status === "fulfilled");

        if (stopped) {
            console.log(`[NewInstanceManager] Application arretee: ${packageName}${label} users=[${userIds.join(",")}]`);
        } else {
            for (const result of [...stopResults, ...withoutUser]) {
                if (result.status === "rejected") {
                    console.warn(`[NewInstanceManager] App stop echec:`, result.reason?.message || result.reason);
                }
            }
        }

        await this._removeAppTasksFromRecents(adbSerial, packageName);

        // stayon false en arrière-plan — ne bloque pas la fermeture
        void spawnAdbShell(this.adbPath, adbSerial, ["svc", "power", "stayon", "false"]).catch(() => {});
    }

    _resolveForceStopUserIdsFast(preferredUserId = null) {
        const ids = new Set([0, 10, 999]);
        if (Number.isInteger(preferredUserId)) ids.add(preferredUserId);
        return Array.from(ids);
    }

    async _removeAppTasksFromRecents(serial, packageName) {
        if (!serial || !packageName) return;
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
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (!line.includes(packageName)) continue;
            const window = lines.slice(Math.max(0, i - 4), i + 6).join("\n");
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
                    console.log(`[NewInstanceManager] Task/stack retire: ${shellArgs.join(" ")} (${packageName})`);
                    break;
                } catch (_err) {
                    // essayer la commande suivante
                }
            }
            if (!removed) {
                console.warn(`[NewInstanceManager] Impossible de retirer task ${taskId} (${packageName})`);
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
                await global.killExternalScrcpyLaunchesForApp(entry.deviceId, entry.packageName);
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
