const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const { ScrcpySocketClient } = require("../native/scrcpy/scrcpy-socket");
const { AdbInputController } = require("../native/scrcpy/control/adb-input-controller");
const { NewInstanceManager } = require("./managers/new-instance-manager");
const { registerNewInstanceIpc } = require("./ipc/new-instance-ipc");

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

async function resolveLaunchActivity(serial, packageName) {
    try {
        const stdout = await execPromise(`"${adbPath}" -s ${serial} shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}`);
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
    const activity = await resolveLaunchActivity(serial, packageName);

    if (!activity) {
        exec(`"${adbPath}" -s ${serial} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err) => {
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
    launchCandidates.push(`"${adbPath}" -s ${serial} shell am start -n ${activity}`);

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
        exec(`"${adbPath}" -s ${serial} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err2) => {
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

function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        autoHideMenuBar: true,
        frame: false,
        backgroundColor: "#0a0e14",
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

const adbPath = path.join(__dirname, "..", "..", "tools", "adb.exe");
const serverJarPath = path.join(__dirname, "..", "..", "tools", "scrcpy-server");
const scrcpyBinaryPath = path.join(__dirname, "..", "..", "tools", "scrcpy.exe");
const { DeviceManager } = require("./managers/device-manager");

let historyPath;
let deviceManager;
let newInstanceManager;

function loadHistory() {
    if (!historyPath) return {};
    try {
        if (fs.existsSync(historyPath)) {
            return JSON.parse(fs.readFileSync(historyPath, "utf-8"));
        }
    } catch (e) {
        console.error("Erreur lecture historique:", e);
    }
    return {};
}

function saveHistory(history) {
    if (!historyPath) return;
    try {
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
    } catch (e) {
        console.error("Erreur écriture historique:", e);
    }
}

function updateDeviceInHistory(serial, name) {
    const history = loadHistory();
    history[serial] = { serial, name: name || serial, lastSeen: new Date().toISOString() };
    saveHistory(history);
    return history;
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
const inputControllers = {}; // { serial: AdbInputController }
const inputDeviceMeta = {}; // { serial: { streamWidth, streamHeight } }
const scrcpyClientsBySerial = {}; // { serial: ScrcpySocketClient }
const externalLaunches = {}; // { launchId: { child, serial, packageName, userId, displayId } }
const externalScrcpyWindows = {}; // { tabId: { child, displayId, displayReadyPromise } }

function launchCompanionScrcpyWindow(serial, packageName, options = {}) {
    if (!fs.existsSync(scrcpyBinaryPath)) {
        throw new Error(`scrcpy introuvable: ${scrcpyBinaryPath}`);
    }

    const args = ["--serial", serial];

    if (options.newDisplay) {
        args.push(`--new-display=${options.newDisplay}`);
    }

    if (options.startApp || packageName) {
        args.push(`--start-app=${options.startApp || packageName}`);
    }

    const child = spawn(scrcpyBinaryPath, args, {
        detached: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: false
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
    deviceManager = new DeviceManager(adbPath);
    newInstanceManager = new NewInstanceManager({
        adbPath,
        serverJarPath,
        scrcpyBinaryPath,
        launchPackageOnDisplay
    });

    registerNewInstanceIpc({
        ipcMain,
        manager: newInstanceManager,
        getWindow: () => win
    });

    // --- IPC Handlers ---

    ipcMain.handle("get-devices", async () => {
        let connected = [];
        try {
            connected = await deviceManager.getConnectedDevices();
        } catch (err) {
            console.error("[get-devices] DeviceManager error:", err.message);
        }

        if (!Array.isArray(connected) || connected.length === 0) {
            try {
                connected = await getConnectedDevices();
            } catch (err) {
                console.error("[get-devices] fallback adb error:", err.message);
                connected = [];
            }
        }

        if (!Array.isArray(connected) || connected.length === 0) {
            try {
                connected = await getConnectedDevicesSimple();
            } catch (err) {
                console.error("[get-devices] simple adb fallback error:", err.message);
                connected = [];
            }
        }

        console.log(`[get-devices] connected count=${connected.length}`);

        connected.forEach(d => updateDeviceInHistory(d.serial, d.name));
        const history = loadHistory();
        const connectedSerials = connected.map(d => d.serial);
        const historicalOnly = Object.values(history)
            .filter(h => !connectedSerials.includes(h.serial))
            .map(h => ({ serial: h.serial, name: h.name, status: "red", connected: false, lastSeen: h.lastSeen }));
        return [...connected, ...historicalOnly];
    });

    ipcMain.handle("device:list", async () => {
        let connected = [];
        try {
            connected = await deviceManager.getConnectedDevices();
        } catch (err) {
            console.error("[device:list] DeviceManager error:", err.message);
        }

        if (!Array.isArray(connected) || connected.length === 0) {
            try {
                connected = await getConnectedDevices();
            } catch (err) {
                console.error("[device:list] fallback adb error:", err.message);
                connected = [];
            }
        }

        if (!Array.isArray(connected) || connected.length === 0) {
            try {
                connected = await getConnectedDevicesSimple();
            } catch (err) {
                console.error("[device:list] simple adb fallback error:", err.message);
                connected = [];
            }
        }

        connected.forEach(d => updateDeviceInHistory(d.serial, d.name));
        const history = loadHistory();
        const connectedSerials = connected.map(d => d.serial);
        const historicalOnly = Object.values(history)
            .filter(h => !connectedSerials.includes(h.serial))
            .map(h => ({ serial: h.serial, name: h.name, status: "red", connected: false, lastSeen: h.lastSeen }));
        return [...connected, ...historicalOnly];
    });

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
            const apps = await deviceManager.getInstalledAppsWithDetails(serial);
            return { success: true, apps };
        } catch (err) {
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

    ipcMain.handle("send-input", async (event, payload) => {
        const { deviceId, type, action, x, y, key, orientation, streamWidth, streamHeight, isStreamPixel } = payload;
        if (!deviceId) {
            throw new Error("DeviceId manquant pour send-input");
        }

        let controller = inputControllers[deviceId];
        if (!controller) {
            controller = new AdbInputController(adbPath, deviceId);
            await controller.init();
            const meta = inputDeviceMeta[deviceId];
            if (meta) {
                controller.setStreamSize(meta.streamWidth, meta.streamHeight);
            }
            inputControllers[deviceId] = controller;
        }

        if (orientation) {
            controller.setOrientation(orientation);
        }

        if (streamWidth && streamHeight) {
            controller.setStreamSize(streamWidth, streamHeight);
        }

        const logParts = [`[Input] device=${deviceId}`, `type=${type}`];
        if (action) logParts.push(`action=${action}`);
        if (x !== undefined && y !== undefined) logParts.push(`x=${x} y=${y}`);
        if (payload.x2 !== undefined && payload.y2 !== undefined) logParts.push(`x2=${payload.x2} y2=${payload.y2}`);
        if (orientation) logParts.push(`orientation=${orientation}`);
        if (streamWidth && streamHeight) logParts.push(`stream=${streamWidth}x${streamHeight}`);
        if (key) logParts.push(`key=${key}`);
        console.log(logParts.join(" "));

        function getControlSize() {
            if (streamWidth && streamHeight) {
                return { width: streamWidth, height: streamHeight };
            }
            const meta = inputDeviceMeta[deviceId];
            if (meta && meta.streamWidth && meta.streamHeight) {
                return { width: meta.streamWidth, height: meta.streamHeight };
            }
            return { width: 0, height: 0 };
        }

        // Cherche d'abord dans les clients de session classique
        let scrcpyClient = scrcpyClientsBySerial[deviceId];
        
        // Si pas trouvé, cherche dans les sessions new-instance
        if (!scrcpyClient || !scrcpyClient.controlSocket) {
            const newInstSessions = newInstanceManager.listNewInstanceSessions();
            for (const s of newInstSessions) {
                const session = newInstanceManager.getNewInstanceSession(s.sessionId);
                if (session && session.serial === deviceId && session.client && session.client.controlSocket) {
                    scrcpyClient = session.client;
                    break;
                }
            }
        }

        if (scrcpyClient && scrcpyClient.controlSocket) {
            const controlSize = getControlSize();

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

            if (type === "key") {
                return controller.sendKey(key);
            }
        }

        if (type === "touch") {
            return controller.sendTouch(action, x, y, isStreamPixel);
        }

        if (type === "scroll") {
            return controller.sendScroll(x, y, payload.x2, payload.y2, isStreamPixel);
        }

        if (type === "key") {
            return controller.sendKey(key);
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

        const args = [
            "--serial", serial,
            "--new-display=1920x1080",
            "--no-window",
            "--record=NUL",
            "--record-format=mkv"
        ];

        // Si un profil est ciblé, on lance l'app explicitement via adb avec --user.
        if (normalizedUserId === null) {
            args.splice(3, 0, `--start-app=${packageName}`);
        }

        try {
            const launchId = `launch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const child = spawn(scrcpyBinaryPath, args, {
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true
            });

            externalLaunches[launchId] = {
                child,
                serial,
                packageName,
                userId: normalizedUserId,
                displayId: null
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

            child.on("exit", () => {
                delete externalLaunches[launchId];
            });

            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    resolve();
                }, 3500);

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

    async function startVideoStreamLogic(serial, tabId, packageName, options = {}) {
        if (videoClients[tabId]) {
            return { success: false, error: "Stream déjà actif pour cet onglet" };
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

            const activity = await resolveLaunchActivity(serial, targetPackage);
            if (!activity) {
                exec(`"${adbPath}" -s ${serial} shell monkey -p ${targetPackage} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err) => {
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
            launchCandidates.push(`"${adbPath}" -s ${serial} shell am start -n ${activity}`);

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
                    exec(`"${adbPath}" -s ${serial} shell monkey -p ${targetPackage} -c android.intent.category.LAUNCHER 1`, { windowsHide: true }, (err2) => {
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
                    win.webContents.send("video-codec-meta", { tabId, ...meta });
                    win.webContents.send("video-stream-state", {
                        tabId,
                        stage: "codec-meta"
                    });
                }
                inputDeviceMeta[serial] = {
                    streamWidth: meta.width,
                    streamHeight: meta.height
                };
                const controller = inputControllers[serial];
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
                        win.webContents.send("video-packet", {
                            tabId,
                            pts: packet.pts.toString(),
                            isConfig: packet.isConfig,
                            isKeyFrame: packet.isKeyFrame,
                            data: packet.data
                        });
                    } catch (err) {
                        console.error("❌ ERREUR ENVOI IPC PACKET:", err.message);
                    }
                }
            });

            scrcpyClient.on("error", (err) => {
                console.error(`[Video] Erreur pour ${tabId}:`, err.message);
                if (win && !win.isDestroyed()) {
                    win.webContents.send("video-error", { tabId, error: err.message });
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
                ...options
            };

            if (options.disableAnimations) {
                exec(`"${adbPath}" -s ${serial} shell settings put global window_animation_scale 0.0 && settings put global transition_animation_scale 0.0 && settings put global animator_duration_scale 0.0`, { windowsHide: true }, (err) => {
                    if (err) console.error(`Erreur désactivation animations:`, err.message);
                });
            }

            if (options.screenOff) {
                exec(`"${adbPath}" -s ${serial} shell input keyevent 26`, { windowsHide: true }, (err) => {
                    if (err) console.error(`Erreur mise écran en veille:`, err.message);
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

        const result = await startVideoStreamLogic(serial, tabId, packageName, streamOptions);

        return result;
    });

    ipcMain.handle("stop-video-stream", async (event, tabId) => {
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

        return { success: true };
    });

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

    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});