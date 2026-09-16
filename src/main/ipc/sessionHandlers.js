const { ipcMain } = require("electron");
const { exec } = require("child_process");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

let adbPathRef = null;
let getVideoClientRef = null;
let getNewInstanceManagerRef = null;

/** État écran physique suivi hors Type A (ADB / Type B) — clé = serial ADB résolu. */
const deviceScreenOffBySerial = new Map();

async function resolveEntryAdbSerial(entry, sessionId = null) {
    if (!entry?.deviceId && !entry?.stableDeviceId) {
        const manager = getNewInstanceManagerRef?.();
        if (sessionId && manager) {
            const typeB = manager.getNewInstanceSession(sessionId);
            if (typeB?.serial) {
                entry = { deviceId: typeB.serial, stableDeviceId: typeB.stableDeviceId || null };
            }
        }
    }
    if (!entry?.deviceId && !entry?.stableDeviceId) return null;

    if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
        const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
            deviceId: entry.stableDeviceId || null,
            serial: entry.deviceId || null
        });
        if (resolved) return resolved;
    }

    return entry.deviceId || null;
}

async function resolveHintAdbSerial({ serial = null, stableDeviceId = null } = {}) {
    if (!serial && !stableDeviceId) return null;
    if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
        try {
            const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
                deviceId: stableDeviceId || null,
                serial: serial || null
            });
            if (resolved) return resolved;
        } catch (_err) {
            // fallback serial
        }
    }
    return serial || null;
}

function runAdbShell(serial, shellCommand) {
    return new Promise((resolve, reject) => {
        if (!adbPathRef || !serial) {
            reject(new Error("ADB ou serial manquant"));
            return;
        }
        exec(
            `"${adbPathRef}" -s ${adbSerialArg(serial)} shell ${shellCommand}`,
            { windowsHide: true },
            (error) => {
                if (error) reject(error);
                else resolve();
            }
        );
    });
}

function runAdbShellStdout(serial, shellCommand) {
    return new Promise((resolve, reject) => {
        if (!adbPathRef || !serial) {
            reject(new Error("ADB ou serial manquant"));
            return;
        }
        exec(
            `"${adbPathRef}" -s ${adbSerialArg(serial)} shell ${shellCommand}`,
            { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
            (error, stdout) => {
                if (error) reject(error);
                else resolve(String(stdout || ""));
            }
        );
    });
}

function notifyScreenPowerChanged(payload) {
    const win = global.browserViewManager?.mainWindow;
    if (win && !win.isDestroyed()) {
        win.webContents.send("session:screen-power-changed", payload || {});
    }
    const overlay = global.screenPowerOverlayManager;
    if (overlay?.visible && typeof overlay.applyExternalPanel === "function") {
        try {
            overlay.applyExternalPanel(payload || {});
        } catch (_err) {
            // noop
        }
    }
}

function syncScreenOffOnDeviceSessions(adbSerial, screenOff, {
    stableDeviceId = null,
    preferSerial = null,
    persist = true
} = {}) {
    if (adbSerial) {
        deviceScreenOffBySerial.set(adbSerial, Boolean(screenOff));
    }
    if (preferSerial && preferSerial !== adbSerial) {
        deviceScreenOffBySerial.set(preferSerial, Boolean(screenOff));
    }

    const manager = global.browserViewManager;
    if (manager?.getAllSessions) {
        for (const summary of manager.getAllSessions()) {
            const entry = manager.getSessionEntry(summary.sessionId);
            if (!entry) continue;
            const sameStable = Boolean(
                stableDeviceId && entry.stableDeviceId && entry.stableDeviceId === stableDeviceId
            );
            const sameSerial = Boolean(
                (adbSerial && entry.deviceId === adbSerial)
                || (preferSerial && entry.deviceId === preferSerial)
                || (adbSerial && preferSerial && entry.deviceId === preferSerial)
            );
            if (!sameStable && !sameSerial) continue;
            manager.setSessionScreenOff(summary.sessionId, screenOff);
        }
    }

    if (persist) {
        persistDesiredScreenOff({
            deviceId: stableDeviceId,
            serial: preferSerial || adbSerial,
            screenOff: Boolean(screenOff)
        });
    }
}

async function probePhysicalScreenOff(serial) {
    if (!serial) return null;
    try {
        const out = await runAdbShellStdout(serial, "dumpsys power");
        if (/Display Power:\s*state\s*=\s*OFF/i.test(out)) return true;
        if (/Display Power:\s*state\s*=\s*ON/i.test(out)) return false;
        if (/\bmScreenOn\s*=\s*false\b/i.test(out)) return true;
        if (/\bmScreenOn\s*=\s*true\b/i.test(out)) return false;
        if (/\bmWakefulness\s*=\s*Asleep\b/i.test(out)) return true;
        if (/\bmWakefulness\s*=\s*Awake\b/i.test(out)) return false;
    } catch (_err) {
        // ignore — fallback état suivi
    }
    return null;
}

global.probePhysicalScreenOff = probePhysicalScreenOff;

function sameDeviceAs(entry, adbSerial, stableDeviceId, preferSerial = null) {
    if (!entry) return false;
    if (stableDeviceId && entry.stableDeviceId && entry.stableDeviceId === stableDeviceId) {
        return true;
    }
    const id = entry.deviceId || null;
    if (!id) return false;
    if (
        (adbSerial && id === adbSerial)
        || (preferSerial && id === preferSerial)
    ) {
        return true;
    }
    // Même appareil USB/Wi‑Fi : deviceId Type A peut différer du serial Type B.
    if (stableDeviceId && id === stableDeviceId) return true;
    return false;
}

/**
 * Préfère un client scrcpy Type A (miroir) puis Type B : setDisplayPower éteint le
 * panneau physique sans mettre le device en sommeil (évite flux Type A noir).
 */
function findDisplayPowerClient(adbSerial, stableDeviceId = null, preferSerial = null) {
    const manager = global.browserViewManager;
    if (!manager?.getAllSessions) return null;

    const matches = [];
    for (const summary of manager.getAllSessions()) {
        const entry = manager.getSessionEntry(summary.sessionId);
        if (!entry) continue;
        if (!sameDeviceAs(entry, adbSerial, stableDeviceId, preferSerial)) {
            // Filet : un seul Type A connecté + serial fourni → le prendre
            // (évite faux négatif USB vs Wi‑Fi sans stableDeviceId).
            continue;
        }
        matches.push({ summary, entry, sessionId: summary.sessionId });
    }

    if (!matches.length) {
        const typeAOnly = [];
        for (const summary of manager.getAllSessions()) {
            const entry = manager.getSessionEntry(summary.sessionId);
            if (entry?.type === "A" && entry.deviceId) {
                typeAOnly.push({ summary, entry, sessionId: summary.sessionId });
            }
        }
        // Si un seul miroir Type A existe, l'utiliser pour setDisplayPower
        // (fermeture Type B avec serial résolu différemment).
        if (typeAOnly.length === 1 && (adbSerial || stableDeviceId || preferSerial)) {
            matches.push(typeAOnly[0]);
        }
    }

    const ordered = [
        ...matches.filter((m) => m.entry.type === "A"),
        ...matches.filter((m) => m.entry.type === "B")
    ];

    for (const m of ordered) {
        let client = null;
        if (m.entry.type === "A" && typeof getVideoClientRef === "function") {
            client = getVideoClientRef(m.sessionId);
        } else if (m.entry.type === "B") {
            const ni = getNewInstanceManagerRef?.()?.getNewInstanceSession?.(m.sessionId);
            client = ni?.client || null;
        }
        if (client?.controlSocket && typeof client.setDisplayPower === "function") {
            return { client, sessionId: m.sessionId, type: m.entry.type };
        }
    }
    return null;
}

/**
 * Éteint/allume l'écran physique. setDisplayPower si un flux scrcpy existe ;
 * sinon ADB (keyevent) en dernier recours — interdit si allowAdbSleep=false
 * (évite de noircir un miroir Type A encore actif).
 */
async function setPhysicalScreenPower(serial, turnOff, {
    stableDeviceId = null,
    preferSerial = null,
    allowAdbSleep = true
} = {}) {
    if (!serial) throw new Error("Serial manquant pour toggle ecran");

    if (turnOff) {
        try {
            await runAdbShell(serial, "svc power stayon true");
        } catch (_err) {
            // best-effort
        }
    }

    const powerClient = findDisplayPowerClient(serial, stableDeviceId, preferSerial);
    if (powerClient?.client) {
        await powerClient.client.setDisplayPower(!turnOff);
        return { mode: "scrcpy", sessionId: powerClient.sessionId, type: powerClient.type };
    }

    if (turnOff) {
        if (!allowAdbSleep) {
            console.warn(
                `[ScreenPower] skip keyevent 223 — aucun setDisplayPower et ADB sleep interdit (${serial})`
            );
            return { mode: "skipped-adb-sleep", sessionId: null, type: null };
        }
        // KEYCODE_SLEEP — peut noircir un miroir Type A : réservé à l'absence de Type A.
        await runAdbShell(serial, "input keyevent 223");
    } else {
        try {
            await runAdbShell(serial, "svc power stayon true");
        } catch (_err) {
            // noop
        }
        // WAKEUP puis POWER si besoin (certains OEM ignorent 224 seul).
        await runAdbShell(serial, "input keyevent 224");
        const stillOff = await probePhysicalScreenOff(serial);
        if (stillOff === true) {
            try {
                await runAdbShell(serial, "input keyevent 26");
            } catch (_err) {
                // noop
            }
        }
    }
    return { mode: "adb", sessionId: null, type: null };
}

global.applyPhysicalScreenPower = setPhysicalScreenPower;

async function listConnectedScreenPowerDevices() {
    let devices = [];
    try {
        devices = await global.deviceRegistry?.listUnifiedDevices?.({ forceFresh: false }) || [];
    } catch (_err) {
        devices = [];
    }
    return (Array.isArray(devices) ? devices : [])
        .filter((d) => d && d.connected !== false && (d.serial || d.deviceId))
        .map((d) => ({
            serial: d.serial || d.deviceId,
            deviceId: d.deviceId || d.serial,
            name: d.name || d.originalName || d.model || d.serial || d.deviceId,
            stableDeviceId: d.deviceId || null
        }));
}

async function resolveDeviceScreenOffState({ serial, stableDeviceId = null, allowProbe = false } = {}) {
    let screenOff = resolveDesiredScreenOff({ serial, stableDeviceId });
    if (screenOff === null && allowProbe && serial) {
        const probed = await probePhysicalScreenOff(serial);
        screenOff = probed !== null ? probed : false;
    }
    return screenOff === null ? false : Boolean(screenOff);
}

async function applyDeviceScreenPower({
    adbSerial,
    deviceId = null,
    stableDeviceId = null,
    screenOff,
    sessionId = null,
    entry = null,
    notify = true,
    applyPhysical = true
} = {}) {
    const manager = global.browserViewManager;
    if (!adbSerial) {
        return { success: false, error: "Aucun appareil pour basculer l'ecran" };
    }

    const turningOff = Boolean(screenOff);
    const hasTypeA = Boolean(
        manager?.getAllSessions?.().some((summary) => {
            if (summary?.type !== "A") return false;
            if (stableDeviceId && summary.stableDeviceId && summary.stableDeviceId === stableDeviceId) {
                return true;
            }
            return summary.deviceId === adbSerial || summary.deviceId === deviceId;
        })
    );

    try {
        // Intention + UI d'abord (badge / popup), ADB ensuite.
        syncScreenOffOnDeviceSessions(adbSerial, turningOff, {
            stableDeviceId,
            preferSerial: deviceId,
            persist: true
        });
        if (notify) {
            notifyScreenPowerChanged({
                sessionId: sessionId || null,
                deviceId: deviceId || adbSerial,
                stableDeviceId,
                screenOff: turningOff,
                mode: "intent"
            });
        }

        let applied = { mode: "intent", sessionId: null, type: null };
        if (applyPhysical) {
            if (turningOff && entry?.type === "A" && sessionId && !entry.stayAwakeActive) {
                try {
                    await runAdbShell(adbSerial, "svc power stayon true");
                    manager?.setSessionStayAwake?.(sessionId, true);
                } catch (_err) {
                    // best-effort
                }
            }

            applied = await setPhysicalScreenPower(adbSerial, turningOff, {
                stableDeviceId,
                preferSerial: deviceId,
                allowAdbSleep: !hasTypeA
            });
        }

        return {
            success: true,
            sessionId: sessionId || null,
            screenOff: turningOff,
            deviceId: deviceId || adbSerial,
            stableDeviceId: stableDeviceId || null,
            mode: applied?.mode || "adb"
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function buildScreenPowerPanel({ allowProbe = false } = {}) {
    const connected = await listConnectedScreenPowerDevices();
    const devices = await Promise.all(connected.map(async (device) => {
        const adbSerial = await resolveHintAdbSerial({
            serial: device.serial,
            stableDeviceId: device.stableDeviceId
        }) || device.serial;
        const screenOff = await resolveDeviceScreenOffState({
            serial: adbSerial,
            stableDeviceId: device.stableDeviceId,
            allowProbe
        });
        const labeled = global.customNamesManager?.applyDeviceNames?.([{
            ...device,
            serial: adbSerial,
            name: device.name
        }]);
        return {
            key: String(device.stableDeviceId || adbSerial),
            name: labeled?.[0]?.name || device.name || adbSerial,
            serial: adbSerial,
            deviceId: device.deviceId || adbSerial,
            stableDeviceId: device.stableDeviceId || null,
            screenOff
        };
    }));

    const allOff = devices.length > 0 && devices.every((d) => d.screenOff);
    const anyOn = devices.some((d) => !d.screenOff);
    return {
        devices,
        globalScreenOff: allOff,
        globalScreenOn: anyOn,
        enabled: devices.length > 0
    };
}

async function applyGlobalScreenPowerToggle() {
    const panel = await buildScreenPowerPanel({ allowProbe: false });
    if (!panel.devices.length) {
        return { success: false, error: "Aucun appareil connecté", screenOff: false, global: true };
    }
    // Comme l'audio : si un écran est allumé → tout éteindre ; sinon tout allumer.
    const turningOff = panel.devices.some((d) => !d.screenOff);

    // Intention mémoire + notif UI immédiate pour tous les boutons.
    for (const device of panel.devices) {
        syncScreenOffOnDeviceSessions(device.serial, turningOff, {
            stableDeviceId: device.stableDeviceId,
            preferSerial: device.deviceId,
            persist: true
        });
    }
    notifyScreenPowerChanged({
        deviceId: null,
        stableDeviceId: null,
        screenOff: turningOff,
        mode: "global",
        panel: {
            devices: panel.devices.map((d) => ({ ...d, screenOff: turningOff })),
            globalScreenOff: turningOff,
            globalScreenOn: !turningOff,
            enabled: true
        }
    });

    const results = await Promise.all(panel.devices.map((device) => applyDeviceScreenPower({
        adbSerial: device.serial,
        deviceId: device.deviceId,
        stableDeviceId: device.stableDeviceId,
        screenOff: turningOff,
        notify: false,
        applyPhysical: true
    })));

    const failed = results.find((r) => !r?.success);
    return {
        success: !failed,
        screenOff: turningOff,
        global: true,
        devices: results,
        error: failed?.error || null
    };
}

global.applyDeviceScreenPower = applyDeviceScreenPower;
global.applyGlobalScreenPowerToggle = applyGlobalScreenPowerToggle;
global.buildScreenPowerPanel = buildScreenPowerPanel;

/** Serials déjà vus connectés cette session Hub (pour resync badge à la connexion). */
const screenTrackingSeenSerials = new Set();
/** serial → { deviceId, serial } pour persistance à la déconnexion. */
const screenTrackingDeviceMeta = new Map();

function screenPowerDeviceKey({ deviceId = null, serial = null } = {}) {
    return String(deviceId || serial || "").trim() || null;
}

function getUiScreenPowerManager() {
    return global.uiPreferencesManager || null;
}

/** Persiste toujours l'intention ON/OFF (partagée Type A/B). */
function persistDesiredScreenOff({ deviceId = null, serial = null, screenOff }) {
    const manager = getUiScreenPowerManager();
    if (!manager?.saveDeviceScreenPowerState) return;
    if (typeof screenOff !== "boolean") return;
    const key = screenPowerDeviceKey({ deviceId, serial });
    if (!key) return;
    try {
        manager.saveDeviceScreenPowerState(key, screenOff);
        if (serial && key !== serial) {
            manager.saveDeviceScreenPowerState(serial, screenOff);
        }
    } catch (err) {
        console.warn("[ScreenPower] persist desired:", err?.message || err);
    }
}

/** @deprecated alias — intention device toujours persistée. */
function persistScreenPowerIfEnabled(args) {
    persistDesiredScreenOff(args);
}

/**
 * Intention écran par device (pas par session).
 * Source : map runtime + prefs persistées (toggle bouton).
 * @returns {boolean|null} null = jamais choisi explicitement
 */
function resolveDesiredScreenOff({ serial = null, stableDeviceId = null } = {}) {
    if (serial && deviceScreenOffBySerial.has(serial)) {
        return Boolean(deviceScreenOffBySerial.get(serial));
    }

    const prefs = getUiScreenPowerManager();
    if (prefs?.getSavedDeviceScreenPowerState) {
        const saved = (stableDeviceId && prefs.getSavedDeviceScreenPowerState(stableDeviceId))
            || (serial && prefs.getSavedDeviceScreenPowerState(serial));
        if (saved && typeof saved.screenOff === "boolean") {
            if (serial) {
                deviceScreenOffBySerial.set(serial, saved.screenOff);
            }
            return saved.screenOff;
        }
    }

    return null;
}

/**
 * @param {boolean} typeBDefault - si aucune intention utilisateur : ne pas forcer OFF
 */
function shouldPhysicalScreenBeOff(serial, stableDeviceId = null, { typeBDefault = false } = {}) {
    const desired = resolveDesiredScreenOff({ serial, stableDeviceId });
    if (desired === null) return typeBDefault;
    return desired === true;
}

global.getDesiredScreenOff = (serial, stableDeviceId = null) => (
    resolveDesiredScreenOff({ serial, stableDeviceId })
);

global.shouldPhysicalScreenBeOff = shouldPhysicalScreenBeOff;

global.setDesiredScreenOff = (serial, screenOff, meta = {}) => {
    if (!serial && !meta.stableDeviceId) return;
    const adbSerial = serial || meta.preferSerial || null;
    if (!adbSerial) return;
    syncScreenOffOnDeviceSessions(adbSerial, Boolean(screenOff), {
        stableDeviceId: meta.stableDeviceId || null,
        preferSerial: meta.preferSerial || serial
    });
    if (meta.notify !== false) {
        notifyScreenPowerChanged({
            deviceId: adbSerial,
            stableDeviceId: meta.stableDeviceId || null,
            screenOff: Boolean(screenOff),
            mode: meta.mode || "desired"
        });
    }
};

function rememberDeviceScreenOff(serial, screenOff) {
    if (!serial) return;
    deviceScreenOffBySerial.set(serial, Boolean(screenOff));
}

function clearDeviceScreenOffState(serial) {
    if (!serial) return;
    deviceScreenOffBySerial.delete(serial);
}

global.syncDeviceScreenOffState = (serial, screenOff, meta = {}) => {
    if (!serial) return;
    syncScreenOffOnDeviceSessions(serial, Boolean(screenOff), {
        stableDeviceId: meta.stableDeviceId || null,
        preferSerial: meta.preferSerial || null
    });
    notifyScreenPowerChanged({
        deviceId: serial,
        stableDeviceId: meta.stableDeviceId || null,
        screenOff: Boolean(screenOff),
        mode: meta.mode || "adb"
    });
};

/**
 * Nouveau / reconnecté : sync badge + applique l'état écran pour tout le device (A/B/Accueil).
 * 1) Intention sauvée (bouton) si connue
 * 2) sinon probe physique
 * Puis applique toujours via le même chemin que le toggle Type B.
 * @param {Array<{ serial: string, deviceId?: string|null }>} devices
 */
global.resetDeviceScreenOffTracking = async (devices = []) => {
    const list = (Array.isArray(devices) ? devices : [])
        .map((item) => (typeof item === "string"
            ? { serial: item, deviceId: null }
            : { serial: item?.serial, deviceId: item?.deviceId || null }))
        .filter((item) => item.serial);

    const prefs = getUiScreenPowerManager();

    for (const item of list) {
        const serial = item.serial;
        const deviceId = item.deviceId || null;
        clearDeviceScreenOffState(serial);

        const saved = prefs?.getSavedDeviceScreenPowerState?.(deviceId)
            || prefs?.getSavedDeviceScreenPowerState?.(serial);
        const hasSaved = Boolean(saved && typeof saved.screenOff === "boolean");

        let screenOff = hasSaved ? saved.screenOff : null;
        let mode = hasSaved ? "desired" : "probe";

        if (screenOff === null) {
            const probed = await probePhysicalScreenOff(serial);
            screenOff = probed !== null ? probed : false;
            mode = "probe";
        }

        // Type A déjà ouvert → jamais KEYCODE_SLEEP (flux noir).
        const hasTypeA = Boolean(
            global.browserViewManager?.getAllSessions?.().some((summary) => {
                if (summary?.type !== "A") return false;
                if (deviceId && summary.stableDeviceId && summary.stableDeviceId === deviceId) {
                    return true;
                }
                return summary.deviceId === serial || summary.deviceId === deviceId;
            })
        );

        try {
            await setPhysicalScreenPower(serial, screenOff, {
                stableDeviceId: deviceId,
                preferSerial: serial,
                allowAdbSleep: !hasTypeA
            });
            mode = hasSaved ? "applied-desired" : "applied-probe";
        } catch (err) {
            console.warn(`[ScreenPower] apply on connect ${serial}:`, err?.message || err);
        }

        rememberDeviceScreenOff(serial, screenOff);
        syncScreenOffOnDeviceSessions(serial, screenOff, {
            stableDeviceId: deviceId,
            preferSerial: serial,
            persist: hasSaved || mode.startsWith("applied")
        });
        notifyScreenPowerChanged({
            deviceId: serial,
            stableDeviceId: deviceId,
            screenOff,
            mode
        });
        console.log(
            `[ScreenPower] device detecte ${serial} screenOff=${screenOff} mode=${mode}`
            + (hasTypeA ? " (Type A present)" : "")
        );
    }
};

/**
 * Appelé à chaque refresh devices : prime le tracking écran pour les nouveaux serials
 * et mémorise/oublie ceux déconnectés.
 * @param {Array<{ serial: string, deviceId?: string|null }|string>} devicesOrSerials
 */
global.syncScreenTrackingForConnectedSerials = (devicesOrSerials = []) => {
    const devices = (Array.isArray(devicesOrSerials) ? devicesOrSerials : [])
        .map((item) => (typeof item === "string"
            ? { serial: item, deviceId: null }
            : { serial: item?.serial || null, deviceId: item?.deviceId || null }))
        .filter((item) => item.serial);

    const current = new Set(devices.map((d) => d.serial));
    for (const device of devices) {
        screenTrackingDeviceMeta.set(device.serial, {
            serial: device.serial,
            deviceId: device.deviceId || null
        });
    }

    for (const serial of [...screenTrackingSeenSerials]) {
        if (!current.has(serial)) {
            const meta = screenTrackingDeviceMeta.get(serial) || { serial, deviceId: null };
            if (deviceScreenOffBySerial.has(serial)) {
                persistScreenPowerIfEnabled({
                    deviceId: meta.deviceId,
                    serial,
                    screenOff: deviceScreenOffBySerial.get(serial)
                });
            }
            screenTrackingSeenSerials.delete(serial);
            screenTrackingDeviceMeta.delete(serial);
            clearDeviceScreenOffState(serial);
        }
    }

    const newly = devices.filter((d) => !screenTrackingSeenSerials.has(d.serial));
    for (const device of newly) {
        screenTrackingSeenSerials.add(device.serial);
    }
    if (newly.length) {
        void global.resetDeviceScreenOffTracking(newly);
    }
};

function cycleSessionTab(direction = "next") {
    const manager = global.browserViewManager;
    if (!manager) {
        return { success: false, error: "manager-unavailable" };
    }

    const sessions = manager.getAllSessions();
    if (sessions.length <= 1) {
        return { success: false, error: "not-enough-sessions" };
    }

    const currentIndex = sessions.findIndex((session) => session.active);
    let nextIndex;
    if (direction === "prev") {
        nextIndex = currentIndex === -1
            ? sessions.length - 1
            : (currentIndex - 1 + sessions.length) % sessions.length;
    } else {
        nextIndex = currentIndex === -1
            ? 0
            : (currentIndex + 1) % sessions.length;
    }

    const target = sessions[nextIndex];
    if (!target) {
        return { success: false, error: "target-not-found" };
    }

    if (target.sessionId === manager.getActiveSessionId()) {
        return { success: false, error: "already-active" };
    }

    manager.switchToSession(target.sessionId);

    const win = manager.mainWindow;
    if (win && !win.isDestroyed()) {
        win.webContents.send("session:activated", { sessionId: target.sessionId });
    }

    return { success: true, sessionId: target.sessionId };
}

function attachTabCycleHandler(webContents) {
    if (!webContents || webContents._tabCycleAttached) return;
    webContents._tabCycleAttached = true;

    webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        if (!(input.control || input.meta)) return;

        if (input.key === "Tab") {
            event.preventDefault();
            cycleSessionTab(input.shift ? "prev" : "next");
            return;
        }

        if (input.alt) return;
        if (input.isAutoRepeat) return;
        const key = String(input.key || "").toLowerCase();
        if (key === "a") {
            event.preventDefault();
            void global.clipboardSyncManager?.handleShortcut?.(webContents, key);
            return;
        }
        if (key !== "c" && key !== "x" && key !== "v") return;
        if (!global.clipboardSyncManager?.isEnabled?.()) return;

        event.preventDefault();
        void global.clipboardSyncManager.handleShortcut(webContents, key);
    });
}

function registerSessionHandlers(adbPath, deps = {}) {
    adbPathRef = adbPath;
    getVideoClientRef = typeof deps.getVideoClient === "function" ? deps.getVideoClient : null;
    getNewInstanceManagerRef = typeof deps.getNewInstanceManager === "function"
        ? deps.getNewInstanceManager
        : null;
    const stopVideoStream = typeof deps.stopVideoStream === "function" ? deps.stopVideoStream : null;
    const getNewInstanceManager = getNewInstanceManagerRef;

    ipcMain.handle("session:cycleTab", (_event, { direction = "next" } = {}) => {
        return cycleSessionTab(direction === "prev" ? "prev" : "next");
    });

    ipcMain.handle("session:switchTo", async (_event, sessionId) => {
        const result = await global.browserViewManager.switchToSession(sessionId);
        if (result) {
            const win = global.browserViewManager?.mainWindow;
            if (win && !win.isDestroyed()) {
                win.webContents.send("session:activated", { sessionId });
            }
        }
        return result;
    });

    ipcMain.handle("session:reorder", async (_event, orderedIds) => {
        const manager = global.browserViewManager;
        if (!manager?.reorderSessions) {
            return { success: false, error: "BrowserViewManager indisponible" };
        }
        return manager.reorderSessions(orderedIds);
    });

    ipcMain.handle("session:close", async (_event, sessionId) => {
        console.warn(`[session:close] sessionId=${sessionId}`);
        const manager = getNewInstanceManager?.();
        const entry = global.browserViewManager?.getSessionEntry(sessionId);
        const isAppInstance = sessionId.startsWith("new-instance-") || entry?.type === "B";
        const serial = entry?.deviceId || null;
        const wasPortrait = entry?.captureOrientation === "portrait";
        const packageName = entry?.packageName || null;
        const userId = entry?.userId;
        const stableDeviceId = entry?.stableDeviceId || null;

        // Handoff audio AVANT stop vidéo : la capture ne doit pas mourir avec le display Type B.
        if (global.sessionAudioProcessManager) {
            try {
                if (global.sessionAudioProcessManager.releaseSessionKeepHold) {
                    const holdId = await global.sessionAudioProcessManager.releaseSessionKeepHold(
                        sessionId,
                        {
                            deviceKey: stableDeviceId || serial,
                            serial
                        }
                    );
                    if (holdId) {
                        console.log(`[session:close] audio hold → ${holdId}`);
                    }
                } else {
                    await global.sessionAudioProcessManager.stop(sessionId);
                }
            } catch (err) {
                console.warn("[session:close] arret/hold audio:", err?.message || err);
            }
        }

        // Fermeture UI / flux vidéo ensuite.
        if (getVideoClientRef?.(sessionId) && stopVideoStream) {
            try {
                await stopVideoStream(sessionId);
            } catch (err) {
                console.warn("[session:close] arret flux:", err?.message || err);
            }
        }

        const result = global.browserViewManager.closeSessionView(sessionId);
        if (result) {
            global.sessionStreamRegistry?.remove(sessionId);
            global.streamParamsManager?.notifySessionListChanged();
        }

        try {
            global.deviceSpeakerOverlayManager?.syncSlidersFromAudioState?.();
        } catch (_err) {
            /* ignore */
        }

        if (manager && isAppInstance) {
            // Un seul owner device-cleanup : ensure (stop session si vivante, sinon fallback
            // avec métadonnées capturées). force-stop / re-off sont idempotents côté manager.
            void (async () => {
                try {
                    await manager.ensureAppStoppedForSessionClose(sessionId, {
                        serial,
                        packageName,
                        userId: Number.isInteger(userId) ? userId : null,
                        stableDeviceId
                    });
                } catch (err) {
                    console.warn("[session:close] arret appareil:", err?.message || err);
                }

                // Orientation paysage peut réveiller l'écran — re-éteint après (dedupe sessionId).
                if (wasPortrait && serial && global.deviceOrientationManager) {
                    try {
                        const adbSerial = await resolveEntryAdbSerial(entry, sessionId) || serial;
                        await global.deviceOrientationManager.applyOrientation(adbSerial, "landscape");
                        global.deviceOrientationManager.clearSavedState(adbSerial);
                    } catch (err) {
                        console.warn("[session:close] restauration orientation:", err?.message || err);
                    }
                    try {
                        let adbSerial = serial;
                        try {
                            adbSerial = await resolveEntryAdbSerial(entry, sessionId) || serial;
                        } catch (_err) {
                            // garder serial capturé
                        }
                        // force: l'orientation paysage peut réveiller l'écran après le 1er re-off.
                        await manager.reassertPhysicalScreenOffAfterClose({
                            serial: adbSerial || serial,
                            stableDeviceId,
                            sessionId,
                            force: true
                        });
                    } catch (err) {
                        console.warn("[session:close] re-off ecran:", err?.message || err);
                    }
                }
            })();
        } else if (serial) {
            // Type A : scrcpy rallume souvent le panneau à l'arrêt — même re-off que Type B
            // si le bouton dock est OFF (reassertPhysicalScreenOffAfterClose gate sur desiredOff).
            void (async () => {
                let adbSerial = serial;
                try {
                    adbSerial = await resolveEntryAdbSerial(entry, sessionId) || serial;
                } catch (_err) {
                    // garder serial capturé
                }

                if (wasPortrait && global.deviceOrientationManager) {
                    try {
                        await global.deviceOrientationManager.applyOrientation(adbSerial, "landscape");
                        global.deviceOrientationManager.clearSavedState(adbSerial);
                    } catch (err) {
                        console.warn("[session:close] restauration orientation:", err?.message || err);
                    }
                }

                try {
                    if (manager?.reassertPhysicalScreenOffAfterClose) {
                        await manager.reassertPhysicalScreenOffAfterClose({
                            serial: adbSerial || serial,
                            stableDeviceId,
                            sessionId
                        });
                    } else if (typeof global.applyPhysicalScreenPower === "function") {
                        const desiredOff = typeof global.getDesiredScreenOff === "function"
                            ? global.getDesiredScreenOff(adbSerial || serial, stableDeviceId)
                            : null;
                        if (desiredOff === true) {
                            await global.applyPhysicalScreenPower(adbSerial || serial, true, {
                                stableDeviceId,
                                preferSerial: serial,
                                allowAdbSleep: true
                            });
                            if (typeof global.syncDeviceScreenOffState === "function") {
                                global.syncDeviceScreenOffState(adbSerial || serial, true, {
                                    stableDeviceId,
                                    mode: "adb"
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.warn("[session:close] re-off ecran Type A:", err?.message || err);
                }
            })();
        }

        return result;
    });

    ipcMain.handle("session:list", async () => {
        const manager = global.browserViewManager;
        if (!manager) return [];
        const sessions = manager.getAllSessions();
        let resolved;
        if (!global.customNamesManager) {
            resolved = sessions;
        } else {
            resolved = global.customNamesManager.applySessionNames(sessions);
            for (const session of resolved) {
                const entry = manager.getSessionEntry(session.sessionId);
                if (!entry) continue;
                const patch = {};
                if (entry.label !== session.label) {
                    patch.label = session.label;
                }
                if (session.originalLabel && entry.originalLabel !== session.originalLabel) {
                    patch.originalLabel = session.originalLabel;
                }
                if (Object.keys(patch).length) {
                    manager.updateSessionMetadata(session.sessionId, patch);
                }
            }
        }

        if (global.deviceColorsManager) {
            const adbSerialToDeviceId = global.deviceRegistry
                ? await global.deviceRegistry.buildAdbSerialToDeviceIdMap()
                : null;
            resolved = global.deviceColorsManager.applySessionColors(resolved, adbSerialToDeviceId);
        }

        return resolved;
    });

    ipcMain.handle("session:getFrameCounts", async () => {
        const manager = global.browserViewManager;
        if (!manager) return {};
        return manager.getFrameCountsForAllSessions();
    });

    ipcMain.handle("session:getPreviewFrame", async (_event, sessionId) => {
        const manager = global.browserViewManager;
        if (!manager || !sessionId) {
            return { available: false };
        }
        return manager.capturePreviewFrame(sessionId);
    });

    ipcMain.handle("session:registerView", async (_event, { sessionId, type, deviceId, stableDeviceId, label, screenOff, stayAwakeActive, packageName, userId, streamParams }) => {
        const extraQuery = {};
        if (deviceId) extraQuery.deviceId = deviceId;
        if (stableDeviceId) extraQuery.stableDeviceId = stableDeviceId;
        if (label) extraQuery.label = label;
        if (screenOff !== undefined) extraQuery.screenOff = screenOff;
        if (stayAwakeActive !== undefined) extraQuery.stayAwakeActive = stayAwakeActive;
        if (packageName) extraQuery.packageName = packageName;
        if (Number.isInteger(userId)) extraQuery.userId = userId;
        if (streamParams) extraQuery.streamParams = streamParams;

        const result = await global.browserViewManager.registerSessionView(sessionId, type, extraQuery);
        if (global.browserViewManager) {
            const entry = global.browserViewManager.getSessionEntry(sessionId);
            if (entry && global.sessionStreamRegistry) {
                global.sessionStreamRegistry.syncFromBrowserViewEntry(sessionId, entry);
            }
            if (entry && global.customNamesManager) {
                const displayLabel = global.customNamesManager.resolveSessionLabel({
                    sessionId,
                    type: entry.type,
                    deviceId: entry.deviceId,
                    stableDeviceId: entry.stableDeviceId,
                    packageName: entry.packageName,
                    userId: entry.userId,
                    label: entry.label,
                    originalLabel: entry.originalLabel || entry.label
                });
                if (displayLabel && displayLabel !== entry.label) {
                    global.browserViewManager.updateSessionMetadata(sessionId, { label: displayLabel });
                }
            }
        }
        if (global.streamParamsManager) {
            global.streamParamsManager.notifySessionListChanged();
        }
        return result;
    });

    ipcMain.handle("session:setContentBounds", (_event, bounds) => {
        global.browserViewManager.setContentBounds(bounds);
        return true;
    });

    ipcMain.handle("session:setLayoutMode", (_event, { mode } = {}) => {
        global.browserViewManager.setLayoutMode(mode);
        return true;
    });

    ipcMain.handle("session:setLayoutBounds", (_event, { boundsMap } = {}) => {
        global.browserViewManager.setMultiSessionBounds(boundsMap || {});
        return true;
    });

    ipcMain.handle("session:suppressView", () => {
        global.browserViewManager.suppressActiveView();
        return true;
    });

    ipcMain.handle("session:restoreView", () => {
        global.browserViewManager.restoreActiveView();
        return true;
    });

    ipcMain.handle("session:setUiBrightness", (_event, payload = {}) => {
        const manager = global.browserViewManager;
        if (!manager?.setUiBrightness) {
            return { success: false, brightness: 100 };
        }
        const brightness = manager.setUiBrightness(payload?.brightness);
        return { success: true, brightness };
    });

    ipcMain.handle("session:getActiveTypeA", () => {
        const session = global.browserViewManager.getActiveTypeASession();
        return { success: true, session };
    });

    ipcMain.handle("session:getScreenToggleState", async (_event, hint = {}) => {
        const manager = global.browserViewManager;
        if (!manager) {
            return { success: false, enabled: false, error: "BrowserViewManager indisponible" };
        }

        const home = Boolean(hint?.home);
        const activeId = manager.getActiveSessionId();
        const activeEntry = (!home && activeId) ? manager.getSessionEntry(activeId) : null;

        const buildState = async ({ mode, sessionId, deviceId, stableDeviceId, entryScreenOff = null, preferProbe = false }) => {
            const adbSerial = deviceId || stableDeviceId
                ? await resolveHintAdbSerial({ serial: deviceId, stableDeviceId })
                : null;
            let screenOff = resolveDesiredScreenOff({
                serial: adbSerial || deviceId,
                stableDeviceId
            });
            if (screenOff === null && preferProbe && adbSerial) {
                const probed = await probePhysicalScreenOff(adbSerial);
                screenOff = probed !== null ? probed : false;
                // Probe UI seulement — ne pas écrire l'intention launch (bouton dock).
            }
            if (screenOff === null && typeof entryScreenOff === "boolean") {
                screenOff = entryScreenOff;
            }
            if (screenOff === null) screenOff = false;
            return {
                success: true,
                enabled: true,
                mode,
                sessionId,
                deviceId: deviceId || adbSerial,
                stableDeviceId: stableDeviceId || null,
                screenOff: Boolean(screenOff)
            };
        };

        // Type A / Type B actifs : même intention device.
        if (activeEntry?.deviceId && (activeEntry.type === "A" || activeEntry.type === "B")) {
            return buildState({
                mode: activeEntry.type === "A" ? "typeA" : "adb",
                sessionId: activeId,
                deviceId: activeEntry.deviceId,
                stableDeviceId: activeEntry.stableDeviceId || null,
                entryScreenOff: typeof activeEntry.screenOff === "boolean" ? activeEntry.screenOff : null,
                preferProbe: false
            });
        }

        // Accueil / rien lancé : device sélectionné (hint).
        const adbSerial = await resolveHintAdbSerial({
            serial: hint?.serial || null,
            stableDeviceId: hint?.stableDeviceId || null
        });
        if (!adbSerial) {
            return { success: true, enabled: false, screenOff: false };
        }

        return buildState({
            mode: "adb",
            sessionId: null,
            deviceId: hint?.serial || adbSerial,
            stableDeviceId: hint?.stableDeviceId || null,
            preferProbe: true
        });
    });

    ipcMain.handle("session:toggleScreen", async (_event, payload) => {
        const opts = (typeof payload === "string" || payload == null)
            ? { sessionId: payload || null }
            : (payload || {});

        // Clic sidebar = global (tous les devices), sauf cible device explicite (popup).
        if (opts.global === true || (opts.scope === "global")) {
            return applyGlobalScreenPowerToggle();
        }

        const manager = global.browserViewManager;
        if (!manager) {
            return { success: false, error: "BrowserViewManager indisponible" };
        }

        const home = Boolean(opts.home);
        const targetId = opts.sessionId || (!home ? manager.getActiveSessionId() : null);
        const entry = targetId ? manager.getSessionEntry(targetId) : null;

        let adbSerial = null;
        let stableDeviceId = opts.stableDeviceId || entry?.stableDeviceId || null;
        let deviceId = opts.serial || entry?.deviceId || null;

        if (entry?.deviceId) {
            adbSerial = await resolveEntryAdbSerial(entry, targetId);
            deviceId = entry.deviceId || deviceId;
            stableDeviceId = entry.stableDeviceId || stableDeviceId;
        } else {
            adbSerial = await resolveHintAdbSerial({
                serial: opts.serial || null,
                stableDeviceId: opts.stableDeviceId || null
            });
        }

        if (!adbSerial && typeof opts.screenOff !== "boolean") {
            // Pas de cible device → bascule globale (comportement dock).
            return applyGlobalScreenPowerToggle();
        }

        if (!adbSerial) {
            return { success: false, error: "Aucun appareil pour basculer l'ecran" };
        }

        let currentOff = resolveDesiredScreenOff({
            serial: adbSerial,
            stableDeviceId
        });
        if (currentOff === null && entry && typeof entry.screenOff === "boolean") {
            currentOff = entry.screenOff;
        }
        if (currentOff === null) {
            const probed = await probePhysicalScreenOff(adbSerial);
            currentOff = probed !== null ? probed : false;
        }

        const turningOff = typeof opts.screenOff === "boolean" ? opts.screenOff : !currentOff;

        return applyDeviceScreenPower({
            adbSerial,
            deviceId,
            stableDeviceId,
            screenOff: turningOff,
            sessionId: targetId,
            entry
        });
    });

    ipcMain.handle("session:setScreenPower", async (_event, payload = {}) => {
        const screenOff = Boolean(payload?.screenOff);
        const adbSerial = await resolveHintAdbSerial({
            serial: payload?.serial || null,
            stableDeviceId: payload?.stableDeviceId || null
        });
        if (!adbSerial) {
            return { success: false, error: "Aucun appareil" };
        }
        return applyDeviceScreenPower({
            adbSerial,
            deviceId: payload?.serial || adbSerial,
            stableDeviceId: payload?.stableDeviceId || null,
            screenOff
        });
    });

    ipcMain.handle("session:getScreenPowerPanel", async () => buildScreenPowerPanel());

    ipcMain.handle("session:toggleScreenGlobal", async () => applyGlobalScreenPowerToggle());
}

function setupBrowserViewVideoForwarding(newInstanceManager, getMainWindow) {
    if (!global.browserViewManager || !newInstanceManager) return;

    const firstPacketSent = new Set();

    const forward = (sessionId, channel, payload) => {
        global.browserViewManager.sendToSessionView(sessionId, channel, payload);
    };

    const notifyFirstPacket = (sessionId) => {
        if (!sessionId || firstPacketSent.has(sessionId)) return;
        firstPacketSent.add(sessionId);

        const ts = Date.now();
        global.launchLatencyTracker?.mark?.({ sessionId, stage: "h264-first-packet", ts });

        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
            win.webContents.send("video-stream-state", {
                tabId: sessionId,
                stage: "h264-first-packet",
                ts
            });
        }
    };

    newInstanceManager.on("video-codec-meta", (data) => {
        if (!data?.sessionId) return;
        forward(data.sessionId, "new-instance:video-codec-meta", data);

        const ts = Date.now();
        global.launchLatencyTracker?.mark?.({ sessionId: data.sessionId, stage: "codec-meta", ts });

        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
            win.webContents.send("video-stream-state", {
                tabId: data.sessionId,
                stage: "codec-meta",
                ts
            });
        }
    });

    newInstanceManager.on("video-packet", (data) => {
        if (!data?.sessionId) return;
        forward(data.sessionId, "new-instance:video-packet", data);
        notifyFirstPacket(data.sessionId);
    });

    newInstanceManager.on("audio-codec-meta", (data) => {
        if (!data?.sessionId) return;
        forwardSessionAudioEvent(getMainWindow, "new-instance:audio-codec-meta", data);
    });

    newInstanceManager.on("audio-packet", (data) => {
        if (!data?.sessionId) return;
        forwardSessionAudioEvent(getMainWindow, "new-instance:audio-packet", data);
    });

    newInstanceManager.on("video-error", (data) => {
        if (!data?.sessionId) return;
        forward(data.sessionId, "new-instance:video-error", data);
        global.hubDiagnosticLog?.append?.({
            level: data.codecFallback ? "warn" : "error",
            scope: "video",
            sessionId: data.sessionId,
            message: data.codecFallback
                ? (data.error || "Fallback codec Type B")
                : `Stream Type B : ${data.error || "erreur"}`
        });

        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
        if (data.codecFallback) {
            const hubWin = global.hubModalOverlayManager?.overlayWindow;
            if (hubWin && !hubWin.isDestroyed()) {
                hubWin.webContents.send("new-instance:video-error", data);
            } else if (win && !win.isDestroyed()) {
                win.webContents.send("new-instance:video-error", data);
            }
            return;
        }

        if (win && !win.isDestroyed()) {
            win.webContents.send("new-instance:video-error", data);
        }
    });

    newInstanceManager.on("scrcpy-closed", (data) => {
        if (data?.sessionId) firstPacketSent.delete(data.sessionId);
    });
}

function forwardTypeAVideoEvent(tabId, channel, payload) {
    if (!global.browserViewManager || !tabId) return;
    global.browserViewManager.sendToSessionView(tabId, channel, payload);
}

function forwardSessionAudioEvent(getMainWindow, channel, payload) {
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload);
    }
}

function registerStreamParamsHandlers(streamParamsManager) {
    ipcMain.handle("session:getStreamParams", (_event, sessionId) => {
        if (!streamParamsManager) {
            return { success: false, error: "Gestionnaire de paramètres indisponible" };
        }
        return streamParamsManager.getParams(sessionId);
    });

    ipcMain.handle("session:applyStreamParams", async (_event, { sessionId, params }) => {
        if (!streamParamsManager) {
            return { success: false, error: "Gestionnaire de paramètres indisponible" };
        }
        return streamParamsManager.applyParams(sessionId, params);
    });

    ipcMain.handle("session:resetStreamParams", async (_event, sessionId) => {
        if (!streamParamsManager) {
            return { success: false, error: "Gestionnaire de paramètres indisponible" };
        }
        return streamParamsManager.resetParams(sessionId);
    });

    ipcMain.handle("session:getActiveOrientation", () => {
        if (!streamParamsManager) {
            return { success: false, error: "Gestionnaire de paramètres indisponible" };
        }
        return streamParamsManager.getActiveSessionOrientation();
    });

    ipcMain.handle("session:toggleOrientation", async (_event, sessionId) => {
        if (!streamParamsManager) {
            return { success: false, error: "Gestionnaire de paramètres indisponible" };
        }
        return streamParamsManager.toggleOrientation(sessionId);
    });

    ipcMain.handle("session:getInputContext", (_event, sessionId) => {
        const entry = global.browserViewManager?.getSessionEntry(sessionId);
        if (!entry) {
            return { success: false, error: "Session introuvable." };
        }
        return {
            success: true,
            sessionId,
            deviceId: entry.deviceId || null,
            stableDeviceId: entry.stableDeviceId || null,
            type: entry.type || null,
            packageName: entry.packageName || null,
            captureRotation: entry.captureRotation || 0,
            captureOrientation: entry.captureOrientation || "landscape"
        };
    });
}

module.exports = {
    registerSessionHandlers,
    registerStreamParamsHandlers,
    setupBrowserViewVideoForwarding,
    forwardTypeAVideoEvent,
    forwardSessionAudioEvent,
    attachTabCycleHandler,
    cycleSessionTab
};
