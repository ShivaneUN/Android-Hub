const { app, BrowserWindow, ipcMain } = require("electron");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const path = require("path");
const fs = require("fs");
const { exec, spawn } = require("child_process");

const CREATE_NO_WINDOW = 0x08000000;

function spawnHiddenProcess(command, args, options = {}) {
    const spawnOptions = {
        windowsHide: true,
        ...options
    };
    if (process.platform === "win32") {
        spawnOptions.creationFlags = CREATE_NO_WINDOW;
    }
    return spawn(command, args, spawnOptions);
}
const { ScrcpySocketClient } = require("../native/scrcpy/scrcpy-socket");
const { AdbInputController, KEYCODE_MAP } = require("../native/scrcpy/control/adb-input-controller");
const { NewInstanceManager } = require("./managers/new-instance-manager");
const { registerNewInstanceIpc } = require("./ipc/new-instance-ipc");
const BrowserViewManager = require("./managers/browserViewManager");
const {
    registerSessionHandlers,
    registerStreamParamsHandlers,
    setupBrowserViewVideoForwarding,
    forwardTypeAVideoEvent,
    forwardSessionAudioEvent
} = require("./ipc/sessionHandlers");
const { StreamParamsManager } = require("./managers/stream-params-manager");
const {
    applyCaptureOrientationToOptions,
    getOrientationFromScrcpyOptions
} = require("../shared/stream-params");
const { SessionStreamRegistry } = require("./managers/session-stream-registry");
const { VideoPreviewTooltipManager } = require("./managers/video-preview-tooltip-manager");
const { registerVideoPreviewHandlers } = require("./ipc/videoPreviewHandlers");
const { CustomNamesManager } = require("./managers/custom-names-manager");
const { registerNamesHandlers } = require("./ipc/namesHandlers");
const { RenameDialogManager } = require("./managers/rename-dialog-manager");
const { HubModalOverlayManager } = require("./managers/hub-modal-overlay-manager");
const { registerHubModalHandlers } = require("./ipc/hubModalHandlers");
const { registerContextMenuHandlers } = require("./ipc/contextMenuHandlers");
const { LaunchHistoryManager } = require("./managers/launch-history-manager");
const { registerLaunchHistoryHandlers } = require("./ipc/launchHistoryHandlers");
const { DeviceColorsManager } = require("./managers/device-colors-manager");
const { registerDeviceColorsHandlers } = require("./ipc/deviceColorsHandlers");
const { AppMetadataManager } = require("./managers/app-metadata-manager");
const { registerAppMetadataHandlers, attachAppMetadataPrefetch } = require("./ipc/appMetadataHandlers");
const { fromScrcpyOptions } = require("../shared/stream-params");
const { GlobalAudioOutputManager } = require("./managers/global-audio-output-manager");
const { SessionAudioProcessManager } = require("./managers/session-audio-process-manager");
const { registerAudioHandlers } = require("./ipc/audioHandlers");

app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

async function resolveLaunchActivity(serial, packageName, userId = null) {
    const userArg = Number.isInteger(userId) ? ` --user ${userId}` : "";
    try {
        const stdout = await execPromise(`"${adbPath}" -s ${serial} shell cmd package resolve-activity${userArg} --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}`);
        const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return null;
        const candidate = lines.find(l => l.includes('/')) || lines[lines.length - 1];
        return candidate || null;
    } catch (err) {
        console.error(`Erreur résolution activité pour ${packageName}:`, err.message);
        return null;
    }
}

async function launchPackageOnDisplay(serial, packageName, displayId, options = {}) {
    if (!packageName) return;

    const userId = Number.isInteger(options.userId) ? options.userId : null;
    const userArg = userId !== null ? ` --user ${userId}` : "";
    const monkeyUserArg = userId !== null ? ` --user ${userId}` : "";
    const activity = await resolveLaunchActivity(serial, packageName, userId);

    if (!activity) {
        exec(`"${adbPath}" -s ${serial} shell monkey${monkeyUserArg} -p ${packageName} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err) => {
            if (err) console.error(`Fallback lancement app ${packageName} (user=${userId ?? "default"}):`, err.message);
        });
        return;
    }

    const useDisplay = Number.isInteger(displayId);
    const launchCandidates = [];
    if (useDisplay) {
        launchCandidates.push(
            options.backgroundLaunch
                ? `"${adbPath}" -s ${serial} shell am start${userArg} --display ${displayId} --activity-task-on-home -n ${activity}`
                : `"${adbPath}" -s ${serial} shell am start${userArg} --display ${displayId} -n ${activity}`
        );
    }
    launchCandidates.push(
        options.backgroundLaunch
            ? `"${adbPath}" -s ${serial} shell am start${userArg} --activity-task-on-home -n ${activity}`
            : `"${adbPath}" -s ${serial} shell am start${userArg} -n ${activity}`
    );
    launchCandidates.push(`"${adbPath}" -s ${serial} shell am start${userArg} -n ${activity}`);

    let launched = false;
    for (const launchCmd of launchCandidates) {
        try {
            await execPromise(launchCmd);
            launched = true;
            break;
        } catch (err) {
            console.warn(`Échec commande lancement app (${packageName}): ${launchCmd} -> ${err.message}`);
        }
    }

    if (!launched) {
        exec(`"${adbPath}" -s ${serial} shell monkey${monkeyUserArg} -p ${packageName} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err2) => {
            if (err2) console.error(`Fallback lancement app ${packageName} (user=${userId ?? "default"}):`, err2.message);
        });
        return;
    }

    if (options.backgroundLaunch) {
        exec(`"${adbPath}" -s ${serial} shell input keyevent 3`, { windowsHide: true }, (err) => {
            if (err) console.error("Erreur mise de l'app en arrière-plan:", err.message);
        });
    }
}

let win;

const appIconPath = path.join(__dirname, "..", "assets", "icons", "icon.ico");

function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        autoHideMenuBar: true,
        frame: false,
        icon: appIconPath,
        show: false,
        backgroundColor: "#0a0e14",
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false
        }
    });

    win.setTitle("Android Hub");
    win.once("ready-to-show", () => {
        if (!win.isDestroyed()) {
            win.show();
        }
    });
    win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

const { getAdbPath, getScrcpyBinaryPath, getServerJarPath } = require("./paths");
const { initAutoUpdater } = require("./auto-updater");
const { registerUpdateHandlers } = require("./ipc/updateHandlers");
const { DeviceManager } = require("./managers/device-manager");
const { DeviceRegistry } = require("./managers/device-registry");
const { WifiDevicesManager } = require("./managers/wifi-devices-manager");
const { WifiAdbService } = require("./managers/wifi-adb-service");
const { DevicePowerManager } = require("./managers/device-power-manager");
const { DeviceOrientationManager } = require("./managers/device-orientation-manager");
const { registerWifiHandlers } = require("./ipc/wifiHandlers");

const adbPath = getAdbPath();
const serverJarPath = getServerJarPath();
const scrcpyBinaryPath = getScrcpyBinaryPath();

let historyPath;
let deviceManager;
let deviceRegistry;
let wifiDevicesManager;
let wifiAdbService;
let wifiStartupPromise = null;
let appMetadataManager;
let newInstanceManager;
let launchHistoryManager;
let devicePowerManager;
let deviceOrientationManager;
let lastConnectedSerials = [];

function syncDevicePowerPolicy(devices) {
    if (!devicePowerManager || !Array.isArray(devices)) return;
    const serials = devices
        .filter((device) => device?.serial && device.connected !== false)
        .map((device) => device.serial);
    if (!serials.length) return;
    void devicePowerManager.syncConnectedDevices(serials);
}

function getConnectedDeviceIds() {
    return lastConnectedSerials.slice();
}

function rememberConnectedSerials(devices) {
    lastConnectedSerials = (Array.isArray(devices) ? devices : [])
        .filter((device) => device?.serial && device.connected !== false)
        .map((device) => device.serial);
}

function applyDeviceColorMetadata(devices) {
    if (!global.deviceColorsManager) return devices;
    const enriched = global.deviceColorsManager.applyDeviceColors(devices);
    rememberConnectedSerials(enriched);
    return enriched;
}

function buildLaunchHistoryKey(deviceId, packageName, userId = null) {
    const uid = Number.isInteger(userId) ? userId : 0;
    return `${String(deviceId || "")}::${String(packageName || "")}::${uid}`;
}

function getActiveTypeBHistoryKeys() {
    const keys = new Set();

    if (newInstanceManager) {
        for (const session of newInstanceManager.listNewInstanceSessions()) {
            if (session.serial && session.packageName) {
                keys.add(buildLaunchHistoryKey(session.serial, session.packageName, session.userId));
            }
        }
    }

    const bvm = global.browserViewManager;
    if (bvm) {
        for (const session of bvm.getAllSessions()) {
            if (session.type === "B" && session.deviceId && session.packageName) {
                keys.add(buildLaunchHistoryKey(session.deviceId, session.packageName, session.userId));
            }
        }
    }

    return keys;
}

function loadHistoryFromDisk() {
    if (!historyPath) return {};
    try {
        if (fs.existsSync(historyPath)) {
            const parsed = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
            if (global.wifiAdbService && migrateDeviceHistoryKeys(parsed, global.wifiAdbService)) {
                saveHistory(parsed);
            }
            return parsed;
        }
    } catch (e) {
        console.error("Erreur lecture historique:", e);
    }
    return {};
}

let deviceHistoryCache = null;
let deviceHistoryDirty = false;
let deviceHistoryFlushTimer = null;
const DEVICE_HISTORY_FLUSH_MS = 2000;

function loadHistory() {
    if (deviceHistoryCache === null) {
        deviceHistoryCache = loadHistoryFromDisk();
    }
    return deviceHistoryCache;
}

function saveHistory(history) {
    if (!historyPath) return;
    try {
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
    } catch (e) {
        console.error("Erreur écriture historique:", e);
    }
}

function flushDeviceHistoryNow() {
    if (deviceHistoryFlushTimer) {
        clearTimeout(deviceHistoryFlushTimer);
        deviceHistoryFlushTimer = null;
    }
    if (!deviceHistoryDirty || deviceHistoryCache === null) return;
    saveHistory(deviceHistoryCache);
    deviceHistoryDirty = false;
}

function scheduleDeviceHistoryFlush() {
    if (deviceHistoryFlushTimer) return;
    deviceHistoryFlushTimer = setTimeout(() => {
        deviceHistoryFlushTimer = null;
        flushDeviceHistoryNow();
    }, DEVICE_HISTORY_FLUSH_MS);
}

function updateDeviceInHistory(serial, name) {
    const history = loadHistory();
    history[serial] = { serial, name: name || serial, lastSeen: new Date().toISOString() };
    deviceHistoryDirty = true;
    scheduleDeviceHistoryFlush();
    return history;
}

function migrateDeviceHistoryKeys(history, wifiService) {
    if (!history || typeof history !== "object" || !wifiService) return false;

    let changed = false;
    for (const key of Object.keys({ ...history })) {
        const entry = history[key];
        if (!entry || typeof entry !== "object") continue;

        const wifiKey = wifiService.isWifiSerial(key)
            ? key
            : (wifiService.isWifiSerial(entry.serial) ? entry.serial : null);

        if (!wifiKey) continue;

        const config = wifiService.findConfigByWifiSerial(wifiKey);
        const targetId = config?.deviceId || entry.deviceId;
        if (!targetId || targetId === wifiKey) {
            delete history[key];
            changed = true;
            continue;
        }

        const existing = history[targetId] || {};
        history[targetId] = {
            deviceId: targetId,
            name: existing.name || entry.name || targetId,
            usbSerial: existing.usbSerial || config?.usbSerialHint || null,
            wifiSerial: wifiKey,
            serial: existing.usbSerial || config?.usbSerialHint || targetId,
            lastSeen: entry.lastSeen || existing.lastSeen,
            lastUsbSeen: existing.lastUsbSeen || null,
            lastWifiSeen: entry.lastSeen || existing.lastWifiSeen
        };

        if (key !== targetId) {
            delete history[key];
            changed = true;
        }
    }

    return changed;
}

function updateDevicesInHistory(devices) {
    if (!Array.isArray(devices) || devices.length === 0) {
        return loadHistory();
    }

    const history = loadHistory();
    const now = new Date().toISOString();
    const wifiService = global.wifiAdbService;

    for (const device of devices) {
        if (!device?.serial && !device?.deviceId) continue;

        const deviceId = device.deviceId || device.serial;
        const isWifiSerial = wifiService?.isWifiSerial?.(device.serial);
        const existing = history[deviceId] || {};

        const usbSerial = device.usbSerial
            || existing.usbSerial
            || (!isWifiSerial ? device.serial : null);
        const wifiSerial = device.wifiSerial
            || existing.wifiSerial
            || (isWifiSerial ? device.serial : null);

        history[deviceId] = {
            deviceId,
            name: device.name || existing.name || deviceId,
            usbSerial,
            wifiSerial,
            serial: usbSerial || deviceId,
            lastSeen: now,
            lastUsbSeen: usbSerial && rawUsbOnline(device, isWifiSerial) ? now : existing.lastUsbSeen,
            lastWifiSeen: wifiSerial || isWifiSerial ? now : existing.lastWifiSeen
        };

        if (wifiSerial && history[wifiSerial]) {
            delete history[wifiSerial];
        }
    }

    if (wifiService) {
        migrateDeviceHistoryKeys(history, wifiService);
    }

    deviceHistoryDirty = true;
    scheduleDeviceHistoryFlush();
    return history;
}

function rawUsbOnline(device, isWifiSerial) {
    if (isWifiSerial) return false;
    return Boolean(device.usbSerial || device.serial);
}

function getConnectedDevices() {
    return new Promise((resolve) => {
        exec(`"${adbPath}" devices -l`, { windowsHide: true }, (error, stdout) => {
            if (error) { console.error(error); resolve([]); return; }
            const lines = stdout.split(/\r?\n/).slice(1).filter(l => l.trim() !== "");
            const devices = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                const serial = parts[0];
                const state = parts[1];
                let status = "orange";
                if (state === "device") status = "green";
                else if (state === "offline" || state === "unauthorized") status = "red";
                const modelMatch = line.match(/model:(\S+)/);
                const name = modelMatch ? modelMatch[1].replace(/_/g, " ") : serial;
                return { serial, status, name, connected: state === "device" };
            });
            resolve(devices);
        });
    });
}

function getConnectedDevicesSimple() {
    return new Promise((resolve) => {
        exec(`"${adbPath}" devices`, { windowsHide: true }, (error, stdout) => {
            if (error) { resolve([]); return; }
            const lines = stdout.split(/\r?\n/).slice(1).filter(l => l.trim() !== "");
            const devices = lines.map((line) => {
                const parts = line.trim().split(/\s+/);
                const serial = parts[0];
                const state = parts[1] || "unknown";
                let status = "orange";
                if (state === "device") status = "green";
                else if (state === "offline" || state === "unauthorized") status = "red";
                return { serial, status, name: serial, connected: state === "device" };
            });
            resolve(devices);
        });
    });
}

// --- Flux vidéo natif (socket scrcpy-server + WebCodecs côté renderer) ---

const videoClients = {}; // { tabId: ScrcpySocketClient }
const inputControllersBySession = {}; // { sessionId: AdbInputController }
const inputDeviceMetaBySession = {}; // { sessionId: { streamWidth, streamHeight } }
const scrcpyClientsBySerial = {}; // { serial: ScrcpySocketClient } — legacy, éviter pour l'input
const externalLaunches = {}; // { launchId: { child, serial, packageName, userId, displayId, handedOff } }

function handoffExternalScrcpyLaunch(launchId) {
    const launch = externalLaunches[launchId];
    if (!launch || launch.handedOff) return;
    launch.handedOff = true;
    console.log(`[NewInstance] Session Hub active — lancement externe ${launchId} repris (pas de force-stop a la sortie scrcpy)`);
}

global.handoffExternalScrcpyLaunch = handoffExternalScrcpyLaunch;
const externalScrcpyWindows = {}; // { tabId: { child, displayId, displayReadyPromise } }
const pendingRendererRestarts = new Map();

function waitForRendererRestart(mainWindow, payload, timeoutMs = 45000) {
    return new Promise((resolve) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            resolve({ success: false, error: "Fenêtre principale indisponible" });
            return;
        }

        const requestId = `${payload.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
            pendingRendererRestarts.delete(requestId);
            resolve({ success: false, error: "Délai dépassé lors du redémarrage du flux" });
        }, timeoutMs);

        pendingRendererRestarts.set(requestId, (result) => {
            clearTimeout(timer);
            resolve(result);
        });

        mainWindow.webContents.send("session:restart-stream-request", {
            ...payload,
            requestId
        });
    });
}

function buildExternalScrcpyArgs(baseArgs) {
    const manager = global.globalAudioOutputManager;
    if (manager && typeof manager.applyScrcpyCliArgs === "function") {
        return manager.applyScrcpyCliArgs(baseArgs);
    }
    return baseArgs;
}

/** scrcpy.exe externe Type B : display uniquement, audio via socket Hub. */
function buildDisplayBootstrapScrcpyArgs(baseArgs) {
    const manager = global.globalAudioOutputManager;
    if (manager && typeof manager.applyDisplayBootstrapScrcpyArgs === "function") {
        return manager.applyDisplayBootstrapScrcpyArgs(baseArgs);
    }
    const next = baseArgs.filter((arg) => arg !== "--no-audio" && arg !== "--no-playback");
    next.push("--no-audio", "--no-playback");
    return next;
}

function buildNewInstanceExternalBaseArgs(serial, packageName, userId) {
    const normalizedUserId = Number.isInteger(userId) ? userId : null;
    const args = [
        "--serial", serial,
        "--new-display=1920x1080",
        "--turn-screen-off",
        "--stay-awake",
        "--no-window",
        "--record=NUL",
        "--record-format=mkv"
    ];
    if (normalizedUserId === null && packageName) {
        args.splice(3, 0, `--start-app=${packageName}`);
    }
    return args;
}

function buildExternalScrcpyBaseArgsForDisplayId(serial, displayId) {
    return [
        "--serial", serial,
        `--display-id=${displayId}`,
        "--turn-screen-off",
        "--stay-awake",
        "--no-window",
        "--record=NUL",
        "--record-format=mkv"
    ];
}

function waitForChildExit(child, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!child || child.killed || child.exitCode !== null) {
            resolve();
            return;
        }

        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        child.once("exit", done);
        child.once("error", done);
    });
}

function handleExternalLaunchChildExit(launchId, child) {
    const launch = externalLaunches[launchId];
    if (!launch || launch.child !== child) return;

    if (launch.restartingForAudio) {
        return;
    }

    if (launch.handedOff || launch.awaitingHub || newInstanceManager?.isExternalLaunchOwned(launchId)) {
        console.log(`[NewInstance] scrcpy externe termine (${launchId}) — session Hub active, conservation de l'app`);
        delete externalLaunches[launchId];
        return;
    }

    if (launch.packageName && launch.serial && newInstanceManager) {
        void newInstanceManager.forceStopAppOnDevice({
            serial: launch.serial,
            packageName: launch.packageName,
            userId: launch.userId,
            sessionId: launchId
        });
    }
    delete externalLaunches[launchId];
}

function spawnExternalLaunchChild(launchId, baseArgs) {
    const args = buildDisplayBootstrapScrcpyArgs(baseArgs);
    const child = spawnHiddenProcess(scrcpyBinaryPath, args, {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"]
    });

    child.stderr.on("data", (data) => {
        const trimmed = data.toString().trim();
        if (trimmed) console.error(`[NewInstance scrcpy ${launchId}] ${trimmed}`);
    });

    child.on("exit", () => handleExternalLaunchChildExit(launchId, child));

    return child;
}

async function restartExternalScrcpyLaunchForAudio(launchId) {
    const launch = externalLaunches[launchId];
    if (!launch?.serial) return;

    const previousChild = launch.child;
    launch.restartingForAudio = true;

    if (previousChild && !previousChild.killed) {
        try {
            previousChild.kill("SIGTERM");
        } catch (_) {
            /* ignore */
        }
        await waitForChildExit(previousChild);
    }

    const baseArgs = Number.isInteger(launch.displayId)
        ? buildExternalScrcpyBaseArgsForDisplayId(launch.serial, launch.displayId)
        : (launch.baseArgs || buildNewInstanceExternalBaseArgs(launch.serial, launch.packageName, launch.userId));

    const child = spawnExternalLaunchChild(launchId, baseArgs);
    launch.child = child;
    launch.restartingForAudio = false;

    const audioState = global.globalAudioOutputManager?.isGlobalMuted() ? "off" : "on";
    console.log(`[GlobalAudio] scrcpy externe relancé (${launchId}) audio=${audioState} display=${launch.displayId ?? "?"}`);
}

async function restartAllExternalScrcpyLaunchesForAudio() {
    const launchIds = Object.keys(externalLaunches).filter((launchId) => {
        const launch = externalLaunches[launchId];
        return launch?.child && !launch.child.killed;
    });

    await Promise.allSettled(launchIds.map((launchId) => restartExternalScrcpyLaunchForAudio(launchId)));
}

function resolveHubSocketAudioEnabled(_options = {}) {
    // Audio PC via scrcpy.exe dedie (--no-video). Le socket Hub = video seule.
    return false;
}

async function startSessionAudioPlayback(sessionId, { serial, displayId = null } = {}) {
    if (!sessionId || !serial || !global.sessionAudioProcessManager) return;
    if (global.globalAudioOutputManager?.isGlobalMuted?.()) return;

    try {
        await global.sessionAudioProcessManager.start(sessionId, { serial, displayId });
    } catch (err) {
        console.warn(`[SessionAudio ${sessionId}] demarrage:`, err?.message || err);
    }
}

async function stopSessionAudioPlayback(sessionId) {
    if (!sessionId || !global.sessionAudioProcessManager) return;
    try {
        await global.sessionAudioProcessManager.stop(sessionId);
    } catch (err) {
        console.warn(`[SessionAudio ${sessionId}] arret:`, err?.message || err);
    }
}

global.startSessionAudioPlayback = startSessionAudioPlayback;
global.stopSessionAudioPlayback = stopSessionAudioPlayback;

async function applyGlobalAudioMuteSideEffects(globalMuted) {
    const audioState = globalMuted ? "off" : "on";
    console.log(`[GlobalAudio] Toggle → audio=${audioState}, refresh sessions actives`);

    if (global.streamParamsManager) {
        await global.streamParamsManager.refreshAllSessionsForGlobalAudio();
    }

    if (!global.sessionAudioProcessManager) return;

    if (globalMuted) {
        await global.sessionAudioProcessManager.stopAll();
        return;
    }

    await global.sessionAudioProcessManager.syncAllActiveSessions();
}

function launchCompanionScrcpyWindow(serial, packageName, options = {}) {
    if (!fs.existsSync(scrcpyBinaryPath)) {
        throw new Error(`scrcpy introuvable: ${scrcpyBinaryPath}`);
    }

    const args = buildExternalScrcpyArgs(["--serial", serial]);

    if (options.newDisplay) {
        args.push(`--new-display=${options.newDisplay}`);
    }

    if (options.startApp || packageName) {
        args.push(`--start-app=${options.startApp || packageName}`);
    }

    const child = spawnHiddenProcess(scrcpyBinaryPath, args, {
        detached: false,
        stdio: ["ignore", "ignore", "pipe"]
    });
    let displayId = null;
    let resolveDisplayReady;
    const displayReadyPromise = new Promise((resolve) => {
        resolveDisplayReady = resolve;
    });

    const displayTimeout = setTimeout(() => {
        resolveDisplayReady(null);
    }, 4000);

    let stderrRemainder = "";
    const parseForDisplayId = (text) => {
        const match = text.match(/New display:.*\(id=(\d+)\)/i);
        if (!match) return;

        const parsed = Number(match[1]);
        if (!Number.isInteger(parsed)) return;

        displayId = parsed;
        clearTimeout(displayTimeout);
        resolveDisplayReady(parsed);
    };

    child.stderr.on("data", (data) => {
        const raw = data.toString();
        stderrRemainder += raw;

        const lines = stderrRemainder.split(/\r?\n/);
        stderrRemainder = lines.pop() || "";

        for (const line of lines) {
            const text = line.trim();
            if (!text) continue;
            console.error(`[Companion scrcpy ${serial}] ${text}`);
            parseForDisplayId(text);
        }
    });

    child.on("exit", () => {
        clearTimeout(displayTimeout);
        resolveDisplayReady(displayId);
    });

    return {
        child,
        getDisplayId: () => displayId,
        displayReadyPromise
    };
}

function notifyNewInstanceDisplayReady(launchId, serial, packageName, displayId, userId = null) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("new-instance:display-ready", {
        launchId,
        serial,
        packageName,
        displayId,
        userId
    });
}

app.whenReady().then(() => {
    historyPath = path.join(app.getPath("userData"), "device-history.json");
    global.customNamesManager = new CustomNamesManager(app.getPath("userData"));
    global.deviceColorsManager = new DeviceColorsManager(app.getPath("userData"));
    deviceManager = new DeviceManager(adbPath);
    wifiDevicesManager = new WifiDevicesManager(app.getPath("userData"));
    global.wifiDevicesManager = wifiDevicesManager;
    wifiAdbService = new WifiAdbService(adbPath, wifiDevicesManager);
    global.wifiAdbService = wifiAdbService;
    deviceRegistry = new DeviceRegistry({
        deviceManager,
        wifiDevicesManager,
        wifiAdbService,
        getConnectedDevicesFallback: getConnectedDevices,
        getConnectedDevicesSimpleFallback: getConnectedDevicesSimple
    });
    global.deviceRegistry = deviceRegistry;
    deviceHistoryCache = null;
    const historyOnInit = loadHistory();
    if (migrateDeviceHistoryKeys(historyOnInit, wifiAdbService)) {
        deviceHistoryDirty = true;
        flushDeviceHistoryNow();
    }
    wifiStartupPromise = deviceRegistry.startupAutoConnect().catch((err) => {
        console.warn("[DeviceRegistry] startupAutoConnect:", err?.message || err);
    }).finally(() => {
        requestRendererDeviceRefresh();
    });
    devicePowerManager = new DevicePowerManager(adbPath);
    global.devicePowerManager = devicePowerManager;
    deviceOrientationManager = new DeviceOrientationManager(adbPath);
    global.deviceOrientationManager = deviceOrientationManager;
    appMetadataManager = new AppMetadataManager(app.getPath("userData"), adbPath, {
        notifyUpdate: ({ serial, updates }) => {
            if (!win || win.isDestroyed()) return;
            win.webContents.send("app-metadata:updated", { serial, updates });
        }
    });
    global.appMetadataManager = appMetadataManager;
    attachAppMetadataPrefetch(deviceManager, appMetadataManager);
    newInstanceManager = new NewInstanceManager({
        adbPath,
        serverJarPath,
        scrcpyBinaryPath,
        launchPackageOnDisplay,
        onStreamMeta: (serial, meta, sessionId) => {
            if (!sessionId) return;
            inputDeviceMetaBySession[sessionId] = {
                streamWidth: meta.width,
                streamHeight: meta.height
            };
            const controller = inputControllersBySession[sessionId];
            if (controller && typeof controller.setStreamSize === "function") {
                controller.setStreamSize(meta.width, meta.height);
            }
        }
    });

    launchHistoryManager = new LaunchHistoryManager(app.getPath("userData"), {
        getActiveTypeBKeys: getActiveTypeBHistoryKeys
    });
    global.launchHistoryManager = launchHistoryManager;
    global.globalAudioOutputManager = new GlobalAudioOutputManager();
    global.sessionAudioProcessManager = new SessionAudioProcessManager(scrcpyBinaryPath);
    global.sessionAudioProcessManager.setResolvers({
        getBrowserViewManager: () => global.browserViewManager,
        getNewInstanceManager: () => newInstanceManager
    });
    global.globalAudioOutputManager.setOnMuteStateChanged(async (globalMuted) => {
        await applyGlobalAudioMuteSideEffects(globalMuted);
    });
    registerAudioHandlers(() => win, global.globalAudioOutputManager);

    registerNewInstanceIpc({
        ipcMain,
        manager: newInstanceManager,
        getWindow: () => win
    });

    // --- IPC Handlers ---

function requestRendererDeviceRefresh() {
    if (win && !win.isDestroyed()) {
        win.webContents.send("devices:refresh-request");
    }

    const hubModal = global.hubModalOverlayManager;
    const overlay = hubModal?.overlayWindow;
    if (
        overlay
        && !overlay.isDestroyed()
        && overlay.isVisible()
        && hubModal.getCurrentPanel?.() === "devices"
    ) {
        overlay.webContents.send("devices:refresh-request");
    }
}

async function listDevicesForUI() {
    if (wifiStartupPromise) {
        await wifiStartupPromise;
    }

    let connected = [];
    try {
        connected = await deviceRegistry.listUnifiedDevices();
    } catch (err) {
        console.error("[listDevicesForUI] registry error:", err.message);
        connected = [];
    }

    if (connected.length > 0 && deviceManager?.enrichDevicesWithStatus) {
        try {
            connected = await deviceManager.enrichDevicesWithStatus(connected);
        } catch (err) {
            console.warn("[listDevicesForUI] enrich status error:", err.message);
        }
    }

    const history = updateDevicesInHistory(connected);
    connected = global.customNamesManager.applyDeviceNames(connected);
    connected = applyDeviceColorMetadata(connected);
    syncDevicePowerPolicy(connected);

    const connectedKeys = new Set();
    for (const device of connected) {
        if (device?.deviceId) connectedKeys.add(device.deviceId);
        if (device?.serial) connectedKeys.add(device.serial);
    }

    const historicalOnly = Object.entries(history)
        .filter(([key, h]) => !connectedKeys.has(key) && !connectedKeys.has(h.serial))
        .map(([key, h]) => ({
            deviceId: key,
            serial: h.serial || key,
            name: h.name,
            status: "red",
            connected: false,
            lastSeen: h.lastSeen,
            transport: "none",
            transportLabel: "Hors ligne",
            wifiEnabled: false,
            wifiActive: false,
            wifiConfigured: false
        }));

    return [...connected, ...global.customNamesManager.applyDeviceNames(historicalOnly)];
}

    ipcMain.handle("get-devices", async () => {
        const devices = await listDevicesForUI();
        const connectedCount = devices.filter((d) => d.connected !== false).length;
        console.log(`[get-devices] connected count=${connectedCount}`);
        return devices;
    });

    ipcMain.handle("device:list", async () => listDevicesForUI());

    ipcMain.handle("get-apps", async (event, serial) => {
        try {
            const apps = await deviceManager.getInstalledApps(serial);
            return apps; // Retourne le tableau simple de strings
        } catch (err) {
            console.error("Erreur get-apps:", err.message);
            return []; // Retourne un tableau vide en cas d'erreur
        }
    });

    ipcMain.handle("device:apps", async (event, serial) => {
        try {
            if (!deviceManager) {
                return { success: false, error: "DeviceManager non initialise", apps: [] };
            }
            if (!serial) {
                return { success: false, error: "Serial appareil manquant", apps: [] };
            }

            console.log(`[device:apps] Demande pour ${serial}`);
            const apps = await deviceManager.getInstalledAppsWithDetails(serial);
            console.log(`[device:apps] ${apps.length} apps retournees`);
            return { success: true, apps };
        } catch (err) {
            console.error("[device:apps] Erreur:", err.message);
            return { success: false, error: err.message, apps: [] };
        }
    });

    ipcMain.handle("device:info", async (event, serial) => {
        try {
            const info = await deviceManager.getDeviceInfo(serial);
            return { success: true, info };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    function releaseSessionInputResources(sessionId) {
        if (!sessionId) return;
        delete inputControllersBySession[sessionId];
        delete inputDeviceMetaBySession[sessionId];
    }
    global.releaseSessionInputResources = releaseSessionInputResources;

    function resolveScrcpyClientForInput({ tabId, sessionId, deviceId }) {
        const routingId = tabId || sessionId;

        if (routingId && videoClients[routingId]) {
            return videoClients[routingId];
        }

        if (routingId && newInstanceManager) {
            const typeBSession = newInstanceManager.getNewInstanceSession(routingId);
            if (typeBSession?.client) return typeBSession.client;
        }

        // Ne jamais retomber sur le serial : plusieurs onglets peuvent partager le même appareil.
        return null;
    }

    async function getOrCreateSessionInputController(routingId, deviceId) {
        const existing = inputControllersBySession[routingId];
        if (existing) {
            if (existing.serial === deviceId) {
                return existing;
            }
            delete inputControllersBySession[routingId];
        }

        const controller = new AdbInputController(adbPath, deviceId);
        await controller.init();
        const meta = inputDeviceMetaBySession[routingId];
        if (meta) {
            controller.setStreamSize(meta.streamWidth, meta.streamHeight);
        }
        inputControllersBySession[routingId] = controller;
        return controller;
    }

    function resolveTypeBDisplayId(typeBSession) {
        if (!typeBSession) return null;
        if (Number.isInteger(typeBSession.displayId)) {
            return typeBSession.displayId;
        }
        const fromClient = typeBSession.client?.getNewDisplayId?.();
        if (Number.isInteger(fromClient)) {
            return fromClient;
        }
        if (Number.isInteger(typeBSession.presetDisplayId)) {
            return typeBSession.presetDisplayId;
        }
        return null;
    }

    async function sendTypeBInputViaHubAdb({
        routingId,
        resolvedDeviceId,
        displayId,
        typeBSession,
        type,
        action,
        x,
        y,
        key,
        streamWidth,
        streamHeight,
        isStreamPixel,
        x2,
        y2
    }) {
        let controller = inputControllersBySession[routingId];
        if (!controller || controller.serial !== resolvedDeviceId) {
            controller = await getOrCreateSessionInputController(routingId, resolvedDeviceId);
        }
        if (Number.isInteger(displayId)) {
            controller.setDisplayId(displayId);
        }
        if (streamWidth > 0 && streamHeight > 0) {
            controller.setStreamSize(streamWidth, streamHeight);
        } else if (typeBSession?.streamSize?.width > 0 && typeBSession?.streamSize?.height > 0) {
            controller.setStreamSize(typeBSession.streamSize.width, typeBSession.streamSize.height);
        } else {
            const meta = inputDeviceMetaBySession[routingId];
            if (meta?.streamWidth > 0 && meta?.streamHeight > 0) {
                controller.setStreamSize(meta.streamWidth, meta.streamHeight);
            }
        }
        if (type === "touch") {
            await controller.sendTouch(action === "tap" ? "tap" : action, x, y, isStreamPixel);
            return;
        }
        if (type === "scroll") {
            await controller.sendScroll(x, y, x2, y2, isStreamPixel);
            return;
        }
        if (type === "key") {
            await controller.sendKey(key);
            return;
        }
        throw new Error(`Type input hub ADB non supporte: ${type}`);
    }

    ipcMain.handle("send-input", async (event, payload) => {
        const {
            tabId,
            sessionId,
            deviceId,
            type,
            action,
            x,
            y,
            key,
            orientation,
            streamWidth,
            streamHeight,
            isStreamPixel
        } = payload;
        const routingId = tabId || sessionId;
        if (!routingId) {
            throw new Error("sessionId/tabId manquant pour send-input");
        }

        let resolvedDeviceId = deviceId;
        if (!resolvedDeviceId) {
            const entry = global.browserViewManager?.getSessionEntry(routingId);
            resolvedDeviceId = entry?.deviceId || null;
        }
        if (!resolvedDeviceId && newInstanceManager) {
            const typeBSession = newInstanceManager.getNewInstanceSession(routingId);
            resolvedDeviceId = typeBSession?.serial || null;
        }
        if (!resolvedDeviceId) {
            throw new Error("DeviceId manquant pour send-input");
        }

        const sessionEntry = global.browserViewManager?.getSessionEntry(routingId);
        const typeBSession = newInstanceManager?.getNewInstanceSession(routingId);
        const isTypeB = sessionEntry?.type === "B" || Boolean(typeBSession);

        if (isTypeB && newInstanceManager) {
            const displayId = resolveTypeBDisplayId(typeBSession);
            const preferHubAdbTouch = Number.isInteger(displayId) && (type === "touch" || type === "scroll");

            if (preferHubAdbTouch) {
                try {
                    await sendTypeBInputViaHubAdb({
                        routingId,
                        resolvedDeviceId,
                        displayId,
                        typeBSession,
                        type,
                        action,
                        x,
                        y,
                        key,
                        streamWidth,
                        streamHeight,
                        isStreamPixel,
                        x2: payload.x2,
                        y2: payload.y2
                    });
                    console.log(
                        `[Input] Type B ${routingId} path=hub-adb displayId=${displayId} type=${type}${action ? ` action=${action}` : ""}`
                    );
                    return { success: true };
                } catch (hubAdbErr) {
                    console.warn(
                        `[Input] Type B ${routingId} hub ADB ${type}, poursuite routeInputToSession:`,
                        hubAdbErr.message
                    );
                }
            }

            try {
                await newInstanceManager.routeInputToSession(routingId, {
                    type,
                    action,
                    x,
                    y,
                    key,
                    streamWidth,
                    streamHeight,
                    isStreamPixel
                });
                return { success: true };
            } catch (err) {
                console.warn(`[Input] Type B ${routingId}:`, err.message);
                if (Number.isInteger(displayId)) {
                    try {
                        await sendTypeBInputViaHubAdb({
                            routingId,
                            resolvedDeviceId,
                            displayId,
                            typeBSession,
                            type,
                            action,
                            x,
                            y,
                            key,
                            streamWidth,
                            streamHeight,
                            isStreamPixel,
                            x2: payload.x2,
                            y2: payload.y2
                        });
                        console.log(
                            `[Input] Type B ${routingId} path=hub-adb-fallback displayId=${displayId} type=${type}`
                        );
                        return { success: true };
                    } catch (fallbackErr) {
                        console.warn(`[Input] Type B ${routingId} fallback hub ADB:`, fallbackErr.message);
                    }
                }
                return { success: false, error: err.message };
            }
        }

        const isTypeA = sessionEntry?.type === "A";

        const logParts = [`[Input] device=${resolvedDeviceId}`, `session=${routingId}`];
        logParts.push(`type=${type}`);
        if (action) logParts.push(`action=${action}`);
        if (x !== undefined && y !== undefined) logParts.push(`x=${x} y=${y}`);
        if (payload.x2 !== undefined && payload.y2 !== undefined) logParts.push(`x2=${payload.x2} y2=${payload.y2}`);
        if (orientation) logParts.push(`orientation=${orientation}`);
        if (streamWidth && streamHeight) logParts.push(`stream=${streamWidth}x${streamHeight}`);
        if (key) logParts.push(`key=${key}`);
        console.log(logParts.join(" "));

        const scrcpyClient = resolveScrcpyClientForInput({ tabId, sessionId, deviceId: resolvedDeviceId });

        function resolveControlSize(client) {
            if (streamWidth > 0 && streamHeight > 0) {
                return { width: streamWidth, height: streamHeight };
            }
            const meta = inputDeviceMetaBySession[routingId];
            if (meta?.streamWidth > 0 && meta?.streamHeight > 0) {
                return { width: meta.streamWidth, height: meta.streamHeight };
            }
            const videoSize = client?.getVideoStreamSize?.();
            if (videoSize?.width > 0 && videoSize?.height > 0) {
                return videoSize;
            }
            const cachedController = inputControllersBySession[routingId];
            if (cachedController?.deviceWidth > 0 && cachedController?.deviceHeight > 0) {
                return { width: cachedController.deviceWidth, height: cachedController.deviceHeight };
            }
            return { width: 1920, height: 1080 };
        }

        const connState = scrcpyClient?.getConnectionState?.();
        const preferAdbTouch = Boolean(connState?.controlFromFallback && connState?.hasAudio);

        if (scrcpyClient?.controlSocket && !preferAdbTouch && (type === "touch" || type === "scroll")) {
            const controlSize = resolveControlSize(scrcpyClient);
            try {
                if (type === "touch") {
                    if (action === "tap") {
                        return scrcpyClient.sendTap(x, y, controlSize.width, controlSize.height);
                    }
                    if (action === "down") {
                        return scrcpyClient.sendTouchEvent(0, x, y, controlSize.width, controlSize.height);
                    }
                    if (action === "up") {
                        return scrcpyClient.sendTouchEvent(1, x, y, controlSize.width, controlSize.height);
                    }
                    if (action === "move") {
                        return scrcpyClient.sendTouchEvent(2, x, y, controlSize.width, controlSize.height);
                    }
                }

                if (type === "scroll") {
                    const x2 = payload.x2;
                    const y2 = payload.y2;
                    await scrcpyClient.sendTouchEvent(0, x, y, controlSize.width, controlSize.height);
                    await scrcpyClient.sendTouchEvent(2, x2, y2, controlSize.width, controlSize.height);
                    return scrcpyClient.sendTouchEvent(1, x2, y2, controlSize.width, controlSize.height);
                }
            } catch (err) {
                console.warn(`[Input] scrcpy ${type} echoue (${routingId}):`, err.message);
                if (isTypeA) {
                    throw err;
                }
            }
        }

        if (!scrcpyClient?.controlSocket && type === "touch") {
            console.warn(`[Input] Pas de socket controle scrcpy pour session=${routingId}`);
            if (isTypeA) {
                console.warn(`[Input] Type A ${routingId}: poursuite vers fallback ADB pour touch`);
            }
        }

        if (scrcpyClient?.controlSocket && type === "key") {
            try {
                if (key.length > 1) {
                    const keycode = KEYCODE_MAP[key] ?? Number(key);
                    if (Number.isFinite(keycode)) {
                        await scrcpyClient.sendKeyCode(0, keycode);
                        return scrcpyClient.sendKeyCode(1, keycode);
                    }
                }
            } catch (err) {
                console.warn(`[Input] scrcpy key echoue (${routingId}):`, err.message);
                if (isTypeA) {
                    throw err;
                }
            }
        }

        let controller = inputControllersBySession[routingId];
        if (!controller || controller.serial !== resolvedDeviceId) {
            controller = await getOrCreateSessionInputController(routingId, resolvedDeviceId);
        }

        if (orientation) {
            controller.setOrientation(orientation);
        }

        if (sessionEntry?.captureRotation !== undefined && typeof controller.setCaptureRotation === "function") {
            controller.setCaptureRotation(sessionEntry.captureRotation);
        }

        if (streamWidth && streamHeight) {
            controller.setStreamSize(streamWidth, streamHeight);
        }

        if (scrcpyClient?.controlSocket && type === "key") {
            try {
                if (key.length === 1) {
                    return controller.sendKey(key);
                }
            } catch (err) {
                console.warn(`[Input] scrcpy key echoue (${routingId}), fallback ADB:`, err.message);
            }
        }

        if (type === "touch") {
            return controller.sendTouch(action === "tap" ? "tap" : action, x, y, isStreamPixel);
        }

        if (type === "scroll") {
            return controller.sendScroll(x, y, payload.x2, payload.y2, isStreamPixel);
        }

        if (type === "key") {
            return controller.sendKey(key);
        }

        throw new Error(`Type d'entrée inconnu: ${type}`);
    });

    ipcMain.handle("new-instance:launch", async (event, { serial, packageName, userId = null }) => {
        if (!serial) {
            return { success: false, error: "Appareil non sélectionné" };
        }
        if (!packageName) {
            return { success: false, error: "Application non sélectionnée" };
        }
        if (!fs.existsSync(scrcpyBinaryPath)) {
            return { success: false, error: `scrcpy introuvable: ${scrcpyBinaryPath}` };
        }

        const normalizedUserId = Number.isInteger(userId) ? userId : null;
        const baseArgs = buildNewInstanceExternalBaseArgs(serial, packageName, normalizedUserId);
        const args = buildExternalScrcpyArgs(baseArgs);

        try {
            const launchId = `launch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const child = spawnHiddenProcess(scrcpyBinaryPath, args, {
                detached: false,
                stdio: ["ignore", "pipe", "pipe"]
            });

            externalLaunches[launchId] = {
                child,
                serial,
                packageName,
                userId: normalizedUserId,
                displayId: null,
                baseArgs,
                restartingForAudio: false
            };

            let resolved = false;
            let resultPayload = null;

            const finalize = (payload) => {
                if (resolved) return;
                resolved = true;
                resultPayload = payload;
                return payload;
            };

            const parseLine = (line) => {
                const text = String(line || "").trim();
                if (!text) return null;

                const match = text.match(/New display:.*\(id=(\d+)\)/i);
                if (!match) return null;

                const displayId = Number(match[1]);
                if (!Number.isInteger(displayId)) return null;

                externalLaunches[launchId].displayId = displayId;
                externalLaunches[launchId].awaitingHub = true;
                notifyNewInstanceDisplayReady(launchId, serial, packageName, displayId, normalizedUserId);

                if (normalizedUserId !== null) {
                    launchPackageOnDisplay(serial, packageName, displayId, { userId: normalizedUserId }).catch((err) => {
                        console.error(`[NewInstance] Erreur lancement app user=${normalizedUserId}:`, err.message);
                    });
                }

                return finalize({ success: true, launchId, displayId });
            };

            child.stdout.on("data", (data) => {
                const lines = data.toString().split(/\r?\n/);
                for (const line of lines) {
                    const payload = parseLine(line);
                    if (payload) {
                        child.unref();
                        return;
                    }
                }
            });

            child.stderr.on("data", (data) => {
                const text = data.toString();
                const trimmed = text.trim();
                if (trimmed) console.error(`[NewInstance scrcpy] ${trimmed}`);

                const lines = text.split(/\r?\n/);
                for (const line of lines) {
                    parseLine(line);
                }
            });

            child.on("exit", () => handleExternalLaunchChildExit(launchId, child));

            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve();
                }, 10000);

                const checkDone = () => {
                    if (resolved) {
                        clearTimeout(timer);
                        resolve();
                    }
                };

                child.on("error", (err) => {
                    clearTimeout(timer);
                    reject(err);
                });

                child.stdout.on("data", checkDone);
            });

            if (resolved && resultPayload) {
                console.log(`[NewInstance] scrcpy lancé pour ${serial} / ${packageName} / user=${normalizedUserId ?? "default"} (display=${externalLaunches[launchId].displayId})`);
                return resultPayload;
            }

            child.unref();

            if (normalizedUserId !== null) {
                launchPackageOnDisplay(serial, packageName, null, { userId: normalizedUserId }).catch((err) => {
                    console.error(`[NewInstance] Fallback lancement app user=${normalizedUserId}:`, err.message);
                });
            }

            console.log(`[NewInstance] scrcpy lancé pour ${serial} / ${packageName} / user=${normalizedUserId ?? "default"} (display inconnu)`);
            return { success: true, launchId, displayId: null };
        } catch (err) {
            console.error("[NewInstance] Erreur lancement scrcpy:", err.message);
            return { success: false, error: err.message };
        }
    });

    async function startVideoStreamLogic(serial, tabId, packageName, options = {}, runtime = {}) {
        if (!options.captureOrientationLock) {
            let dims = null;
            for (const ctrl of Object.values(inputControllersBySession)) {
                if (ctrl.serial === serial && ctrl.deviceWidth > 0 && ctrl.deviceHeight > 0) {
                    dims = { width: ctrl.deviceWidth, height: ctrl.deviceHeight };
                    break;
                }
            }
            const orientation = options.orientation || getOrientationFromScrcpyOptions(options);
            applyCaptureOrientationToOptions(options, orientation, dims?.width, dims?.height);
        }

        if (videoClients[tabId]) {
            if (runtime.force) {
                try {
                    videoClients[tabId].stop();
                } catch (_err) {
                    // noop
                }
                delete videoClients[tabId];
                if (scrcpyClientsBySerial[serial]) {
                    delete scrcpyClientsBySerial[serial];
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
                return { success: false, error: "Stream déjà actif pour cet onglet" };
            }
        }

        function waitForFirstPacket(client, timeoutMs = 5000) {
            return new Promise((resolve) => {
                let done = false;

                const finish = (ok) => {
                    if (done) return;
                    done = true;
                    client.removeListener("raw-packet", onPacket);
                    clearTimeout(timer);
                    resolve(ok);
                };

                const onPacket = () => finish(true);
                const timer = setTimeout(() => finish(false), timeoutMs);

                client.once("raw-packet", onPacket);
            });
        }

        async function launchPackageOnDisplayIfNeeded(client, targetPackage) {
            if (!targetPackage) return;

            const userId = Number.isInteger(options.userId) ? options.userId : null;
            const userArg = userId !== null ? ` --user ${userId}` : "";
            const monkeyUserArg = userId !== null ? ` --user ${userId}` : "";

            const activity = await resolveLaunchActivity(serial, targetPackage, userId);
            if (!activity) {
                exec(`"${adbPath}" -s ${serial} shell monkey${monkeyUserArg} -p ${targetPackage} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err) => {
                    if (err) console.error(`Fallback lancement app ${targetPackage} (user=${userId ?? "default"}):`, err.message);
                });
                return;
            }

            const newDisplayId = typeof client.getNewDisplayId === "function" ? client.getNewDisplayId() : null;
            const launchCandidates = [];
            if (Number.isInteger(newDisplayId)) {
                launchCandidates.push(
                    options.backgroundLaunch
                        ? `"${adbPath}" -s ${serial} shell am start${userArg} --display ${newDisplayId} --activity-task-on-home -n ${activity}`
                        : `"${adbPath}" -s ${serial} shell am start${userArg} --display ${newDisplayId} -n ${activity}`
                );
            }
            launchCandidates.push(
                options.backgroundLaunch
                    ? `"${adbPath}" -s ${serial} shell am start${userArg} --activity-task-on-home -n ${activity}`
                    : `"${adbPath}" -s ${serial} shell am start${userArg} -n ${activity}`
            );
            launchCandidates.push(`"${adbPath}" -s ${serial} shell am start${userArg} -n ${activity}`);

            (async () => {
                let launched = false;
                for (const launchCmd of launchCandidates) {
                    try {
                        await execPromise(launchCmd);
                        launched = true;
                        break;
                    } catch (err) {
                        console.warn(`Échec commande lancement app (${targetPackage}): ${launchCmd} -> ${err.message}`);
                    }
                }

                if (!launched) {
                    exec(`"${adbPath}" -s ${serial} shell monkey${monkeyUserArg} -p ${targetPackage} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err2) => {
                        if (err2) console.error(`Fallback lancement app ${targetPackage} (user=${userId ?? "default"}):`, err2.message);
                    });
                    return;
                }

                if (options.backgroundLaunch) {
                    exec(`"${adbPath}" -s ${serial} shell input keyevent 3`, { windowsHide: true }, (err3) => {
                        if (err3) console.error(`Erreur mise de l'app en arrière-plan:`, err3.message);
                    });
                }
            })();
        }

        function registerClientEvents(scrcpyClient) {
            let firstPacketSent = false;

            scrcpyClient.on("connected", () => {
                if (win && !win.isDestroyed()) {
                    win.webContents.send("video-stream-state", {
                        tabId,
                        stage: "adb-socket-connected"
                    });
                }
            });

            scrcpyClient.on("codec-meta", (meta) => {
                if (win && !win.isDestroyed()) {
                    const payload = { tabId, ...meta };
                    forwardTypeAVideoEvent(tabId, "video-codec-meta", payload);
                    win.webContents.send("video-stream-state", {
                        tabId,
                        stage: "codec-meta"
                    });
                }
                inputDeviceMetaBySession[tabId] = {
                    streamWidth: meta.width,
                    streamHeight: meta.height
                };
                const controller = inputControllersBySession[tabId];
                if (controller && typeof controller.setStreamSize === "function") {
                    controller.setStreamSize(meta.width, meta.height);
                }
            });

            scrcpyClient.on("raw-packet", (packet) => {
                if (win && !win.isDestroyed()) {
                    try {
                        if (!firstPacketSent) {
                            firstPacketSent = true;
                            win.webContents.send("video-stream-state", {
                                tabId,
                                stage: "h264-first-packet"
                            });
                        }
                        const packetPayload = {
                            tabId,
                            pts: packet.pts.toString(),
                            isConfig: packet.isConfig,
                            isKeyFrame: packet.isKeyFrame,
                            data: packet.data
                        };
                        forwardTypeAVideoEvent(tabId, "video-packet", packetPayload);
                    } catch (err) {
                        console.error("❌ ERREUR ENVOI IPC PACKET:", err.message);
                    }
                }
            });

            scrcpyClient.on("audio-codec-meta", (meta) => {
                if (win && !win.isDestroyed()) {
                    forwardSessionAudioEvent(() => win, "audio-codec-meta", { tabId, ...meta });
                }
            });

            scrcpyClient.on("raw-audio-packet", (packet) => {
                if (win && !win.isDestroyed()) {
                    try {
                        forwardSessionAudioEvent(() => win, "audio-packet", {
                            tabId,
                            pts: packet.pts.toString(),
                            isConfig: packet.isConfig,
                            isKeyFrame: packet.isKeyFrame,
                            data: packet.data
                        });
                    } catch (err) {
                        console.error("❌ ERREUR ENVOI IPC AUDIO:", err.message);
                    }
                }
            });

            scrcpyClient.on("error", (err) => {
                console.error(`[Video] Erreur pour ${tabId}:`, err.message);
                if (win && !win.isDestroyed()) {
                    const errorPayload = { tabId, error: err.message };
                    forwardTypeAVideoEvent(tabId, "video-error", errorPayload);
                }
                delete videoClients[tabId];
            });

            scrcpyClient.on("closed", () => {
                delete videoClients[tabId];
                if (scrcpyClientsBySerial[serial] === scrcpyClient) {
                    delete scrcpyClientsBySerial[serial];
                }
            });
        }

        let client = new ScrcpySocketClient(adbPath, serial);
        videoClients[tabId] = client;
        registerClientEvents(client);

        try {
            const primaryOptions = {
                ...options,
                audio: resolveHubSocketAudioEnabled(options)
            };

            if (options.disableAnimations) {
                exec(`"${adbPath}" -s ${serial} shell settings put global window_animation_scale 0.0 && settings put global transition_animation_scale 0.0 && settings put global animator_duration_scale 0.0`, { windowsHide: true }, (err) => {
                    if (err) console.error(`Erreur désactivation animations:`, err.message);
                });
            }

            try {
                await client.start(serverJarPath, primaryOptions);
            } catch (err) {
                const canRetryWithNewDisplay = Number.isInteger(options.displayId);
                if (!canRetryWithNewDisplay) {
                    throw err;
                }

                console.warn(`[Video] display_id=${options.displayId} indisponible pour ${tabId}, fallback en new_display.`);

                client.stop();
                delete videoClients[tabId];
                if (scrcpyClientsBySerial[serial] === client) {
                    delete scrcpyClientsBySerial[serial];
                }

                const retryClient = new ScrcpySocketClient(adbPath, serial);
                client = retryClient;
                videoClients[tabId] = retryClient;
                registerClientEvents(retryClient);

                const retryOptions = {
                    ...options,
                    audio: resolveHubSocketAudioEnabled(options),
                    newDisplay: options.newDisplay || "1920x1080"
                };
                delete retryOptions.displayId;
                delete retryOptions.startApp;

                await retryClient.start(serverJarPath, retryOptions);
            }
            scrcpyClientsBySerial[serial] = client;

            const launchTargetPackage = packageName || options.startApp;
            if (launchTargetPackage && !options.skipPackageLaunch) {
                await launchPackageOnDisplayIfNeeded(client, launchTargetPackage);
            }

            const hasPacket = await waitForFirstPacket(client, 5000);
            const fallbackNewDisplay = options.fallbackNewDisplay || options.newDisplay;
            const fallbackStartApp = options.fallbackStartApp || options.startApp || packageName;

            if (!hasPacket && fallbackNewDisplay) {
                console.warn(`[Video] Aucun paquet reçu sur ${tabId}, fallback en new_display ${fallbackNewDisplay}.`);

                client.stop();
                delete videoClients[tabId];
                if (scrcpyClientsBySerial[serial] === client) {
                    delete scrcpyClientsBySerial[serial];
                }

                const fallbackClient = new ScrcpySocketClient(adbPath, serial);
                videoClients[tabId] = fallbackClient;
                registerClientEvents(fallbackClient);

                const safeOptions = {
                    ...options,
                    audio: resolveHubSocketAudioEnabled(options),
                    newDisplay: fallbackNewDisplay,
                    skipPackageLaunch: false
                };
                delete safeOptions.displayId;
                delete safeOptions.fallbackNewDisplay;
                delete safeOptions.fallbackStartApp;
                delete safeOptions.startApp;

                await fallbackClient.start(serverJarPath, safeOptions);
                scrcpyClientsBySerial[serial] = fallbackClient;
                if (fallbackStartApp && !safeOptions.skipPackageLaunch) {
                    await launchPackageOnDisplayIfNeeded(fallbackClient, fallbackStartApp);
                }
            }

            return { success: true };
        } catch (err) {
            delete videoClients[tabId];
            return { success: false, error: err.message };
        }
    }

    ipcMain.handle("start-video-stream", async (event, { serial, tabId, packageName, options = {} }) => {
        let streamOptions = { ...options };
        const originalNewDisplay = options.newDisplay;
        const originalStartApp = options.startApp;

        if (options.openScrcpyWindow && !externalScrcpyWindows[tabId]) {
            try {
                const companion = launchCompanionScrcpyWindow(serial, packageName, options);
                externalScrcpyWindows[tabId] = companion;
                companion.child.on("exit", () => {
                    if (externalScrcpyWindows[tabId] === companion) {
                        delete externalScrcpyWindows[tabId];
                    }
                    if (packageName && newInstanceManager) {
                        void newInstanceManager.forceStopAppOnDevice({
                            serial,
                            packageName,
                            userId: Number.isInteger(options.userId) ? options.userId : null,
                            sessionId: tabId
                        });
                    }
                });
            } catch (err) {
                console.error(`[Companion scrcpy] Impossible de lancer la fenêtre pour ${tabId}:`, err.message);
            }
        }

        if (options.openScrcpyWindow && options.captureCompanionDisplay !== false) {
            const companion = externalScrcpyWindows[tabId];
            if (companion) {
                const displayId = await companion.displayReadyPromise;
                if (Number.isInteger(displayId)) {
                    streamOptions = {
                        ...streamOptions,
                        displayId,
                        skipPackageLaunch: true,
                        fallbackNewDisplay: originalNewDisplay || "1920x1080",
                        fallbackStartApp: originalStartApp || packageName
                    };
                    delete streamOptions.newDisplay;
                    delete streamOptions.startApp;
                }
            }
        }

        if (!streamOptions.fallbackNewDisplay && originalNewDisplay) {
            streamOptions.fallbackNewDisplay = originalNewDisplay;
        }
        if (!streamOptions.fallbackStartApp && (originalStartApp || packageName)) {
            streamOptions.fallbackStartApp = originalStartApp || packageName;
        }

        streamOptions.audio = resolveHubSocketAudioEnabled(streamOptions);

        const result = await startVideoStreamLogic(serial, tabId, packageName, streamOptions);

        if (result?.success && global.browserViewManager) {
            const entry = global.browserViewManager.getSessionEntry(tabId);
            if (entry) {
                const isFirst = !entry._streamInitialized;
                const params = fromScrcpyOptions(streamOptions, entry.type);
                global.browserViewManager.setSessionStreamParams(tabId, params, { asOriginal: isFirst });
                global.browserViewManager.setSessionScrcpyOptions(tabId, streamOptions);
                global.browserViewManager.setSessionCaptureOrientation(
                    tabId,
                    getOrientationFromScrcpyOptions(streamOptions),
                    { captureRotation: streamOptions.captureRotation || 0 }
                );

                if (global.sessionStreamRegistry) {
                    global.sessionStreamRegistry.syncFromBrowserViewEntry(tabId, entry);
                    global.sessionStreamRegistry.setScrcpyOptions(tabId, streamOptions, { asOriginal: isFirst });
                }
            }

            void startSessionAudioPlayback(tabId, { serial });
        }

        return result;
    });

    async function stopVideoStreamForTab(tabId) {
        const client = videoClients[tabId];
        if (client) {
            client.stop();
            delete videoClients[tabId];
            if (scrcpyClientsBySerial[client.serial] === client) {
                delete scrcpyClientsBySerial[client.serial];
            }
        }

        const companionWindow = externalScrcpyWindows[tabId];
        if (companionWindow?.child) {
            companionWindow.child.kill();
            delete externalScrcpyWindows[tabId];
        }

        releaseSessionInputResources(tabId);
        await stopSessionAudioPlayback(tabId);
        return { success: true };
    }

    ipcMain.handle("stop-video-stream", async (event, tabId) => stopVideoStreamForTab(tabId));

    // --- Layout (LayoutManager) IPC ---
    const { LayoutManager } = require("./managers/layout-manager");
    const layoutManager = new LayoutManager();

    ipcMain.handle("layout:set", async (event, layoutId) => {
        try {
            layoutManager.setActiveLayout(layoutId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("layout:list", async () => {
        return { success: true, layouts: layoutManager.listLayouts() };
    });

    ipcMain.handle("layout:create", async (event, mode, slots) => {
        try {
            const layout = layoutManager.createLayout(mode, slots);
            return { success: true, layout };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // --- Focus (FocusManager) IPC ---
    const { FocusManager } = require("./managers/focus-manager");
    const focusManager = new FocusManager();

    ipcMain.handle("focus:set", async (event, sessionId) => {
        try {
            focusManager.setFocus(sessionId);
            if (win && !win.isDestroyed()) {
                win.webContents.send("focus:changed", { sessionId });
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("focus:get", async () => {
        return { success: true, sessionId: focusManager.getFocus() };
    });

    // --- Handlers titlebar custom ---

    ipcMain.on("window-minimize", () => { win.minimize(); });
    ipcMain.on("window-maximize", () => {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    });
    ipcMain.on("window-close", () => { win.close(); });

    ipcMain.on("session:restart-stream-result", (_event, { requestId, success, error }) => {
        const resolve = pendingRendererRestarts.get(requestId);
        if (resolve) {
            pendingRendererRestarts.delete(requestId);
            resolve({ success: Boolean(success), error: error || null });
        }
    });

    createWindow();
    global.browserViewManager = new BrowserViewManager(win);
    global.videoPreviewTooltipManager = new VideoPreviewTooltipManager(win);
    global.renameDialogManager = new RenameDialogManager(win);
    global.hubModalOverlayManager = new HubModalOverlayManager(win);
    global.sessionStreamRegistry = new SessionStreamRegistry();

    registerHubModalHandlers(() => global.hubModalOverlayManager);

    global.streamParamsManager = new StreamParamsManager({
        getBrowserViewManager: () => global.browserViewManager,
        getNewInstanceManager: () => newInstanceManager,
        getRegistry: () => global.sessionStreamRegistry,
        getMainWindow: () => win,
        waitForRendererRestart: (payload, timeoutMs) => waitForRendererRestart(win, payload, timeoutMs),
        stopVideoStream: (tabId) => stopVideoStreamForTab(tabId),
        startVideoStream: (serial, tabId, packageName, options, runtime = {}) =>
            startVideoStreamLogic(serial, tabId, packageName, options, runtime),
        getVideoClient: (sessionId) => videoClients[sessionId] || null,
        getGlobalAudioOutputManager: () => global.globalAudioOutputManager,
        setInputControllerOrientation: (sessionId, orientation) => {
            const controller = inputControllersBySession[sessionId];
            const entry = global.browserViewManager?.getSessionEntry(sessionId);
            if (controller && typeof controller.setOrientation === "function") {
                controller.setOrientation(orientation);
            }
            if (controller && typeof controller.setCaptureRotation === "function") {
                controller.setCaptureRotation(entry?.captureRotation || 0);
            }
        },
        getDeviceDimensions: (serial) => {
            if (!serial) return null;
            for (const controller of Object.values(inputControllersBySession)) {
                if (controller.serial === serial && controller.deviceWidth > 0 && controller.deviceHeight > 0) {
                    return { width: controller.deviceWidth, height: controller.deviceHeight };
                }
            }
            return null;
        },
        applyPhysicalOrientation: (serial, orientation, deviceDims) =>
            deviceOrientationManager?.applyOrientation(serial, orientation, deviceDims)
                ?? Promise.resolve({ success: false, error: "Gestionnaire d'orientation indisponible" })
    });

    registerSessionHandlers(adbPath, {
        getVideoClient: (sessionId) => videoClients[sessionId] || null,
        getNewInstanceManager: () => newInstanceManager,
        stopVideoStream: (sessionId) => stopVideoStreamForTab(sessionId)
    });
    registerStreamParamsHandlers(global.streamParamsManager);
    setupBrowserViewVideoForwarding(newInstanceManager, () => win);
    registerVideoPreviewHandlers(() => global.videoPreviewTooltipManager);
    registerNamesHandlers({
        getCustomNamesManager: () => global.customNamesManager,
        getBrowserViewManager: () => global.browserViewManager,
        getMainWindow: () => win,
        getRenameDialogManager: () => global.renameDialogManager
    });
    registerContextMenuHandlers({
        getCustomNamesManager: () => global.customNamesManager,
        getBrowserViewManager: () => global.browserViewManager,
        getMainWindow: () => win,
        getRenameDialogManager: () => global.renameDialogManager,
        getDeviceColorsManager: () => global.deviceColorsManager,
        getConnectedDeviceIds
    });
    registerDeviceColorsHandlers({
        getDeviceColorsManager: () => global.deviceColorsManager,
        getMainWindow: () => win,
        getConnectedDeviceIds
    });
    registerLaunchHistoryHandlers({
        getLaunchHistoryManager: () => launchHistoryManager,
        getAppMetadataManager: () => appMetadataManager
    });
    registerAppMetadataHandlers({
        ipcMain,
        getAppMetadataManager: () => appMetadataManager,
        getWindow: () => win
    });
    registerUpdateHandlers(ipcMain);
    initAutoUpdater(win);

    registerWifiHandlers({
        ipcMain,
        getDeviceRegistry: () => deviceRegistry,
        getWifiAdbService: () => wifiAdbService,
        getWifiDevicesManager: () => wifiDevicesManager,
        getCustomNamesManager: () => global.customNamesManager,
        getMainWindow: () => win,
        loadHistory,
        refreshDeviceList: async () => {
            requestRendererDeviceRefresh();
        }
    });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    flushDeviceHistoryNow();
});