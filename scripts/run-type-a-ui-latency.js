/**
 * Déclenche 3 mirroring Type A via le chemin UI réel (markClick + launchMirrorSession).
 * Usage: node scripts/run-type-a-ui-latency.js
 */
const { spawn } = require("child_process");
const path = require("path");

const appRoot = path.join(__dirname, "..");
const electronPath = require("electron");

const child = spawn(electronPath, [appRoot], {
    cwd: appRoot,
    env: {
        ...process.env,
        ANDROID_HUB_UI_LATENCY_RUNS: "3"
    },
    stdio: "inherit",
    windowsHide: false
});

child.on("exit", (code) => {
    process.exit(code ?? 0);
});
