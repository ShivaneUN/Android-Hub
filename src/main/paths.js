const path = require("path");

let electronApp = null;
try {
    electronApp = require("electron").app;
} catch (_err) {
    electronApp = null;
}

function getToolsDir() {
    if (electronApp?.isPackaged) {
        return path.join(process.resourcesPath, "tools");
    }
    return path.join(__dirname, "..", "..", "tools");
}

function getAdbPath() {
    return path.join(getToolsDir(), "adb.exe");
}

function getScrcpyBinaryPath() {
    return path.join(getToolsDir(), "scrcpy.exe");
}

function getServerJarPath() {
    return path.join(getToolsDir(), "scrcpy-server");
}

module.exports = {
    getToolsDir,
    getAdbPath,
    getScrcpyBinaryPath,
    getServerJarPath
};
