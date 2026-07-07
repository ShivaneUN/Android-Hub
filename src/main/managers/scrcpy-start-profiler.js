/**
 * Profileur diagnostic scrcpy-server.start() — monkey-patch externe (hors fichier LOCK).
 * Mesure les sous-étapes entre streamInvoke et adb-socket-connected.
 */

let installed = false;

function installScrcpyStartProfiler(ScrcpySocketClient, tracker = null) {
    if (installed || !ScrcpySocketClient?.prototype) return;
    installed = true;

    const proto = ScrcpySocketClient.prototype;
    const profilesByClient = new WeakMap();
    const profilesByTabId = new Map();

    function getProfile(client) {
        return profilesByClient.get(client) || null;
    }

    function logSubBreakdown(tabId, profile) {
        if (!profile?.sub) return;
        const sub = profile.sub;
        const fmt = (value) => (typeof value === "number" ? `${value}` : "—");

        const spawnToConnect = (sub.serverSpawnAt && sub.connectSocketsBegin)
            ? Math.max(0, sub.connectSocketsBegin - sub.serverSpawnAt)
            : null;
        const fixedDelay350 = spawnToConnect !== null
            ? Math.max(0, spawnToConnect - (sub.connectSockets || 0))
            : null;

        const deviceMeta = (sub.connectSocketsEnd && sub.adbConnectedAt)
            ? Math.max(0, sub.adbConnectedAt - sub.connectSocketsEnd)
            : null;

        const scrcpyInternal = (sub.scrcpyStartAt && sub.adbConnectedAt)
            ? Math.max(0, sub.adbConnectedAt - sub.scrcpyStartAt)
            : null;

        const line = `[LATENCE-ADB] ${tabId} | dims: ${fmt(sub.dimsResolve)}ms | jarPush: ${fmt(sub.jarPush)}ms | tunnel: ${fmt(sub.tunnelSetup)}ms | spawn: ${fmt(sub.serverSpawn)}ms | delay350~: ${fmt(fixedDelay350)}ms | connectSockets: ${fmt(sub.connectSockets)}ms | deviceMeta: ${fmt(deviceMeta)}ms | scrcpy.start total: ${fmt(scrcpyInternal)}ms`;

        console.log(line);
        if (tracker?.logFilePath) {
            try {
                const fs = require("fs");
                fs.appendFileSync(tracker.logFilePath, `${new Date().toISOString()} ${line}\n`, "utf-8");
            } catch (_err) {
                // noop
            }
        }

        if (tracker && tabId) {
            tracker.mark({
                sessionId: tabId,
                stage: "scrcpySubBreakdown",
                ts: Date.now()
            });
            const trace = tracker._resolveTrace?.({ sessionId: tabId });
            if (trace) {
                trace.scrcpySub = {
                    dimsResolve: sub.dimsResolve ?? null,
                    jarPush: sub.jarPush ?? null,
                    tunnelSetup: sub.tunnelSetup ?? null,
                    serverSpawn: sub.serverSpawn ?? 0,
                    fixedDelay350: fixedDelay350,
                    connectSockets: sub.connectSockets ?? null,
                    deviceMeta: deviceMeta,
                    scrcpyStartTotal: scrcpyInternal
                };
            }
        }
    }

    function wrapAsync(methodName, stageKey) {
        const original = proto[methodName];
        if (typeof original !== "function") return;

        proto[methodName] = async function wrappedScrcpyStage(...args) {
            const profile = getProfile(this);
            const t0 = Date.now();
            if (profile && stageKey === "connectSockets") {
                profile.sub.connectSocketsBegin = t0;
            }
            try {
                return await original.apply(this, args);
            } finally {
                if (profile) {
                    profile.sub[stageKey] = Date.now() - t0;
                    if (stageKey === "connectSockets") {
                        profile.sub.connectSocketsEnd = Date.now();
                    }
                }
            }
        };
    }

    wrapAsync("_pushServer", "jarPush");
    wrapAsync("_setupTunnel", "tunnelSetup");
    wrapAsync("_connectSockets", "connectSockets");

    const originalStartServerProcess = proto._startServerProcess;
    proto._startServerProcess = function wrappedStartServerProcess(...args) {
        const profile = getProfile(this);
        if (profile) {
            profile.sub.serverSpawnAt = Date.now();
            profile.sub.serverSpawn = 0;
        }
        return originalStartServerProcess.apply(this, args);
    };

    const api = {
        begin(tabId, client, { dimsResolveMs = null } = {}) {
            if (!tabId || !client) return;
            const profile = {
                tabId,
                sub: {
                    dimsResolve: typeof dimsResolveMs === "number" ? dimsResolveMs : null,
                    serverSpawn: 0
                },
                scrcpyStartAt: Date.now()
            };
            profilesByClient.set(client, profile);
            profilesByTabId.set(tabId, profile);
        },

        onAdbSocketConnected(tabId, connectedAt = null) {
            const profile = profilesByTabId.get(tabId);
            if (!profile) return;
            profile.sub.adbConnectedAt = typeof connectedAt === "number" ? connectedAt : Date.now();
            logSubBreakdown(tabId, profile);
            profilesByTabId.delete(tabId);
        },

        setDimsResolve(tabId, ms) {
            const profile = profilesByTabId.get(tabId);
            if (profile) profile.sub.dimsResolve = ms;
        }
    };

    return api;
}

module.exports = { installScrcpyStartProfiler };
