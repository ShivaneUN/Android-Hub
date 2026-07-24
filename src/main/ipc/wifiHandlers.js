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

function collectDeviceTransportAliases(deviceId, extra = []) {
    const aliases = new Set(
        [deviceId, ...(Array.isArray(extra) ? extra : [])]
            .map((value) => (value == null ? "" : String(value).trim()))
            .filter(Boolean)
    );
    try {
        const cfg = global.wifiDevicesManager?.getByDeviceId?.(deviceId);
        if (cfg?.deviceId) aliases.add(String(cfg.deviceId));
        if (cfg?.usbSerialHint) aliases.add(String(cfg.usbSerialHint));
        if (cfg?.ip) {
            const wifiSerial = global.wifiAdbService?.buildWifiSerial?.(cfg.ip, cfg.port || 5555);
            if (wifiSerial) aliases.add(String(wifiSerial));
        }
    } catch (_err) {
        // noop
    }
    return aliases;
}

/**
 * Pose state=reconnecting sur les sessions Type B du device (garde Commit 1).
 */
function markTypeBSessionsReconnecting(getNewInstanceManager, deviceId, extraAliases = []) {
    if (!deviceId || typeof getNewInstanceManager !== "function") return;

    const manager = getNewInstanceManager();
    if (!manager?.listNewInstanceSessions || !manager?.beginTransportReconnect) return;

    const aliases = collectDeviceTransportAliases(deviceId, extraAliases);

    const summaries = manager.listNewInstanceSessions() || [];
    for (const summary of summaries) {
        if (!summary?.sessionId) continue;
        if (summary.state === "stopped" || summary.state === "stopping") continue;

        const matches = aliases.has(String(summary.stableDeviceId || ""))
            || aliases.has(String(summary.serial || ""));
        if (!matches) continue;

        const session = manager.getNewInstanceSession(summary.sessionId);
        if (!session) continue;

        manager.beginTransportReconnect(session);
        console.log(
            `[wifi][reattach] beginTransportReconnect session=${session.sessionId} device=${deviceId}`
        );
    }
}

function markAllSessionsReconnecting(deps, deviceId, { silent = false, extraAliases = [] } = {}) {
    if (!deviceId) return;
    markTypeBSessionsReconnecting(deps.getNewInstanceManager, deviceId, extraAliases);
    if (typeof global.markTypeASessionsReconnecting === "function") {
        global.markTypeASessionsReconnecting(deviceId);
    }
    if (!silent) {
        notifyTransportReattachState(deps.getMainWindow, {
            deviceId,
            phase: "start"
        });
    }
}

function failAllSessionsReconnecting(deps, deviceId, { silent = false } = {}) {
    if (!deviceId) return;
    failTypeBSessionsReconnecting(deps.getNewInstanceManager, deviceId);
    if (typeof global.failTypeASessionsReconnecting === "function") {
        global.failTypeASessionsReconnecting(deviceId);
    }
    if (!silent) {
        notifyTransportReattachState(deps.getMainWindow, {
            deviceId,
            phase: "error"
        });
    }
}


function listReconnectingTypeBSessions(manager, deviceId, extraAliases = []) {
    if (!manager?.listNewInstanceSessions || !deviceId) return [];

    const aliases = collectDeviceTransportAliases(deviceId, extraAliases);

    const out = [];
    for (const summary of manager.listNewInstanceSessions() || []) {
        if (!summary?.sessionId) continue;
        if (summary.state !== "reconnecting") continue;
        if (
            !aliases.has(String(summary.stableDeviceId || ""))
            && !aliases.has(String(summary.serial || ""))
        ) {
            continue;
        }
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

function notifyTransportUsbUnplugged(getMainWindow, payload) {
    try {
        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
            win.webContents.send("transport:usb-unplugged", payload);
        }
    } catch (_err) {
        // noop
    }
}

function notifyTransportUsbRegained(getMainWindow, payload) {
    try {
        const win = typeof getMainWindow === "function" ? getMainWindow() : null;
        if (win && !win.isDestroyed()) {
            win.webContents.send("transport:usb-regained", payload);
        }
    } catch (_err) {
        // noop
    }
}

function deviceHasActiveHubSessions(getNewInstanceManager, deviceId, aliases = []) {
    if (!deviceId && (!aliases || aliases.length === 0)) return false;

    const ids = new Set(
        [deviceId, ...(Array.isArray(aliases) ? aliases : [])]
            .map((value) => (value == null ? "" : String(value).trim()))
            .filter(Boolean)
    );
    if (ids.size === 0) return false;

    const sessions = global.browserViewManager?.getAllSessions?.() || [];
    for (const summary of sessions) {
        if (
            ids.has(summary?.stableDeviceId)
            || ids.has(summary?.deviceId)
            || ids.has(summary?.serial)
            || ids.has(summary?.sessionId)
        ) {
            return true;
        }
    }

    const expectedWifiSerials = new Set();
    for (const id of ids) {
        const cfg = global.wifiDevicesManager?.getByDeviceId?.(id);
        if (!cfg?.ip) continue;
        const serial = global.wifiAdbService?.buildWifiSerial?.(cfg.ip, cfg.port || 5555);
        if (serial) expectedWifiSerials.add(serial);
    }

    const manager = typeof getNewInstanceManager === "function" ? getNewInstanceManager() : null;
    for (const summary of manager?.listNewInstanceSessions?.() || []) {
        if (summary.state === "stopped" || summary.state === "stopping") continue;
        if (
            ids.has(summary.stableDeviceId)
            || ids.has(summary.serial)
            || expectedWifiSerials.has(summary.serial)
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Destroy+recreate Type A+B vers newSerial (WiFi ou USB).
 * @param {{ silent?: boolean }} [options] — silent=true : pas d'overlay (4d USB rebranché).
 * @returns {{ success: boolean, error?: string }}
 */
async function switchDeviceSessionsToSerial(deps, deviceId, newSerial, { silent = false, extraAliases = [] } = {}) {
    if (!deviceId || !newSerial) {
        return { success: false, error: "deviceId ou serial manquant" };
    }

    markAllSessionsReconnecting(deps, deviceId, { silent, extraAliases });

    let typeAOk = true;
    let typeACount = 0;
    if (typeof global.switchTypeASessionsForDevice === "function") {
        const typeAResult = await global.switchTypeASessionsForDevice(deviceId, newSerial);
        typeAOk = typeAResult?.success !== false;
        typeACount = typeAResult?.count ?? 0;
        console.log(
            `[switchSessionTransport] Type A device done ok=${typeAOk} count=${typeACount} serial=${newSerial} silent=${silent}`
        );
    } else {
        console.warn("[switchSessionTransport] Type A — switchTypeASessionsForDevice indisponible");
        typeAOk = false;
    }

    let typeBOk = true;
    let typeBCount = 0;
    const niManager = typeof deps.getNewInstanceManager === "function"
        ? deps.getNewInstanceManager()
        : null;
    if (typeof niManager?.switchTypeBSessionsForDevice === "function") {
        const typeBResult = await niManager.switchTypeBSessionsForDevice(deviceId, newSerial, {
            extraAliases
        });
        typeBOk = typeBResult?.success !== false;
        typeBCount = typeBResult?.count ?? 0;
        console.log(
            `[switchSessionTransport] Type B device done ok=${typeBOk} count=${typeBCount} serial=${newSerial} silent=${silent}`
        );
    } else {
        console.warn("[switchSessionTransport] Type B — switchTypeBSessionsForDevice indisponible");
        failTypeBSessionsReconnecting(deps.getNewInstanceManager, deviceId);
        typeBOk = false;
    }

    if (typeAOk && typeBOk) {
        notifyTransportReattachState(deps.getMainWindow, {
            deviceId,
            phase: "end",
            silent: Boolean(silent)
        });
        return { success: true, typeACount, typeBCount };
    }

    if (!typeAOk && typeof global.failTypeASessionsReconnecting === "function") {
        global.failTypeASessionsReconnecting(deviceId);
    }
    if (!typeBOk) {
        failTypeBSessionsReconnecting(deps.getNewInstanceManager, deviceId);
    }
    notifyTransportReattachState(deps.getMainWindow, {
        deviceId,
        phase: "error",
        silent: Boolean(silent)
    });
    return { success: false, error: "Échec switchSessionTransport", typeACount, typeBCount };
}

async function switchDeviceSessionsToWifi(deps, deviceId, newSerial) {
    return switchDeviceSessionsToSerial(deps, deviceId, newSerial, { silent: false });
}

/**
 * Résout le serial WiFi (reconnect ADB si besoin) pour Continuer / auto-4c.
 * Ne renvoie un serial que s'il est réellement online (évite switch sur IP fantôme).
 * @returns {Promise<string|null>}
 */
async function resolveWifiSerialForDevice(deps, deviceId, { usbSerialHint = null } = {}) {
    if (!deviceId) return null;
    const wifiManager = typeof deps.getWifiDevicesManager === "function"
        ? deps.getWifiDevicesManager()
        : null;
    const wifiService = typeof deps.getWifiAdbService === "function"
        ? deps.getWifiAdbService()
        : null;
    const registry = typeof deps.getDeviceRegistry === "function"
        ? deps.getDeviceRegistry()
        : null;
    const config = wifiManager?.getByDeviceId?.(deviceId);
    if (!config || !wifiService) return null;

    // Ne passer l'USB que s'il est encore joignable (après unplug → null).
    let liveUsb = null;
    if (usbSerialHint && typeof wifiService.isAdbOnline === "function") {
        try {
            if (await wifiService.isAdbOnline(usbSerialHint)) {
                liveUsb = usbSerialHint;
            }
        } catch (_err) {
            // noop
        }
    }

    let newSerial = null;
    try {
        newSerial = await wifiService.reconnectSaved(deviceId, {
            usbSerial: liveUsb || undefined
        });
    } catch (err) {
        console.warn(`[wifi] resolveWifiSerial reconnectSaved:`, err?.message || err);
    }

    if (!newSerial && (config.ip || wifiManager.getByDeviceId?.(deviceId)?.ip)) {
        const updated = wifiManager.getByDeviceId?.(deviceId) || config;
        const ip = updated.ip || config.ip;
        const port = updated.port || config.port || 5555;
        try {
            newSerial = await wifiService.connectWithRetry(ip, port);
        } catch (err) {
            console.warn(`[wifi] resolveWifiSerial connectWithRetry:`, err?.message || err);
        }
    }

    if (!newSerial && typeof registry?.resolveEffectiveAdbSerial === "function") {
        try {
            newSerial = await registry.resolveEffectiveAdbSerial({ deviceId });
        } catch (_err) {
            // noop
        }
    }

    if (!newSerial) return null;

    // Garde-fou : ne jamais basculer vers un serial offline.
    if (typeof wifiService.isAdbOnline === "function") {
        try {
            if (!(await wifiService.isAdbOnline(newSerial))) {
                console.warn(
                    `[wifi] resolveWifiSerial — ${newSerial} offline, abandon`
                );
                return null;
            }
        } catch (_err) {
            return null;
        }
    }

    return newSerial;
}

/** USB débranché / rebranché — 4c prompt, 4d bascule silencieuse vers USB. */
async function handleTopologyChangeForWifiSessions(deps, unified, previousUnified = []) {
    if (!Array.isArray(unified)) return;

    const prevList = Array.isArray(previousUnified) ? previousUnified : [];
    const prevById = new Map(prevList.map((d) => [d.deviceId, d]));
    const currById = new Map(
        (unified || []).filter((d) => d?.deviceId).map((d) => [d.deviceId, d])
    );
    const registry = typeof deps.getDeviceRegistry === "function"
        ? deps.getDeviceRegistry()
        : null;
    const wifiManager = typeof deps.getWifiDevicesManager === "function"
        ? deps.getWifiDevicesManager()
        : null;
    const wifiService = typeof deps.getWifiAdbService === "function"
        ? deps.getWifiAdbService()
        : null;

    const sessionAliasesFor = (prev, curr) => ([
        prev?.deviceId,
        prev?.serial,
        prev?.usbSerial,
        prev?.wifiSerial,
        curr?.deviceId,
        curr?.serial,
        curr?.usbSerial,
        curr?.wifiSerial
    ]);

    // 4c — USB débranché + sessions Hub :
    // 1) bascule auto vers WiFi
    // 2) popup Continuer (garder WiFi) / Déconnecter (couper tout, pas de WiFi)
    for (const prev of prevList) {
        if (!prev?.deviceId || !prev.usbAvailable) continue;
        const curr = currById.get(prev.deviceId) || null;
        const usbLost = !curr || !curr.usbAvailable;
        if (!usbLost) continue;

        const aliases = sessionAliasesFor(prev, curr);
        if (!deviceHasActiveHubSessions(deps.getNewInstanceManager, prev.deviceId, aliases)) {
            console.log(
                `[wifi][topology] USB débranché device=${prev.deviceId} — aucune session Hub, ignore`
            );
            continue;
        }

        const device = curr || prev;
        const cfg = wifiManager?.getByDeviceId?.(prev.deviceId) || null;
        const alreadyOnWifi = typeof global.deviceHubSessionsOnWifiShell === "function"
            && global.deviceHubSessionsOnWifiShell(prev.deviceId);

        console.log(
            `[wifi][topology] USB débranché device=${prev.deviceId} — auto WiFi + prompt`
            + ` alreadyOnWifi=${alreadyOnWifi} hasWifiConfig=${Boolean(cfg)}`
        );

        // Prompt tout de suite (l'utilisateur lit pendant connect/switch).
        notifyTransportUsbUnplugged(deps.getMainWindow, {
            deviceId: prev.deviceId,
            deviceName: device.name || prev.name || prev.deviceId,
            wifiSerial: device.wifiSerial || prev.wifiSerial || device.serial || null
        });

        // Bascule auto WiFi (sauf si les sessions y sont déjà).
        if (!alreadyOnWifi) {
            try {
                if (wifiManager?.setWifiEnabled && cfg) {
                    wifiManager.setWifiEnabled(prev.deviceId, true);
                }
                const newSerial = await resolveWifiSerialForDevice(deps, prev.deviceId, {
                    // USB déjà parti — ne pas forcer le hint mort (bloquait adb connect IP).
                    usbSerialHint: null
                });
                if (newSerial) {
                    // refreshDeviceList en parallèle du switch (ne bloque pas le flux).
                    const refreshPromise = typeof deps.refreshDeviceList === "function"
                        ? deps.refreshDeviceList().catch(() => {})
                        : Promise.resolve();
                    await switchDeviceSessionsToSerial(deps, prev.deviceId, newSerial, {
                        silent: true,
                        extraAliases: aliases
                    });
                    void refreshPromise;
                } else {
                    console.warn(
                        `[wifi][topology] auto WiFi — ADB WiFi offline device=${prev.deviceId} `
                        + `(prompt affiché ; Continuer réessaiera)`
                    );
                }
            } catch (err) {
                console.warn(
                    `[wifi][topology] auto WiFi device=${prev.deviceId}:`,
                    err?.message || err
                );
                failAllSessionsReconnecting(deps, prev.deviceId, { silent: true });
            }
        } else if (wifiManager?.setWifiEnabled && cfg && !cfg.wifiEnabled) {
            // Sessions déjà sur WiFi : aligner le toggle.
            wifiManager.setWifiEnabled(prev.deviceId, true);
        }
    }

    if (!Array.isArray(unified) || unified.length === 0) return;

    for (const device of unified) {
        if (!device?.deviceId) continue;

        const prev = prevById.get(device.deviceId);
        const usbRegained = Boolean(!prev?.usbAvailable) && Boolean(device.usbAvailable);

        // 4d — USB revenu → transport USB (+ switch sessions si shell WiFi).
        // Doit aussi marcher sans aucune session ouverte (toggle / wifiEnabled → USB).
        // Après retour USB : couper ADB WiFi (pas seulement désarmer le JSON).
        if (!usbRegained) continue;

        notifyTransportUsbRegained(deps.getMainWindow, { deviceId: device.deviceId });

        const prevCfg = wifiManager?.getByDeviceId?.(device.deviceId) || null;
        // Lire AVANT markUiUsbImmediate (qui pose wifiEnabled=false).
        const wasWifiEnabled = Boolean(prevCfg?.wifiEnabled || prev?.wifiEnabled);
        const aliases = sessionAliasesFor(prev, device);
        const hasSessions = deviceHasActiveHubSessions(
            deps.getNewInstanceManager,
            device.deviceId,
            aliases
        );
        const onWifiShell = hasSessions
            && typeof global.deviceHubSessionsOnWifiShell === "function"
            && global.deviceHubSessionsOnWifiShell(device.deviceId);

        /** UI immédiate (toggle/label USB) — avant le switch sessions. */
        const markUiUsbImmediate = () => {
            const config = wifiManager?.getByDeviceId?.(device.deviceId) || null;
            if (wifiManager?.setWifiEnabled && config?.wifiEnabled) {
                wifiManager.setWifiEnabled(device.deviceId, false);
            }
            notifyTransportReattachState(deps.getMainWindow, {
                deviceId: device.deviceId,
                phase: "end",
                silent: true
            });
        };

        const disconnectWifiAdb = async () => {
            const config = wifiManager?.getByDeviceId?.(device.deviceId) || null;
            const wifiSerial = device.wifiSerial
                || (config?.ip
                    ? wifiService?.buildWifiSerial?.(config.ip, config.port || 5555)
                    : null)
                || (device.wifiIp
                    ? wifiService?.buildWifiSerial?.(device.wifiIp, device.wifiPort || 5555)
                    : null);

            if (wifiSerial && wifiService?.disconnect) {
                try {
                    await wifiService.disconnect(wifiSerial);
                    console.log(
                        `[wifi][topology] USB rebranché device=${device.deviceId} — adb disconnect ${wifiSerial}`
                    );
                } catch (err) {
                    console.warn(
                        `[wifi][topology] disconnect WiFi device=${device.deviceId}:`,
                        err?.message || err
                    );
                }
            }

            if (typeof deps.refreshDeviceList === "function") {
                try {
                    await deps.refreshDeviceList();
                } catch (_err) {
                    // noop
                }
            }

            console.log(
                `[wifi][topology] USB rebranché device=${device.deviceId} — WiFi coupé (toggle → USB)`
            );
            notifyTransportReattachState(deps.getMainWindow, {
                deviceId: device.deviceId,
                phase: "end",
                silent: true
            });
        };

        // Feedback UI tout de suite (comme le toggle USB→WiFi), switch ensuite.
        markUiUsbImmediate();

        // Switch si sessions sur shell WiFi, OU WiFi était armé (sessions Type B parfois mal détectées).
        const shouldSwitchToUsb = hasSessions && (onWifiShell || wasWifiEnabled);
        if (!shouldSwitchToUsb) {
            console.log(
                `[wifi][topology] USB rebranché device=${device.deviceId} — `
                + (hasSessions ? "sessions déjà hors WiFi" : "aucune session Hub")
                + " — bascule USB + disconnect WiFi"
            );
            await disconnectWifiAdb();
            continue;
        }

        let usbSerial = device.usbSerial || null;
        if (!usbSerial && registry?.resolveLiveUsbSerial) {
            try {
                usbSerial = await registry.resolveLiveUsbSerial({ deviceId: device.deviceId });
            } catch (err) {
                console.warn(
                    `[wifi][topology] resolveLiveUsbSerial device=${device.deviceId}:`,
                    err?.message || err
                );
            }
        }
        if (!usbSerial) {
            console.warn(
                `[wifi][topology] USB rebranché device=${device.deviceId} — serial USB introuvable`
            );
            // Ne pas couper le WiFi si les sessions y tournent encore.
            if (!onWifiShell) {
                await disconnectWifiAdb();
            } else if (wifiManager?.setWifiEnabled) {
                wifiManager.setWifiEnabled(device.deviceId, true);
            }
            continue;
        }

        console.log(
            `[wifi][topology] USB rebranché device=${device.deviceId} — switch silencieux → ${usbSerial}`
            + ` onWifiShell=${onWifiShell} wasWifiEnabled=${wasWifiEnabled}`
        );

        try {
            const result = await switchDeviceSessionsToSerial(
                deps,
                device.deviceId,
                usbSerial,
                { silent: true, extraAliases: aliases }
            );

            const stillOnWifi = typeof global.deviceHubSessionsOnWifiShell === "function"
                && global.deviceHubSessionsOnWifiShell(device.deviceId);
            const switched = (result?.typeACount || 0) + (result?.typeBCount || 0);

            if (stillOnWifi) {
                console.warn(
                    `[wifi][topology] USB rebranché device=${device.deviceId} — `
                    + `sessions encore sur WiFi après switch (count=${switched}) — retry`
                );
                const retry = await switchDeviceSessionsToSerial(
                    deps,
                    device.deviceId,
                    usbSerial,
                    { silent: true, extraAliases: aliases }
                );
                const stillAfterRetry = typeof global.deviceHubSessionsOnWifiShell === "function"
                    && global.deviceHubSessionsOnWifiShell(device.deviceId);
                if (stillAfterRetry) {
                    console.warn(
                        `[wifi][topology] USB rebranché device=${device.deviceId} — `
                        + `échec bascule USB, on garde WiFi (toggle ON)`
                    );
                    if (wifiManager?.setWifiEnabled) {
                        wifiManager.setWifiEnabled(device.deviceId, true);
                    }
                    failAllSessionsReconnecting(deps, device.deviceId, { silent: true });
                    continue;
                }
                if (retry?.success !== false) {
                    await disconnectWifiAdb();
                }
                continue;
            }

            if (result?.success || switched > 0 || !onWifiShell) {
                await disconnectWifiAdb();
            } else {
                console.warn(
                    `[wifi][topology] switch USB device=${device.deviceId} — `
                    + `aucun onglet basculé, restore WiFi`
                );
                if (wifiManager?.setWifiEnabled) {
                    wifiManager.setWifiEnabled(device.deviceId, true);
                }
            }
        } catch (err) {
            console.warn(
                `[wifi][topology] switch USB device=${device.deviceId}:`,
                err?.message || err
            );
            failAllSessionsReconnecting(deps, device.deviceId, { silent: true });
            const stillOnWifi = typeof global.deviceHubSessionsOnWifiShell === "function"
                && global.deviceHubSessionsOnWifiShell(device.deviceId);
            if (stillOnWifi && wifiManager?.setWifiEnabled) {
                wifiManager.setWifiEnabled(device.deviceId, true);
            } else {
                await disconnectWifiAdb();
            }
        }
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
        getWifiDevicesManager,
        getWifiAdbService,
        refreshDeviceList
    };

    /** Évite ON/OFF concurrents (double toggle home+sidebar, IPC en vol). */
    const wifiToggleInFlight = new Map();
    /** Anti-rebond : ignore un WiFi ON immédiat après un OFF réussi. */
    const wifiOffCooldownUntil = new Map();

    const registry = typeof getDeviceRegistry === "function" ? getDeviceRegistry() : null;
    if (registry) {
        let topologyTimer = null;
        /** Conserve le previous du 1er event d'un burst — sinon un 2e poll écrase usbRegained. */
        let pendingTopology = null;
        registry.onTopologyChange = (unified, previousUnified) => {
            if (!pendingTopology) {
                pendingTopology = { unified, previousUnified };
            } else {
                pendingTopology.unified = unified;
            }
            if (topologyTimer) clearTimeout(topologyTimer);
            topologyTimer = setTimeout(() => {
                const snap = pendingTopology;
                pendingTopology = null;
                if (!snap) return;
                void handleTopologyChangeForWifiSessions(
                    reattachDeps,
                    snap.unified,
                    snap.previousUnified
                );
            }, 0);
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
                let wifiSerialFromConnect = null;
                try {
                    wifiSerialFromConnect = await wifiService.reconnectSaved(targetDeviceId, {
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

                    // Toggle ON = bascule sessions vers WiFi (même si USB encore branché).
                    // Le retour USB se fait via toggle OFF ou rebranchement 4d.
                    const updated = wifiManager.getByDeviceId(targetDeviceId);
                    let newSerial = wifiSerialFromConnect || null;
                    if (!newSerial && (updated?.ip || config.ip)) {
                        newSerial = wifiService.buildWifiSerial(
                            updated?.ip || config.ip,
                            updated?.port || config.port || 5555
                        );
                    }
                    if (!newSerial && typeof registry.resolveEffectiveAdbSerial === "function") {
                        newSerial = await registry.resolveEffectiveAdbSerial({
                            deviceId: targetDeviceId
                        });
                    }

                    const usbStillPlugged = Boolean(
                        liveUsbSerial
                        || (await registry.resolveLiveUsbSerial?.({ deviceId: targetDeviceId }))
                    );

                    if (!newSerial) {
                        console.warn(
                            `[switchSessionTransport] abort — serial WiFi introuvable device=${targetDeviceId}`
                        );
                        failAllSessionsReconnecting(reattachDeps, targetDeviceId);
                    } else {
                        console.log(
                            `[wifi:toggle] ON → switch sessions WiFi device=${targetDeviceId} `
                            + `serial=${newSerial} usbPlugged=${usbStillPlugged}`
                        );
                        await switchDeviceSessionsToWifi(reattachDeps, targetDeviceId, newSerial);
                    }
                } catch (switchErr) {
                    failAllSessionsReconnecting(reattachDeps, targetDeviceId);
                    throw switchErr;
                }

                const updated = wifiManager.getByDeviceId(targetDeviceId);

                return {
                    success: true,
                    deviceId: targetDeviceId,
                    progress: [{ step: "connect", message: "Connexion..." }],
                    message: `Connecté en WiFi — ${updated?.ip || config.ip}`
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
                        // Retour USB : switch sessions puis coupe ADB WiFi.
                        let usbSerial = await registry.resolveLiveUsbSerial?.({ deviceId }) || null;
                        if (usbSerial) {
                            console.log(
                                `[wifi:toggle] OFF → switch sessions USB device=${deviceId} serial=${usbSerial}`
                            );
                            await switchDeviceSessionsToSerial(
                                reattachDeps,
                                deviceId,
                                usbSerial,
                                { silent: false }
                            );
                        } else {
                            console.warn(
                                `[wifi:toggle] OFF USB — serial USB introuvable device=${deviceId}`
                            );
                            failAllSessionsReconnecting(reattachDeps, deviceId);
                        }
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

    ipcMain.handle("wifi:continue-on-wifi", async (_event, { deviceId } = {}) => {
        if (!deviceId) {
            return { success: false, error: "deviceId requis." };
        }

        const registry = getDeviceRegistry();
        const wifiManager = getWifiDevicesManager();
        const config = wifiManager.getByDeviceId(deviceId);
        if (!config) {
            return { success: false, error: "Configuration WiFi introuvable." };
        }

        try {
            console.log(`[wifi][4c] Continuer en WiFi device=${deviceId}`);
            const liveUsbSerial = await resolveToggleUsbSerial(registry, { deviceId, config });
            wifiManager.setWifiEnabled(deviceId, true);

            const alreadyOnWifi = typeof global.deviceHubSessionsOnWifiShell === "function"
                && global.deviceHubSessionsOnWifiShell(deviceId);

            const newSerial = await resolveWifiSerialForDevice(reattachDeps, deviceId, {
                usbSerialHint: liveUsbSerial || config.usbSerialHint || null
            });

            wifiManager.touchLastSeen(deviceId);
            await refreshDeviceList();

            if (!newSerial) {
                failAllSessionsReconnecting(reattachDeps, deviceId);
                return { success: false, error: "Serial WiFi introuvable." };
            }

            // Auto-4c a souvent déjà basculé : ne restarter que si besoin.
            if (alreadyOnWifi) {
                console.log(
                    `[wifi][4c] Continuer — sessions déjà sur WiFi device=${deviceId}`
                );
                notifyTransportReattachState(getMainWindow, {
                    deviceId,
                    phase: "end",
                    silent: false
                });
                return {
                    success: true,
                    deviceId,
                    wifiSerial: newSerial,
                    alreadyOnWifi: true
                };
            }

            const result = await switchDeviceSessionsToWifi(reattachDeps, deviceId, newSerial);
            return {
                success: Boolean(result?.success),
                error: result?.error || null,
                deviceId,
                wifiSerial: newSerial
            };
        } catch (err) {
            failAllSessionsReconnecting(reattachDeps, deviceId);
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle("wifi:play-on-device", async (_event, { deviceId } = {}) => {
        if (!deviceId) {
            return { success: false, error: "deviceId requis." };
        }

        const wifiService = getWifiAdbService();
        const wifiManager = getWifiDevicesManager();
        const config = wifiManager.getByDeviceId(deviceId);

        try {
            console.log(`[wifi][4c] Déconnecter device=${deviceId} — coupe sessions + WiFi`);
            let closed = 0;
            if (typeof global.closeHubSessionsForDevice === "function") {
                const closeResult = await global.closeHubSessionsForDevice(deviceId);
                closed = closeResult?.closed || 0;
            }

            // Pas de WiFi : désarmer + disconnect ADB.
            if (wifiManager?.setWifiEnabled) {
                wifiManager.setWifiEnabled(deviceId, false);
            }
            if (config?.ip && wifiService?.disconnect) {
                try {
                    await wifiService.disconnect(
                        wifiService.buildWifiSerial(config.ip, config.port || 5555)
                    );
                } catch (_err) {
                    // noop
                }
            }
            await refreshDeviceList();

            return { success: true, deviceId, closed };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
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
            try {
                const wifiSerial = await wifiService.reconnectSaved(deviceId, {
                    usbSerial: liveUsbSerial || undefined
                });
                wifiManager.touchLastSeen(deviceId);
                await refreshDeviceList();
                const result = await switchDeviceSessionsToWifi(
                    reattachDeps,
                    deviceId,
                    wifiSerial
                );
                return {
                    success: Boolean(result?.success),
                    wifiSerial,
                    error: result?.error || null,
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

module.exports = { registerWifiHandlers, notifySessionStreamRestarting };
