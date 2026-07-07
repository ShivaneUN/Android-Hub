/**
 * Benchmark Type A — 3 lancements scrcpy avec sous-profiler ADB.
 * Usage: npx electron scripts/benchmark-type-a-latency.js
 */
const { app } = require("electron");
const { execSync } = require("child_process");
const path = require("path");

const RUNS = 3;
const GAP_MS = 1500;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickUsbSerial(adbPath) {
    const output = execSync(`"${adbPath}" devices`, { encoding: "utf-8", windowsHide: true });
    const lines = output.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
        const [serial, state] = line.split(/\s+/);
        if (serial && state === "device") return serial;
    }
    throw new Error("Aucun appareil USB en état device");
}

app.whenReady().then(async () => {
    const { getAdbPath, getServerJarPath } = require(path.join(__dirname, "../src/main/paths"));
    const { ScrcpySocketClient } = require(path.join(__dirname, "../src/native/scrcpy/scrcpy-socket"));
    const { LaunchLatencyTracker } = require(path.join(__dirname, "../src/main/managers/launch-latency-tracker"));
    const { installScrcpyStartProfiler } = require(path.join(__dirname, "../src/main/managers/scrcpy-start-profiler"));

    const adbPath = getAdbPath();
    const serverJarPath = getServerJarPath();
    const serial = pickUsbSerial(adbPath);

    const tracker = new LaunchLatencyTracker(app.getPath("userData"));
    const profiler = installScrcpyStartProfiler(ScrcpySocketClient, tracker);

    console.log(`[benchmark-type-a] serial=${serial} runs=${RUNS}`);

    const options = {
        bitRate: 8_000_000,
        maxFps: 60,
        maxSize: 1920,
        iFrameInterval: 1,
        audio: false
    };

    for (let i = 0; i < RUNS; i += 1) {
        const tabId = `benchmark-type-a-${Date.now()}-${i}`;
        const client = new ScrcpySocketClient(adbPath, serial);

        let connectedAt = null;
        client.once("connected", () => {
            connectedAt = Date.now();
        });

        profiler.begin(tabId, client, { dimsResolveMs: 0 });

        try {
            await client.start(serverJarPath, options);
            profiler.onAdbSocketConnected(tabId, connectedAt);
        } finally {
            client.stop();
        }

        if (i < RUNS - 1) {
            await sleep(GAP_MS);
        }
    }

    console.log("[benchmark-type-a] done");
    app.quit();
});

app.on("window-all-closed", () => {
    app.quit();
});
