const { EventEmitter } = require("events");
const { exec, spawn } = require("child_process");
const { ScrcpySocketClient } = require("../../native/scrcpy/scrcpy-socket");
const { AdbInputController, KEYCODE_MAP } = require("../../native/scrcpy/control/adb-input-controller");
const { DEFAULT_STREAM_PARAMS, toScrcpyOptions, formatNewDisplay } = require("../../shared/stream-params");
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
    const explicitNewDisplay = Boolean(
        scrcpyOptions.newDisplay
        && scrcpyOptions.displayId === undefined
    );
    const attachDisplayId = Number.isInteger(scrcpyOptions.displayId)
        ? scrcpyOptions.displayId
        : (!explicitNewDisplay && Number.isInteger(merged.displayId) ? merged.displayId : null);

    // Attach display_id (soft-cut USB↔WiFi) : jamais forcer newDisplay par-dessus.
    // Recreate explicite (newDisplay sans displayId) : ne pas hériter d'un vieux displayId.
    if (Number.isInteger(attachDisplayId)) {
        merged.displayId = attachDisplayId;
        delete merged.newDisplay;
    } else {
        delete merged.displayId;
        merged.newDisplay = scrcpyOptions.newDisplay
            || session?.streamOptions?.newDisplay
            || toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay;
    }
    merged.stayAwake = true;
    // Écran device : uniquement le bouton dock ON/OFF (pas d'extinction auto au lancement).
    merged.turnScreenOff = false;
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
        /** @type {Map<string, Promise<void>>} */
        this._forceStopInflight = new Map();
        /** @type {Map<string, number>} */
        this._forceStopDoneUntil = new Map();
        /** @type {Map<string, Promise<void>>} */
        this._reassertInflight = new Map();
        /** @type {Map<string, number>} */
        this._reassertDoneUntil = new Map();
        /** @type {Map<string, Promise<void>>} */
        this._stayOnInflight = new Map();
        /** @type {Map<string, number>} */
        this._stayOnDoneUntil = new Map();
    }

    _forceStopDedupeKey({ sessionId = null, serial = null, packageName = null, userId = null } = {}) {
        if (sessionId) return `s:${sessionId}`;
        const pkg = String(packageName || "").trim();
        const ser = String(serial || "").trim();
        if (!pkg || !ser) return "";
        const uid = Number.isInteger(userId) ? userId : 0;
        return `d:${ser}|${pkg}|${uid}`;
    }

    _reassertDedupeKey({ sessionId = null, serial = null, stableDeviceId = null } = {}) {
        if (sessionId) return `s:${sessionId}`;
        const ser = String(serial || "").trim();
        if (!ser) return "";
        return `d:${ser}|${stableDeviceId || ""}`;
    }

    _markDedupeDone(map, key, ttlMs) {
        if (!key || !map) return;
        map.set(key, Date.now() + ttlMs);
    }

    _isDedupeFresh(map, key) {
        if (!key || !map) return false;
        const until = map.get(key) || 0;
        if (Date.now() < until) return true;
        map.delete(key);
        return false;
    }

    createNewInstanceSession({
        serial,
        stableDeviceId = null,
        packageName,
        userId = null,
        tabLabel = "Nouvelle instance",
        appLabel = null,
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
            appLabel: appLabel ? String(appLabel).trim() : null,
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

    /** Soft cut USB↔WiFi : waiter attachable après création du client. */
    _createFirstPacketWaiter(timeoutMs = 2000) {
        let settle;
        const promise = new Promise((resolve) => {
            settle = resolve;
        });
        let done = false;
        let timer = null;
        let attachedClient = null;
        const onPacket = () => finish(true);
        const finish = (ok) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (attachedClient) {
                try {
                    attachedClient.removeListener("raw-packet", onPacket);
                    attachedClient.removeListener("video-packet", onPacket);
                } catch (_err) {
                    // noop
                }
            }
            settle(ok);
        };
        return {
            promise,
            attach(client) {
                if (done) return;
                if (!client) {
                    finish(false);
                    return;
                }
                attachedClient = client;
                timer = setTimeout(() => finish(false), timeoutMs);
                client.once("raw-packet", onPacket);
                client.once("video-packet", onPacket);
            }
        };
    }

    /** Soft cut USB↔WiFi : true dès le premier paquet vidéo (ou timeout). */
    _waitForClientFirstPacket(client, timeoutMs = 5000) {
        const waiter = this._createFirstPacketWaiter(timeoutMs);
        waiter.attach(client);
        return waiter.promise;
    }

    async _ensureDeviceStayAwake(serial) {
        if (!serial) return;
        const key = String(serial);
        if (this._isDedupeFresh(this._stayOnDoneUntil, key)) {
            return;
        }
        const inflight = this._stayOnInflight.get(key);
        if (inflight) {
            await inflight;
            return;
        }

        const run = (async () => {
            try {
                await execPromise(`"${this.adbPath}" -s ${adbSerialArg(serial)} shell svc power stayon true`);
            } catch (err) {
                console.warn(`[NewInstanceManager] stayon ${serial}:`, err.message);
            }
        })();
        this._stayOnInflight.set(key, run);
        try {
            await run;
            this._markDedupeDone(this._stayOnDoneUntil, key, 4000);
        } finally {
            this._stayOnInflight.delete(key);
        }
    }

    async _applyDesiredPhysicalScreen(session) {
        if (!session?.serial) return;

        await this._ensureDeviceStayAwake(session.serial);

        const turnOff = typeof global.shouldPhysicalScreenBeOff === "function"
            ? global.shouldPhysicalScreenBeOff(session.serial, session.stableDeviceId, { typeBDefault: true })
            : true;

        const client = session.client;
        if (client?.controlSocket && typeof client.setDisplayPower === "function") {
            try {
                await client.setDisplayPower(!turnOff);
                session.physicalScreenOff = turnOff;
                console.log(
                    `[NewInstanceManager] Ecran physique ${turnOff ? "eteint" : "allume"}`
                    + ` (${session.sessionId})`
                );
                if (typeof global.syncDeviceScreenOffState === "function") {
                    global.syncDeviceScreenOffState(session.serial, turnOff, {
                        stableDeviceId: session.stableDeviceId || null,
                        mode: "scrcpy"
                    });
                }
                return;
            } catch (err) {
                console.warn(`[NewInstanceManager] setDisplayPower(${!turnOff}):`, err.message);
            }
        }

        if (turnOff) {
            // Jamais de KEYCODE_SLEEP si un miroir Type A est actif (flux noir).
            if (this._hasTypeAOnDevice(session.serial, session.stableDeviceId, session.sessionId)) {
                console.warn(
                    `[NewInstanceManager] skip keyevent 223 — Type A actif (${session.sessionId})`
                );
                try {
                    await this._reassertScreenOffViaTypeA(
                        session.serial,
                        session.stableDeviceId,
                        session.sessionId
                    );
                } catch (_err) {
                    // noop
                }
                return;
            }
            try {
                await execPromise(`"${this.adbPath}" -s ${adbSerialArg(session.serial)} shell input keyevent 223`);
                session.physicalScreenOff = true;
                console.log(`[NewInstanceManager] Ecran physique eteint via keyevent (${session.sessionId})`);
                if (typeof global.syncDeviceScreenOffState === "function") {
                    global.syncDeviceScreenOffState(session.serial, true, {
                        stableDeviceId: session.stableDeviceId || null,
                        mode: "adb"
                    });
                }
            } catch (err) {
                console.warn(`[NewInstanceManager] fallback keyevent sleep:`, err.message);
            }
            return;
        }

        try {
            await execPromise(`"${this.adbPath}" -s ${adbSerialArg(session.serial)} shell input keyevent 224`);
            session.physicalScreenOff = false;
            console.log(`[NewInstanceManager] Ecran physique allume via keyevent (${session.sessionId})`);
            if (typeof global.syncDeviceScreenOffState === "function") {
                global.syncDeviceScreenOffState(session.serial, false, {
                    stableDeviceId: session.stableDeviceId || null,
                    mode: "adb"
                });
            }
        } catch (err) {
            console.warn(`[NewInstanceManager] fallback keyevent wake:`, err.message);
        }
    }

    /** @deprecated — utiliser _applyDesiredPhysicalScreen */
    async _turnOffPhysicalScreen(session) {
        return this._applyDesiredPhysicalScreen(session);
    }

    /**
     * Scrcpy restaure souvent l'écran à la coupure du contrôle.
     * Re-applique KEYCODE_SLEEP (223) via ADB pour garder l'écran éteint après une session Type B.
     */
    async _sleepPhysicalScreenViaAdb(serial) {
        if (!serial || !this.adbPath) return;
        try {
            await spawnAdbShell(this.adbPath, serial, ["input", "keyevent", "223"]);
            console.log(`[NewInstanceManager] Ecran re-eteint via keyevent (${serial})`);
        } catch (err) {
            console.warn(`[NewInstanceManager] re-eteindre ecran:`, err?.message || err);
        }
    }

    _sameDeviceSession(entryOrSummary, serial, stableDeviceId) {
        if (!entryOrSummary) return false;
        if (stableDeviceId && entryOrSummary.stableDeviceId && entryOrSummary.stableDeviceId === stableDeviceId) {
            return true;
        }
        const otherSerial = entryOrSummary.deviceId || entryOrSummary.serial || null;
        if (serial && otherSerial && otherSerial === serial) return true;
        if (stableDeviceId && otherSerial && otherSerial === stableDeviceId) return true;
        return false;
    }

    /** Liste les sessions Type A encore ouvertes sur ce device. */
    _listTypeAOnDevice(serial, stableDeviceId = null, excludeSessionId = null) {
        const bvm = global.browserViewManager;
        if (!bvm?.getAllSessions) return [];

        const matched = [];
        const allTypeA = [];
        for (const summary of bvm.getAllSessions()) {
            if (!summary || summary.type !== "A") continue;
            if (excludeSessionId && summary.sessionId === excludeSessionId) continue;
            allTypeA.push(summary);
            if (this._sameDeviceSession(summary, serial, stableDeviceId)) {
                matched.push(summary);
            }
        }
        if (matched.length) return matched;
        // Filet USB/Wi‑Fi : un seul Type A ouvert → considérer le même device.
        if (allTypeA.length === 1 && (serial || stableDeviceId)) {
            return allTypeA;
        }
        return [];
    }

    /** True si une session Type A existe encore sur ce device (quel que soit screenOff). */
    _hasTypeAOnDevice(serial, stableDeviceId = null, excludeSessionId = null) {
        return this._listTypeAOnDevice(serial, stableDeviceId, excludeSessionId).length > 0;
    }

    /** True si une session Type A sur le même device veut encore l'écran allumé. */
    _hasTypeAWantingScreenOn(serial, stableDeviceId = null, excludeSessionId = null) {
        for (const summary of this._listTypeAOnDevice(serial, stableDeviceId, excludeSessionId)) {
            const entry = global.browserViewManager?.getSessionEntry?.(summary.sessionId);
            if (entry && entry.screenOff === true) continue;
            return true;
        }
        return false;
    }

    /**
     * Re-off panneau via le client Type A uniquement (jamais KEYCODE_SLEEP).
     * Le sleep ADB noircit le flux miroir — interdit dès qu'un Type A vit.
     */
    async _reassertScreenOffViaTypeA(serial, stableDeviceId = null, excludeSessionId = null) {
        const typeAList = this._listTypeAOnDevice(serial, stableDeviceId, excludeSessionId);
        if (!typeAList.length) return { mode: "no-type-a", count: 0 };

        let applied = 0;
        for (const summary of typeAList) {
            const client = typeof global.getVideoClientForSession === "function"
                ? global.getVideoClientForSession(summary.sessionId)
                : null;
            if (!client?.controlSocket || typeof client.setDisplayPower !== "function") {
                continue;
            }
            try {
                // stayon pour éviter le doze (flux noir) tout en gardant le panneau off.
                try {
                    await spawnAdbShell(this.adbPath, serial, ["svc", "power", "stayon", "true"]);
                } catch (_err) {
                    // noop
                }
                await client.setDisplayPower(false);
                applied += 1;
                console.log(
                    `[NewInstanceManager] re-off panneau via Type A setDisplayPower`
                    + ` (${summary.sessionId})`
                );
            } catch (err) {
                console.warn(
                    `[NewInstanceManager] setDisplayPower Type A (${summary.sessionId}):`,
                    err?.message || err
                );
            }
        }
        return { mode: "typeA-scrcpy", count: applied };
    }

    /**
     * Après stop scrcpy (Type A ou B) : garder l'écran device OFF si le bouton dock est OFF.
     * Règle stricte : autre Type A encore présent → uniquement setDisplayPower, jamais keyevent 223.
     */
    async reassertPhysicalScreenOffAfterClose({
        serial,
        stableDeviceId = null,
        sessionId = null,
        retries = 1,
        force = false
    } = {}) {
        if (!serial) return;

        const dedupeKey = this._reassertDedupeKey({ sessionId, serial, stableDeviceId });
        if (!force && this._isDedupeFresh(this._reassertDoneUntil, dedupeKey)) {
            console.log(
                `[NewInstanceManager] skip re-off ecran — déjà fait`
                + (sessionId ? ` (${sessionId})` : "")
            );
            return;
        }
        const inflight = dedupeKey ? this._reassertInflight.get(dedupeKey) : null;
        if (inflight) {
            await inflight;
            if (!force) return;
        }

        const run = this._reassertPhysicalScreenOffAfterCloseImpl({
            serial,
            stableDeviceId,
            sessionId,
            retries
        });
        if (dedupeKey) this._reassertInflight.set(dedupeKey, run);
        try {
            await run;
            this._markDedupeDone(this._reassertDoneUntil, dedupeKey, 8000);
        } finally {
            if (dedupeKey) this._reassertInflight.delete(dedupeKey);
        }
    }

    async _reassertPhysicalScreenOffAfterCloseImpl({
        serial,
        stableDeviceId = null,
        sessionId = null,
        retries = 1
    } = {}) {
        const desiredOff = typeof global.getDesiredScreenOff === "function"
            ? global.getDesiredScreenOff(serial, stableDeviceId)
            : null;
        // Uniquement si l'utilisateur a explicitement mis OFF via le bouton dock.
        if (desiredOff !== true) {
            console.log(
                `[NewInstanceManager] skip re-off ecran — intention pas OFF`
                + (sessionId ? ` (apres ${sessionId})` : "")
            );
            return;
        }

        const hasTypeA = this._hasTypeAOnDevice(serial, stableDeviceId, sessionId);

        // ——— Autre Type A vivant : panneau off via scrcpy A seulement (protège le flux) ———
        if (hasTypeA) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            if (typeof global.getDesiredScreenOff === "function"
                && global.getDesiredScreenOff(serial, stableDeviceId) === false) {
                return;
            }
            try {
                const result = await this._reassertScreenOffViaTypeA(serial, stableDeviceId, sessionId);
                console.log(
                    `[NewInstanceManager] re-off apres close mode=${result.mode} applied=${result.count}`
                    + (sessionId ? ` (${sessionId})` : "")
                );
            } catch (err) {
                console.warn(`[NewInstanceManager] re-off Type A:`, err?.message || err);
            }
            if (typeof global.syncDeviceScreenOffState === "function") {
                global.syncDeviceScreenOffState(serial, true, {
                    stableDeviceId,
                    mode: "scrcpy"
                });
            }
            // Un second passage après la restauration scrcpy — toujours sans ADB sleep.
            for (let i = 0; i < retries; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                if (typeof global.getDesiredScreenOff === "function"
                    && global.getDesiredScreenOff(serial, stableDeviceId) === false) {
                    return;
                }
                try {
                    await this._reassertScreenOffViaTypeA(serial, stableDeviceId, sessionId);
                } catch (_err) {
                    // noop
                }
            }
            return;
        }

        // ——— Plus de Type A : setDisplayPower (Type B restant) / ADB sleep autorisé ———
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (typeof global.getDesiredScreenOff === "function"
            && global.getDesiredScreenOff(serial, stableDeviceId) === false) {
            return;
        }

        try {
            if (typeof global.applyPhysicalScreenPower === "function") {
                const result = await global.applyPhysicalScreenPower(serial, true, {
                    stableDeviceId,
                    preferSerial: serial,
                    allowAdbSleep: true
                });
                console.log(
                    `[NewInstanceManager] re-off apres close mode=${result?.mode || "?"}`
                    + (sessionId ? ` (${sessionId})` : "")
                );
            } else {
                await this._sleepPhysicalScreenViaAdb(serial);
            }
        } catch (err) {
            console.warn(`[NewInstanceManager] re-off ecran:`, err?.message || err);
        }

        if (typeof global.syncDeviceScreenOffState === "function") {
            global.syncDeviceScreenOffState(serial, true, { stableDeviceId, mode: "adb" });
        }

        for (let i = 0; i < retries; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 450));
            if (typeof global.getDesiredScreenOff === "function"
                && global.getDesiredScreenOff(serial, stableDeviceId) === false) {
                return;
            }
            try {
                if (typeof global.applyPhysicalScreenPower === "function") {
                    await global.applyPhysicalScreenPower(serial, true, {
                        stableDeviceId,
                        preferSerial: serial,
                        allowAdbSleep: true
                    });
                } else {
                    await this._sleepPhysicalScreenViaAdb(serial);
                }
            } catch (_err) {
                // noop
            }
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
            const dims = session.launchDims?.width > 0 && session.launchDims?.height > 0
                ? session.launchDims
                : null;
            await session.inputController.init(dims);
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
                const dims = session.launchDims?.width > 0 && session.launchDims?.height > 0
                    ? session.launchDims
                    : null;
                await session.inputController.init(dims);
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

        // Closed retardés post-rebind : déjà filtrés par `session.client !== client`
        // dans le listener. Ne PAS ignorer ici via hasVideo/serverAlive — au moment du
        // "closed", le socket peut encore être référencé et le process pas encore exit,
        // ce qui laissait un onglet zombie (noir / — fps) en USB et WiFi.

        // Transport reattach (USB↔WiFi) : ne pas force-stop / delete / emit pendant reconnecting.
        if (session.state === "reconnecting" || session._transportRebindActive) {
            console.log(
                `[NewInstanceManager] closed ignoré — reattach en cours (${session.sessionId}, state=${session.state})`
            );
            return;
        }

        if (session._scrcpyCloseHandling) {
            console.log(
                `[NewInstanceManager] closed ignoré — teardown déjà en cours (${session.sessionId})`
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

        session._scrcpyCloseHandling = true;
        try {
            // USB : hold Continuer WiFi seulement si le transport a disparu (débranchement).
            // Si le device USB est encore online, scrcpy est mort pour une autre raison
            // (app/VD quittée) → même teardown que sur WiFi (évite onglet zombie noir).
            // Reattach intentionnel : déjà filtré plus haut (reconnecting / _transportRebindActive).
            const shellSerial = session.client?.shellSerial || session.serial;
            const onWifiShell = Boolean(global.wifiAdbService?.isWifiSerial?.(shellSerial));
            const deviceId = session.stableDeviceId || null;
            const wifiArmed = Boolean(
                deviceId && global.wifiDevicesManager?.getByDeviceId?.(deviceId)?.wifiEnabled
            );

            if (!onWifiShell) {
                let usbStillOnline = await this._isUsbTransportStillOnline(session, shellSerial);

                // Race débranchement : scrcpy peut mourir avant qu'ADB retire le serial.
                // Court délai + re-check ; si la topologie a déjà posé reconnecting → ne pas teardown.
                if (usbStillOnline) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    if (!this.sessions.has(session.sessionId)) return;
                    if (session.state === "reconnecting" || session._transportRebindActive) {
                        console.log(
                            `[NewInstanceManager] closed ignoré — reattach pendant vérif USB (${session.sessionId})`
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
                    if (session._ignoreScrcpyClosedUntil && Date.now() < session._ignoreScrcpyClosedUntil) {
                        console.warn(
                            `[NewInstanceManager] closed ignoré — ignoreScrcpyClosedUntil ${session.sessionId}`
                        );
                        return;
                    }
                    usbStillOnline = await this._isUsbTransportStillOnline(session, shellSerial);
                }

                if (!usbStillOnline) {
                    session.client = null;
                    this.beginTransportReconnect(session);
                    notifySessionStreamRestarting(session.sessionId);
                    console.log(
                        `[NewInstanceManager] USB shell closed — hold session=${session.sessionId}`
                        + (wifiArmed ? " (WiFi armé → rebind silencieux)" : " pour Continuer WiFi")
                    );
                    return;
                }
                console.log(
                    `[NewInstanceManager] USB shell closed — device encore online,`
                    + ` fermeture session=${session.sessionId}`
                );
            }

            const wasActive = session.state === "started"
                || session.state === "starting"
                || session.state === "display-ready";
            if (!wasActive || !session.packageName || !session.serial) {
                session.state = "stopped";
                session.client = null;
                this.sessions.delete(session.sessionId);
                this.emit("state", { sessionId: session.sessionId, state: session.state });
                this.emit("scrcpy-closed", { sessionId: session.sessionId });
                return;
            }

            console.log(`[NewInstanceManager] Scrcpy ferme — force-stop ${session.packageName} (${session.sessionId})`);
            session._appForceStopped = true;
            session.state = "stopped";
            session.client = null;

            const closedSerial = session.serial;
            const closedStableId = session.stableDeviceId || null;
            const closedSessionId = session.sessionId;

            await this.forceStopAppOnDevice({
                serial: session.serial,
                packageName: session.packageName,
                userId: session.userId,
                sessionId: session.sessionId,
                stableDeviceId: closedStableId
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

            // Scrcpy rallume souvent l'écran à la déconnexion — re-éteint pour Type B.
            void this.reassertPhysicalScreenOffAfterClose({
                serial: closedSerial,
                stableDeviceId: closedStableId,
                sessionId: closedSessionId
            }).catch(() => {});
        } finally {
            if (this.sessions.has(session.sessionId)) {
                session._scrcpyCloseHandling = false;
            }
        }
    }

    /**
     * True si un transport USB ADB est encore online pour cette session.
     * En cas d'incertitude → false (conserve le hold Continuer WiFi historique).
     */
    async _isUsbTransportStillOnline(session, shellSerial = null) {
        try {
            const registry = global.deviceRegistry;
            const deviceId = session?.stableDeviceId || null;
            const preferred = shellSerial || session?.serial || null;

            if (registry?.resolveLiveUsbSerial) {
                const live = await registry.resolveLiveUsbSerial({
                    deviceId,
                    preferredSerial: preferred
                });
                return Boolean(live);
            }

            if (registry?.getRawAdbDevices && preferred) {
                const raw = await registry.getRawAdbDevices();
                return (raw || []).some((device) =>
                    device?.serial === preferred
                    && device.connected !== false
                    && device.status === "green"
                    && !global.wifiAdbService?.isWifiSerial?.(device.serial)
                );
            }
        } catch (err) {
            console.warn(
                `[NewInstanceManager] USB presence check failed:`,
                err?.message || err
            );
        }
        return false;
    }

    /** Géométrie new_display pour recreate après mort du VD (stop scrcpy). */
    _resolveSessionNewDisplay(session) {
        if (session?.streamOptions?.newDisplay) {
            return session.streamOptions.newDisplay;
        }
        const w = session?.streamSize?.width;
        const h = session?.streamSize?.height;
        if (w > 0 && h > 0) {
            return formatNewDisplay({ width: w, height: h });
        }
        return toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay;
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
        this.emit("state", {
            sessionId: session.sessionId,
            state: "reconnecting",
            serial: session.serial,
            stableDeviceId: session.stableDeviceId || null,
            packageName: session.packageName
        });
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
            stableDeviceId: session.stableDeviceId || null,
            packageName: session.packageName
        });
    }

    /**
     * Destroy+recreate orchestré Type B (USB↔WiFi).
     * 1) Tentative attach display_id (si le VD a survécu)
     * 2) Sinon recreate new_display + relaunch app (le stop scrcpy détruit souvent le VD)
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

        session._transportRebindActive = true;

        console.log(
            `[switchSessionTransport] Type B begin session=${session.sessionId} newSerial=${newSerial}`
        );

        notifySessionStreamRestarting(session.sessionId);

        const newDisplay = this._resolveSessionNewDisplay(session);

        const streamW = session.streamSize?.width || null;
        const streamH = session.streamSize?.height || null;

        session.serial = newSerial;

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

        const stopCurrentClient = () => {
            try {
                session.client?.stop?.();
            } catch (_err) {
                // noop
            }
            session.client = null;
        };

        const startWithFirstPacket = async (options, timeoutMs) => {
            const firstPacketDeferred = this._createFirstPacketWaiter(timeoutMs);
            await this._runClientStart(session, options);
            // _runClientStart pose state=started — rester en mode rebind jusqu'à la fin.
            if (session.state !== "reconnecting") {
                session.state = "reconnecting";
            }
            firstPacketDeferred.attach(session.client);
            return firstPacketDeferred.promise;
        };

        try {
            // Après stop scrcpy le VD est presque toujours mort : recreate direct (pas d'attach lent).
            session.skipPackageLaunch = false;
            session.displayId = null;
            session.presetDisplayId = null;
            const recreateOptions = {
                ...(session.streamOptions || {}),
                newDisplay,
                skipPackageLaunch: false,
                vdDestroyContent: false
            };
            delete recreateOptions.displayId;
            const firstPacketOk = await startWithFirstPacket(recreateOptions, 3500);
            if (!firstPacketOk) {
                throw new Error("Pas de flux vidéo après recreate new_display");
            }

            await this._ensureSessionInputController(session, streamW, streamH);

            this.endTransportReconnect(session, { success: true });
            console.log(
                `[switchSessionTransport] Type B ok session=${session.sessionId} newSerial=${newSerial} `
                + `mode=recreate displayId=${session.displayId ?? "?"} firstPacket=${firstPacketOk}`
            );
            return { success: true };
        } catch (err) {
            stopCurrentClient();
            this.endTransportReconnect(session, { success: false });
            console.warn(
                `[switchSessionTransport] Type B fail session=${session.sessionId}:`,
                err?.message || err
            );
            return { success: false, error: err?.message || "Échec start vidéo" };
        } finally {
            session._transportRebindActive = false;
        }
    }

    /**
     * Switch toutes les sessions Type B du device vers newSerial.
     * @param {string} deviceId
     * @param {string} newSerial
     * @param {{ extraAliases?: string[] }} [options]
     * @returns {{ success: boolean, count: number }}
     */
    async switchTypeBSessionsForDevice(deviceId, newSerial, { extraAliases = [] } = {}) {
        if (!deviceId || !newSerial) {
            return { success: false, count: 0 };
        }

        const aliases = new Set(
            [deviceId, ...(Array.isArray(extraAliases) ? extraAliases : [])]
                .map((value) => (value == null ? "" : String(value).trim()))
                .filter(Boolean)
        );
        try {
            const cfg = global.wifiDevicesManager?.getByDeviceId?.(deviceId);
            if (cfg?.deviceId) aliases.add(String(cfg.deviceId));
            if (cfg?.usbSerialHint) aliases.add(String(cfg.usbSerialHint));
            if (cfg?.ip) {
                const wifiSerial = global.wifiAdbService?.buildWifiSerial?.(
                    cfg.ip,
                    cfg.port || 5555
                );
                if (wifiSerial) aliases.add(String(wifiSerial));
            }
        } catch (_err) {
            // noop
        }

        // Filet : IDs Type B connus via BrowserView (stableDeviceId / deviceId).
        try {
            for (const entry of global.browserViewManager?.getAllSessions?.() || []) {
                if (entry?.type !== "B" || !entry.sessionId) continue;
                if (
                    aliases.has(String(entry.stableDeviceId || ""))
                    || aliases.has(String(entry.deviceId || ""))
                    || aliases.has(String(entry.serial || ""))
                ) {
                    aliases.add(String(entry.sessionId));
                }
            }
        } catch (_err) {
            // noop
        }

        const isWifi = (serial) => Boolean(global.wifiAdbService?.isWifiSerial?.(serial));
        const sessions = [];
        const seen = new Set();

        for (const summary of this.listNewInstanceSessions() || []) {
            if (summary.state === "stopped" || summary.state === "stopping") continue;
            const matches = aliases.has(String(summary.stableDeviceId || ""))
                || aliases.has(String(summary.serial || ""))
                || aliases.has(String(summary.sessionId || ""));
            if (!matches) continue;

            const session = this.getNewInstanceSession(summary.sessionId);
            if (!session || seen.has(session.sessionId)) continue;

            const shouldSwitch = summary.state === "reconnecting"
                || summary.state === "started"
                || summary.state === "display-ready"
                || summary.state === "starting"
                || isWifi(session.serial)
                || isWifi(summary.serial)
                || session.serial !== newSerial;

            if (!shouldSwitch) continue;

            if (session.state !== "reconnecting") {
                this.beginTransportReconnect(session);
            }
            seen.add(session.sessionId);
            sessions.push(session);
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
            // Si desiredOff suit juste après, _applyDesiredPhysicalScreen rappelle déjà stayon
            // (dedupe manager) — un seul appel ADB effectif.
            await this._ensureDeviceStayAwake(session.serial);
        }

        // Scrcpy peut rallumer le panneau au start — réappliquer OFF si le bouton est OFF.
        const desiredOff = typeof global.getDesiredScreenOff === "function"
            ? global.getDesiredScreenOff(session.serial, session.stableDeviceId)
            : null;
        if (desiredOff === true) {
            const settleMs = session._transportRebindActive ? 0 : 120;
            if (settleMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, settleMs));
            }
            await this._applyDesiredPhysicalScreen(session);
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

        const dedupeKey = this._forceStopDedupeKey({ sessionId, serial, packageName, userId });
        if (this._isDedupeFresh(this._forceStopDoneUntil, dedupeKey)) {
            console.log(
                `[NewInstanceManager] skip force-stop — déjà fait`
                + (sessionId ? ` (${sessionId})` : ` ${packageName}`)
            );
            return;
        }
        const inflight = dedupeKey ? this._forceStopInflight.get(dedupeKey) : null;
        if (inflight) {
            await inflight;
            return;
        }

        const run = this._forceStopAppOnDeviceImpl({
            serial,
            packageName,
            userId,
            sessionId,
            stableDeviceId
        });
        if (dedupeKey) this._forceStopInflight.set(dedupeKey, run);
        try {
            await run;
            this._markDedupeDone(this._forceStopDoneUntil, dedupeKey, 8000);
        } finally {
            if (dedupeKey) this._forceStopInflight.delete(dedupeKey);
        }
    }

    async _forceStopAppOnDeviceImpl({ serial, packageName, userId = null, sessionId = null, stableDeviceId = null }) {
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

        try {
            await spawnAdbShell(this.adbPath, adbSerial, [
                "am", "force-stop", "--user", String(targetUserId), packageName
            ]);
            console.log(`[NewInstanceManager] Application arretee: ${packageName}${label} user=${targetUserId}`);
        } catch (err) {
            console.warn(
                `[NewInstanceManager] App stop echec (user=${targetUserId}):`,
                err?.message || err
            );
        }

        await this._removeAppTasksFromRecents(adbSerial, packageName, targetUserId);

        // Ne coupe pas stayon si une autre session (Type B ou Type A) tourne encore sur ce device.
        const otherTypeBAlive = Array.from(this.sessions.values()).some((s) => (
            s.sessionId !== sessionId
            && s.state !== "stopped"
            && s.state !== "stopping"
            && (
                (serial && s.serial === serial)
                || (adbSerial && s.serial === adbSerial)
                || (stableDeviceId && s.stableDeviceId && s.stableDeviceId === stableDeviceId)
            )
        ));
        const typeAAlive = this._hasTypeAOnDevice(adbSerial || serial, stableDeviceId, sessionId);
        if (!otherTypeBAlive && !typeAAlive) {
            void spawnAdbShell(this.adbPath, adbSerial, ["svc", "power", "stayon", "false"]).catch(() => {});
        } else if (typeAAlive) {
            // Garde le device eveille pour le miroir Type A (évite flux noir).
            void spawnAdbShell(this.adbPath, adbSerial, ["svc", "power", "stayon", "true"]).catch(() => {});
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

    async ensureAppStoppedForSessionClose(sessionId, fallback = null) {
        const session = this.sessions.get(sessionId);
        if (session) {
            await this.stopNewInstanceSession(sessionId);
            return;
        }

        const entry = global.browserViewManager?.getSessionEntry(sessionId);
        const serial = entry?.deviceId || fallback?.serial || null;
        const packageName = entry?.packageName || fallback?.packageName || null;
        const userId = Number.isInteger(entry?.userId)
            ? entry.userId
            : (Number.isInteger(fallback?.userId) ? fallback.userId : null);
        const stableDeviceId = entry?.stableDeviceId || fallback?.stableDeviceId || null;

        if (!packageName || !serial) {
            return;
        }

        await this.forceStopAppOnDevice({
            serial,
            packageName,
            userId,
            sessionId,
            stableDeviceId
        });

        if (typeof global.killExternalScrcpyLaunchesForApp === "function") {
            try {
                await global.killExternalScrcpyLaunchesForApp(serial, packageName, userId);
            } catch (err) {
                console.warn(`[NewInstanceManager] kill scrcpy externe (fallback):`, err?.message || err);
            }
        }

        await this.reassertPhysicalScreenOffAfterClose({
            serial,
            stableDeviceId,
            sessionId
        });
    }

    async stopNewInstanceSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        console.warn(
            `[NewInstanceManager] stopNewInstanceSession ${sessionId} state=${session.state} intentional=${Boolean(session._intentionalStop)}`
        );

        session.state = "stopping";
        session._intentionalStop = true;
        session._appForceStopped = true;

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
        // Scrcpy restaure l'écran à l'arrêt : re-éteint après force-stop / kill externe.
        // Dedupe manager : session:close / renderer ne relanceront pas les mêmes ADB.
        void (async () => {
            try {
                if (killPayload.packageName) {
                    await this.forceStopAppOnDevice(killPayload);
                }
            } catch (err) {
                console.warn(`[NewInstanceManager] force-stop background:`, err?.message || err);
            }

            if (externalLaunchId && typeof global.killExternalScrcpyLaunch === "function") {
                try {
                    await global.killExternalScrcpyLaunch(externalLaunchId);
                } catch (err) {
                    console.warn(`[NewInstanceManager] kill scrcpy externe:`, err?.message || err);
                }
            }

            try {
                await this.reassertPhysicalScreenOffAfterClose({
                    serial: killPayload.serial,
                    stableDeviceId: killPayload.stableDeviceId,
                    sessionId: killPayload.sessionId
                });
            } catch (err) {
                console.warn(`[NewInstanceManager] re-off ecran:`, err?.message || err);
            }
        })();
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
