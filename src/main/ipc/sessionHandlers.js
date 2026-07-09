const { ipcMain } = require("electron");
const { exec } = require("child_process");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

let adbPathRef = null;
let getVideoClientRef = null;
let getNewInstanceManagerRef = null;

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
        if (input.key !== "Tab") return;

        event.preventDefault();
        cycleSessionTab(input.shift ? "prev" : "next");
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

    ipcMain.handle("session:close", async (_event, sessionId) => {
        const manager = getNewInstanceManager?.();
        const entry = global.browserViewManager?.getSessionEntry(sessionId);
        const isAppInstance = sessionId.startsWith("new-instance-") || entry?.type === "B";
        const serial = entry?.deviceId || null;
        const wasPortrait = entry?.captureOrientation === "portrait";

        if (getVideoClientRef?.(sessionId) && stopVideoStream) {
            try {
                await stopVideoStream(sessionId);
            } catch (err) {
                console.warn("[session:close] arret flux:", err?.message || err);
            }
        }

        if (global.sessionAudioProcessManager) {
            try {
                await global.sessionAudioProcessManager.stop(sessionId);
            } catch (err) {
                console.warn("[session:close] arret audio:", err?.message || err);
            }
        }

        if (manager && isAppInstance) {
            try {
                await manager.ensureAppStoppedForSessionClose(sessionId);
            } catch (err) {
                console.warn("[session:close] arret appareil:", err.message);
            }
        }

        const result = global.browserViewManager.closeSessionView(sessionId);
        if (result) {
            global.sessionStreamRegistry?.remove(sessionId);
            global.streamParamsManager?.notifySessionListChanged();
        }

        if (wasPortrait && serial && global.deviceOrientationManager) {
            try {
                const adbSerial = await resolveEntryAdbSerial(entry, sessionId) || serial;
                await global.deviceOrientationManager.applyOrientation(adbSerial, "landscape");
                global.deviceOrientationManager.clearSavedState(adbSerial);
            } catch (err) {
                console.warn("[session:close] restauration orientation:", err?.message || err);
            }
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
                if (entry && entry.label !== session.label) {
                    manager.updateSessionMetadata(session.sessionId, { label: session.label });
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

    ipcMain.handle("session:getActiveTypeA", () => {
        const session = global.browserViewManager.getActiveTypeASession();
        return { success: true, session };
    });

    ipcMain.handle("session:toggleScreen", async (_event, sessionId) => {
        const manager = global.browserViewManager;
        if (!manager) {
            return { success: false, error: "BrowserViewManager indisponible" };
        }

        const targetId = sessionId || manager.getActiveSessionId();
        const entry = manager.getSessionEntry(targetId);
        if (!entry) {
            return { success: false, error: "Session introuvable" };
        }
        if (entry.type !== "A") {
            return { success: false, error: "Disponible uniquement pour les sessions Type A" };
        }
        if (!entry.deviceId) {
            return { success: false, error: "Aucun appareil associe a cette session" };
        }

        const turningOff = !entry.screenOff;
        const adbSerial = await resolveEntryAdbSerial(entry, targetId);

        try {
            if (turningOff && !entry.stayAwakeActive && adbSerial) {
                await runAdbShell(adbSerial, "svc power stayon true");
                manager.setSessionStayAwake(targetId, true);
            }

            const client = getVideoClientRef ? getVideoClientRef(targetId) : null;
            if (!client || typeof client.setDisplayPower !== "function") {
                return { success: false, error: "Flux scrcpy introuvable pour cette session" };
            }

            await client.setDisplayPower(!turningOff);
            manager.setSessionScreenOff(targetId, turningOff);

            return {
                success: true,
                sessionId: targetId,
                screenOff: turningOff,
                deviceId: entry.deviceId
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
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

        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
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

    ipcMain.handle("session:applyStreamParamsToAll", async (_event, { params } = {}) => {
        if (!streamParamsManager) {
            return { success: false, error: "Gestionnaire de paramètres indisponible" };
        }
        return streamParamsManager.applyParamsToAllSessions(params);
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
