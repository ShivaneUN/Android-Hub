function registerNewInstanceIpc({ ipcMain, manager, getWindow }) {
    async function resolveLaunchDims(serial, stableDeviceId, preresolvedDims = null, retries = 2) {
        if (!serial) return null;

        if (preresolvedDims?.width > 0 && preresolvedDims?.height > 0) {
            return { width: preresolvedDims.width, height: preresolvedDims.height };
        }

        const cached = global.readCachedDeviceDimensions?.(serial);
        if (cached?.width > 0 && cached?.height > 0) {
            return cached;
        }

        if (typeof global.resolveDeviceDimensionsForSerial === "function") {
            const dims = await global.resolveDeviceDimensionsForSerial(serial, stableDeviceId || null);
            if (dims?.width > 0 && dims?.height > 0) {
                return dims;
            }
        }

        if (!global.deviceOrientationManager) return null;

        let adbSerial = serial;
        if (typeof global.resolveAdbSerialForDims === "function") {
            adbSerial = await global.resolveAdbSerialForDims(serial, stableDeviceId || null);
        }

        for (let attempt = 0; attempt < retries; attempt += 1) {
            const dims = await global.deviceOrientationManager.getDeviceDimensions(adbSerial);
            if (dims?.width > 0 && dims?.height > 0) {
                global.writeDeviceDimensionsCache?.(serial, adbSerial, dims);
                return dims;
            }
            if (attempt < retries - 1) {
                await new Promise((resolve) => setTimeout(resolve, 350));
            }
        }
        return null;
    }

    ipcMain.handle("new-instance:create", async (_event, payload = {}) => {
        try {
            const session = manager.createNewInstanceSession(payload);
            if (payload.externalLaunchId && typeof global.getExternalLaunchLaunchDims === "function") {
                const dims = global.getExternalLaunchLaunchDims(payload.externalLaunchId);
                if (dims) {
                    session.launchDims = dims;
                }
            }
            return { success: true, session };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("new-instance:start", async (_event, { sessionId }) => {
        try {
            global.launchLatencyTracker?.mark?.({ sessionId, stage: "hubSocketStart" });
            const pending = manager.getNewInstanceSession(sessionId);
            let launchDims = null;
            if (pending?.streamOptions) {
                const { applyTypeBLaunchOrientation } = require("../../shared/stream-params");
                launchDims = await resolveLaunchDims(
                    pending.serial,
                    pending.stableDeviceId,
                    pending.launchDims
                );
                applyTypeBLaunchOrientation(
                    pending.streamOptions,
                    launchDims?.width,
                    launchDims?.height
                );
                console.log(
                    `[NewInstance] ${sessionId} orientation lock:`,
                    pending.streamOptions.captureOrientationLock || "null",
                    launchDims ? `${launchDims.width}x${launchDims.height}` : "dims-absentes"
                );
            }
            const session = await manager.startNewInstanceSession(sessionId);
            if (global.launchHistoryManager && session?.serial && session?.packageName) {
                let iconPath = null;
                let stableDeviceId = session.stableDeviceId || null;
                if (!stableDeviceId && global.deviceRegistry) {
                    stableDeviceId = await global.deviceRegistry.resolveStableDeviceIdFromTransport(session.serial);
                }
                const historyDeviceId = stableDeviceId || session.serial;
                if (global.appMetadataManager) {
                    const cached = await global.appMetadataManager.getCachedEntry(
                        historyDeviceId,
                        session.packageName,
                        session.userId,
                        { transportSerial: session.serial }
                    );
                    iconPath = cached?.iconPath || null;
                }
                global.launchHistoryManager.recordLaunch({
                    deviceId: historyDeviceId,
                    packageName: session.packageName,
                    appName: session.tabLabel || session.packageName,
                    iconPath,
                    userId: session.userId
                });
            }
            if (global.browserViewManager && session?.streamOptions) {
                const entry = global.browserViewManager.getSessionEntry(sessionId);
                if (entry) {
                    const { fromScrcpyOptions, applyTypeBLaunchOrientation } = require("../../shared/stream-params");
                    if (!launchDims && session.serial) {
                        launchDims = await resolveLaunchDims(
                            session.serial,
                            session.stableDeviceId,
                            session.launchDims
                        );
                    }
                    applyTypeBLaunchOrientation(
                        session.streamOptions,
                        launchDims?.width,
                        launchDims?.height
                    );
                    const isFirst = !entry._streamInitialized;
                    const params = fromScrcpyOptions(session.streamOptions, "B");
                    global.browserViewManager.setSessionStreamParams(sessionId, params, { asOriginal: isFirst });
                    global.browserViewManager.setSessionScrcpyOptions(sessionId, session.streamOptions);
                    global.browserViewManager.setSessionCaptureOrientation(
                        sessionId,
                        "landscape",
                        {
                            captureRotation: session.streamOptions.captureRotation || 0,
                            updateCaptureRotation: true
                        }
                    );
                    if (global.sessionStreamRegistry) {
                        global.sessionStreamRegistry.syncFromBrowserViewEntry(sessionId, entry);
                        global.sessionStreamRegistry.setScrcpyOptions(sessionId, session.streamOptions, { asOriginal: isFirst });
                    }
                }
            }

            if (session?.serial) {
                const startAudio = global.startSessionAudioPlayback;
                if (typeof startAudio === "function") {
                    void startAudio(sessionId, {
                        serial: session.serial,
                        displayId: session.displayId
                    });
                }
            }

            return {
                success: true,
                session: {
                    sessionId: session.sessionId,
                    serial: session.serial,
                    packageName: session.packageName,
                    state: session.state,
                    displayId: session.displayId
                }
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("new-instance:stop", async (_event, { sessionId }) => {
        try {
            await manager.stopNewInstanceSession(sessionId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("new-instance:list", async () => {
        try {
            return { success: true, sessions: manager.listNewInstanceSessions() };
        } catch (err) {
            return { success: false, error: err.message, sessions: [] };
        }
    });

    ipcMain.handle("new-instance:send-input", async (_event, payload = {}) => {
        if (!payload.sessionId) {
            return { success: false, error: "sessionId manquant pour new-instance:send-input" };
        }
        try {
            await manager.routeInputToSession(payload.sessionId, payload);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    manager.on("state", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:state", data);
    });

    manager.on("scrcpy-closed", (data) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("new-instance:scrcpy-closed", data);
    });
}

module.exports = { registerNewInstanceIpc };
