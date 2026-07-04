const { app } = require("electron");
const path = require("path");

function getToolsDir() {
    if (app.isPackaged) {
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
