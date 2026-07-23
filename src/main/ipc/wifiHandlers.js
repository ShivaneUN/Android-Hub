const { collectDeviceAliasKeys } = require("./namesHandlers");

function enrichPanelEntries(entries, { namesManager, colorsManager } = {}) {
    if (!Array.isArray(entries)) return [];

    let list = entries.map((entry) => ({
        ...entry,
        serial: entry.usbSerial || entry.serial || entry.deviceId,
        deviceId: entry.deviceId || entry.serial
    }));

    if (namesManager?.applyDeviceNames) {
        list = namesManager.applyDeviceNames(list);
    }

    if (colorsManager?.getColorForDevice) {
        list = list.map((entry) => ({
            ...entry,
            deviceColor: colorsManager.getColorForDevice(entry.deviceId) || null
        }));
    }

    return list;
}

function notifyTransportReattachState(getMainWindow, payload) {
    try {
        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
            win.webContents.send("transport:reattach-state", payload);
        }
    } catch (_err) {
        // noop
    }
}

/**
 * Pose state=reconnecting sur les sessions Type B du device (garde Commit 1).
 */
function markTypeBSessionsReconnecting(getNewInstanceManager, deviceId) {
    if (!deviceId || typeof getNewInstanceManager !== "function") return;

    const manager = getNewInstanceManager();
    if (!manager?.listNewInstanceSessions || !manager?.beginTransportReconnect) return;

    const summaries = manager.listNewInstanceSessions() || [];
    for (const summary of summaries) {
        if (!summary?.sessionId) continue;
        if (summary.state === "stopped" || summary.state === "stopping") continue;

        const matches = summary.stableDeviceId === deviceId || summary.serial === deviceId;
        if (!matches) continue;

        const session = manager.getNewInstanceSession(summary.sessionId);
        if (!session) continue;

        manager.beginTransportReconnect(session);
        console.log(
            `[wifi][reattach] beginTransportReconnect session=${session.sessionId} device=${deviceId}`
        );
    }
}

function markAllSessionsReconnecting(deps, deviceId) {
    if (!deviceId) return;
    markTypeBSessionsReconnecting(deps.getNewInstanceManager, deviceId);
    if (typeof global.markTypeASessionsReconnecting === "function") {
        global.markTypeASessionsReconnecting(deviceId);
    }
    notifyTransportReattachState(deps.getMainWindow, {
        deviceId,
        phase: "start"
    });
}

function failAllSessionsReconnecting(deps, deviceId) {
    if (!deviceId) return;
    failTypeBSessionsReconnecting(deps.getNewInstanceManager, deviceId);
    if (typeof global.failTypeASessionsReconnecting === "function") {
        global.failTypeASessionsReconnecting(deviceId);
    }
    notifyTransportReattachState(deps.getMainWindow, {
        deviceId,
        phase: "error"
    });
}


function listReconnectingTypeBSessions(manager, deviceId) {
    if (!manager?.listNewInstanceSessions || !deviceId) return [];

    const out = [];
    for (const summary of manager.listNewInstanceSessions() || []) {
        if (!summary?.sessionId) continue;
        if (summary.state !== "reconnecting") continue;
        if (summary.stableDeviceId !== deviceId && summary.serial !== deviceId) continue;
        const session = manager.getNewInstanceSession(summary.sessionId);
        if (session) out.push(session);
    }
    return out;
}

function failTypeBSessionsReconnecting(getNewInstanceManager, deviceId) {
    if (!deviceId || typeof getNewInstanceManager !== "function") return;
    const manager = getNewInstanceManager();
    if (!manager?.endTransportReconnect) return;

    for (const session of listReconnectingTypeBSessions(manager, deviceId)) {
        manager.endTransportReconnect(session, { success: false });
        console.warn(
            `[wifi][reattach] endTransportReconnect fail session=${session.sessionId} device=${deviceId}`
        );
    }
}


let streamRestartGeneration = 0;

function notifySessionStreamRestarting(sessionId) {
    if (!sessionId) return;
    streamRestartGeneration += 1;
    const generation = streamRestartGeneration;
    try {
        global.browserViewManager?.sendToSessionView?.(sessionId, "stream-restarting", {
            sessionId,
            generation
        });
        const mainWin = global.browserViewManager?.mainWindow;
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("stream-restarting", { sessionId, generation });
        }
    } catch (_err) {
        // noop
    }
}

/** USB débranché en mode WiFi → reattach sur le shell WiFi si besoin. */
function handleTopologyChangeForWifiSessions(deps, unified, previousUnified = []) {
    if (!Array.isArray(unified) || unified.length === 0) return;

    const prevById = new Map(
        (previousUnified || []).map((d) => [d.deviceId, d])
    );

    for (const device of unified) {
        if (!device?.deviceId || !device.wifiEnabled || !device.wifiAvailable) continue;

        const prev = prevById.get(device.deviceId);
        const usbLost = Boolean(prev?.usbAvailable) && !device.usbAvailable;
        if (!usbLost) continue;

        console.log(
            `[wifi][topology] USB débranché device=${device.deviceId} — reattach WiFi`
        );
        markAllSessionsReconnecting(deps, device.deviceId);
        console.warn("[wifi] marked only — switchSessionTransport pending device=" + device.deviceId);
        failAllSessionsReconnecting(deps, device.deviceId);
    }
}

function registerWifiHandlers(deps) {
    const {
        ipcMain,
        getDeviceRegistry,
        getWifiAdbService,
        getWifiDevicesManager,
        getCustomNamesManager,
        getMainWindow,
        getNewInstanceManager,
        loadHistory,
        removeDeviceFromHistory,
        refreshDeviceList,
        syncDevicesForUi
    } = deps;

    const reattachDeps = {
        getNewInstanceManager,
        getDeviceRegistry,
        getMainWindow,
        getWifiDevicesManager
    };

    /** Évite ON/OFF concurrents (double toggle home+sidebar, IPC en vol). */
    const wifiToggleInFlight = new Map();
    /** Anti-rebond : ignore un WiFi ON immédiat après un OFF réussi. */
    const wifiOffCooldownUntil = new Map();

    const registry = typeof getDeviceRegistry === "function" ? getDeviceRegistry() : null;
    if (registry) {
        let topologyTimer = null;
        registry.onTopologyChange = (unified, previousUnified) => {
            if (topologyTimer) clearTimeout(topologyTimer);
            topologyTimer = setTimeout(() => {
                handleTopologyChangeForWifiSessions(reattachDeps, unified, previousUnified);
            }, 400);
        };
    }

    ipcMain.handle("wifi:list-config", async () => {
        const manager = getWifiDevicesManager();
        const registry = getDeviceRegistry();
        const raw = await registry.getRawAdbDevices();
        const configs = manager.list();

        const usbHistory = configs.map((config) => {
            const usbSeen = raw.some((d) => {
                return !getWifiAdbService().isWifiSerial(d.serial) && d.serial;
            });
            return {
                ...config,
                type: "wifi",
                connected: raw.some((d) => d.serial === getWifiAdbService().buildWifiSerial(config.ip, config.port)),
                adbTarget: getWifiAdbService().buildWifiSerial(config.ip, config.port)
            };
        });

        return { success: true, wifi: usbHistory, usb: [] };
    });

    ipcMain.handle("devices:discover", async () => {
        const registry = getDeviceRegistry();
        if (!registry?.discoverNewDevices) {
            return { success: false, error: "Recherche d'appareils indisponible" };
        }

        try {
            const history = loadHistory?.() || {};
            const discovery = await registry.discoverNewDevices(history);
            if (typeof syncDevicesForUi === "function") {
                await syncDevicesForUi();
            }
            await refreshDeviceList?.();
            return { success: true, ...discovery };
        } catch (err) {
            console.error("[devices:discover]", err.message);
            return { success: false, error: err.message || "Recherche impossible" };
        }
    });

    ipcMain.handle("wifi:panel-data", async () => {
        const registry = getDeviceRegistry();
        if (!registry?.buildDevicesPanelData) {
            return { success: true, wifi: [], usb: [] };
        }

        const history = loadHistory?.() || {};
        const panel = await registry.buildDevicesPanelData(history);
        const namesManager = getCustomNamesManager();
        const colorsManager = global.deviceColorsManager;

        return {
            success: true,
            usb: enrichPanelEntries(panel.usb, { namesManager, colorsManager }),
            wifi: enrichPanelEntries(panel.wifi, { namesManager, colorsManager })
        };
    });

    async function resolveToggleUsbSerial(registry, { deviceId, usbSerial, config } = {}) {
        if (!registry?.resolveLiveUsbSerial) return usbSerial || null;
        const targetDeviceId = deviceId || config?.deviceId || null;
        return registry.resolveLiveUsbSerial({
            deviceId: targetDeviceId,
            preferredSerial: usbSerial || config?.usbSerialHint || null
        });
    }

    async function removeDevicePanelEntry(deviceId) {
        removeDeviceFromHistory?.(deviceId);

        const wifiManager = getWifiDevicesManager();
        const wifiService = getWifiAdbService();
        const entry = wifiManager.getByDeviceId(deviceId);

        if (entry) {
            wifiManager.setWifiEnabled(deviceId, false);
            if (entry.ip) {
                await wifiService.disconnect(
                    wifiService.buildWifiSerial(entry.ip, entry.port || 5555)
                );
            }
            wifiManager.remove(deviceId);
        }

        await refreshDeviceList();
        return { success: true };
    }

    ipcMain.handle("wifi:toggle", async (_event, { deviceId, enabled, usbSerial, name } = {}) => {
        const registry = getDeviceRegistry();
        const wifiService = getWifiAdbService();
        const wifiManager = getWifiDevicesManager();
        const namesManager = getCustomNamesManager();

        if (!deviceId && !usbSerial) {
            return { success: false, error: "Appareil introuvable.", step: "init" };
        }

        const lockKey = String(deviceId || usbSerial || "").trim();
        if (lockKey && wifiToggleInFlight.has(lockKey)) {
            console.warn(
                `[wifi:toggle] ignored (in-flight) device=${lockKey} enabled=${Boolean(enabled)}`
            );
            return {
                success: false,
                error: "Basculement WiFi déjà en cours.",
                step: "busy"
            };
        }
        if (enabled && lockKey) {
            const coolUntil = wifiOffCooldownUntil.get(lockKey) || 0;
            if (Date.now() < coolUntil) {
                console.warn(
                    `[wifi:toggle] ignored (post-OFF cooldown) device=${lockKey}`
                );
                return {
                    success: false,
                    error: "Basculement WiFi trop rapide après coupure.",
                    step: "cooldown"
                };
            }
        }
        if (lockKey) wifiToggleInFlight.set(lockKey, Boolean(enabled));
        console.log(`[wifi:toggle] start device=${lockKey || "?"} enabled=${Boolean(enabled)}`);

        const progress = [];

        try {
            if (enabled) {
                let config = deviceId ? wifiManager.getByDeviceId(deviceId) : null;
                let resolvedDeviceId = deviceId || null;

                if (!config) {
                    const liveUsbSerial = await resolveToggleUsbSerial(registry, { deviceId, usbSerial });
                    if (!liveUsbSerial) {
                        return {
                            success: false,
                            error: "Branchez l'appareil en USB pour la première configuration WiFi.",
                            step: "usb"
                        };
                    }

                    const setup = await wifiService.setupFirstConnection(liveUsbSerial, (step, message) => {
                        progress.push({ step, message });
                    });

                    resolvedDeviceId = setup.deviceId;
                    const displayName = name || setup.deviceId;

                    config = wifiManager.upsert({
                        deviceId: setup.deviceId,
                        name: displayName,
                        ip: setup.ip,
                        port: setup.port,
                        wifiEnabled: true,
                        usbSerialHint: liveUsbSerial,
                        lastSeen: new Date().toISOString()
                    }).entry;

                    if (namesManager) {
                        namesManager.ensureDeviceOriginal(resolvedDeviceId, displayName);
                        if (name) {
                            const aliasKeys = collectDeviceAliasKeys(resolvedDeviceId, liveUsbSerial);
                            namesManager.setDeviceCustomName(
                                resolvedDeviceId,
                                displayName,
                                name,
                                aliasKeys
                            );
                        }
                    }

                    await refreshDeviceList();

                    return {
                        success: true,
                        firstSetup: true,
                        deviceId: resolvedDeviceId,
                        ip: setup.ip,
                        progress,
                        message: `Connecté en WiFi — ${setup.ip}`
                    };
                }

                const targetDeviceId = resolvedDeviceId || config.deviceId;
                const liveUsbSerial = await resolveToggleUsbSerial(registry, {
                    deviceId: targetDeviceId,
                    usbSerial,
                    config
                });

                wifiManager.setWifiEnabled(targetDeviceId, true);
                try {
                    await wifiService.reconnectSaved(targetDeviceId, {
                        usbSerial: liveUsbSerial || undefined
                    });
                    // Course OFF concurrent : abandonner le retour WiFi.
                    if (!wifiManager.getByDeviceId(targetDeviceId)?.wifiEnabled) {
                        console.warn(
                            `[wifi:toggle] ON annulé (wifiEnabled=false) device=${targetDeviceId}`
                        );
                        if (config.ip || wifiManager.getByDeviceId(targetDeviceId)?.ip) {
                            const ip = wifiManager.getByDeviceId(targetDeviceId)?.ip || config.ip;
                            const port = wifiManager.getByDeviceId(targetDeviceId)?.port || config.port || 5555;
                            await wifiService.disconnect(wifiService.buildWifiSerial(ip, port));
                        }
                        await refreshDeviceList();
                        return {
                            success: false,
                            error: "Basculement WiFi annulé.",
                            step: "cancelled",
                            deviceId: targetDeviceId
                        };
                    }
                    wifiManager.touchLastSeen(targetDeviceId);
                    await refreshDeviceList();

                    // USB encore branché : ne pas basculer les sessions sur WiFi.
                    // Le stream reste USB ; le reattach WiFi se fait au débranchement (topology).
                    const usbStillPlugged = Boolean(
                        liveUsbSerial
                        || (await registry.resolveLiveUsbSerial?.({ deviceId: targetDeviceId }))
                    );
                    if (usbStillPlugged) {
                        console.log(
                            `[wifi:toggle] USB branché — WiFi armé, sessions restent sur USB device=${targetDeviceId}`
                        );
                    } else {
                        markAllSessionsReconnecting(reattachDeps, targetDeviceId);
                        console.warn("[wifi] marked only — switchSessionTransport pending device=" + targetDeviceId);
                        failAllSessionsReconnecting(reattachDeps, targetDeviceId);
                    }
                } catch (switchErr) {
                    failAllSessionsReconnecting(reattachDeps, targetDeviceId);
                    throw switchErr;
                }

                const updated = wifiManager.getByDeviceId(targetDeviceId);
                const usbStill = Boolean(
                    liveUsbSerial
                    || (await registry.resolveLiveUsbSerial?.({ deviceId: targetDeviceId }))
                );

                return {
                    success: true,
                    deviceId: targetDeviceId,
                    progress: [{ step: "connect", message: "Connexion..." }],
                    message: usbStill
                        ? `WiFi prêt (${updated?.ip || config.ip}) — stream USB jusqu'au débranchement`
                        : `Connecté en WiFi — ${updated?.ip || config.ip}`
                };
            }

            if (!deviceId) {
                return { success: false, error: "deviceId requis.", step: "off" };
            }

            const config = wifiManager.getByDeviceId(deviceId);
            if (config) {
                wifiManager.setWifiEnabled(deviceId, false);
                try {
                    const usbStillPlugged = Boolean(
                        await registry.resolveLiveUsbSerial?.({ deviceId })
                    );
                    if (usbStillPlugged) {
                        // Sessions déjà sur USB — pas de reattach, juste coupe ADB WiFi.
                        console.log(
                            `[wifi:toggle] USB branché — WiFi OFF sans reattach device=${deviceId}`
                        );
                        if (config.ip) {
                            await wifiService.disconnect(
                                wifiService.buildWifiSerial(config.ip, config.port || 5555)
                            );
                        }
                        await refreshDeviceList();
                    } else {
                        markAllSessionsReconnecting(reattachDeps, deviceId);
                        console.warn("[wifi] marked only — switchSessionTransport pending device=" + deviceId);
                        failAllSessionsReconnecting(reattachDeps, deviceId);
                        await refreshDeviceList();
                        if (config.ip) {
                            await wifiService.disconnect(
                                wifiService.buildWifiSerial(config.ip, config.port || 5555)
                            );
                            await refreshDeviceList();
                        }
                    }
                    console.log(`[wifi] disconnect WiFi OK device=${deviceId} (mode USB)`);
                } catch (switchErr) {
                    failAllSessionsReconnecting(reattachDeps, deviceId);
                    throw switchErr;
                }
            } else {
                await refreshDeviceList();
            }

            return {
                success: true,
                deviceId,
                wifiEnabled: false,
                message: "WiFi déconnecté"
            };
        } catch (err) {
            const message = String(err.message || err);
            let step = "unknown";
            if (/tcpip|activer/i.test(message)) step = "tcpip";
            else if (/IP introuvable/i.test(message)) step = "ip";
            else if (/connect|réseau|Timeout/i.test(message)) step = "connect";

            if (deviceId) {
                wifiManager.setWifiEnabled(deviceId, false);
                failAllSessionsReconnecting(reattachDeps, deviceId);
            }

            return { success: false, error: message, step, progress };
        } finally {
            if (lockKey) {
                wifiToggleInFlight.delete(lockKey);
                // Cooldown seulement après un OFF demandé (pas après erreur ON).
                if (enabled === false) {
                    wifiOffCooldownUntil.set(lockKey, Date.now() + 2500);
                }
            }
        }
    });

    ipcMain.handle("wifi:rename", (_event, { deviceId, name } = {}) => {
        const wifiManager = getWifiDevicesManager();
        const namesManager = getCustomNamesManager();
        const result = wifiManager.rename(deviceId, name);
        if (result.success && namesManager) {
            const entry = wifiManager.getByDeviceId(deviceId);
            const aliasKeys = collectDeviceAliasKeys(deviceId, entry?.usbSerialHint);
            namesManager.setDeviceCustomName(
                deviceId,
                entry?.name || deviceId,
                name,
                aliasKeys
            );
        }
        void refreshDeviceList();
        return result;
    });

    ipcMain.handle("devices:panel-remove", async (_event, { deviceId } = {}) => {
        if (!deviceId) {
            return { success: false, error: "deviceId requis." };
        }

        try {
            return await removeDevicePanelEntry(deviceId);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("wifi:remove", async (_event, { deviceId } = {}) => {
        if (!deviceId) {
            return { success: false, error: "deviceId requis." };
        }

        try {
            return await removeDevicePanelEntry(deviceId);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("wifi:reconnect", async (_event, { deviceId } = {}) => {
        const registry = getDeviceRegistry();
        const wifiService = getWifiAdbService();
        const wifiManager = getWifiDevicesManager();
        const config = wifiManager.getByDeviceId(deviceId);

        if (!config) {
            return { success: false, error: "Configuration WiFi introuvable." };
        }

        try {
            const liveUsbSerial = await resolveToggleUsbSerial(registry, {
                deviceId,
                config
            });

            wifiManager.setWifiEnabled(deviceId, true);
            markAllSessionsReconnecting(reattachDeps, deviceId);
            try {
                const wifiSerial = await wifiService.reconnectSaved(deviceId, {
                    usbSerial: liveUsbSerial || undefined
                });
                wifiManager.touchLastSeen(deviceId);
                await refreshDeviceList();
                console.warn("[wifi] marked only — switchSessionTransport pending device=" + deviceId);
                failAllSessionsReconnecting(reattachDeps, deviceId);

                return {
                    success: true,
                    wifiSerial,
                    message: `Connecté en WiFi — ${wifiManager.getByDeviceId(deviceId)?.ip || config.ip}`
                };
            } catch (err) {
                failAllSessionsReconnecting(reattachDeps, deviceId);
                return { success: false, error: err.message };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("device:resolve-serial", (_event, { deviceId, serial } = {}) => {
        const registry = getDeviceRegistry();
        const resolved = registry.resolveAdbSerial({ deviceId, serial });
        return { success: Boolean(resolved), serial: resolved };
    });
}

module.exports = { registerWifiHandlers };
