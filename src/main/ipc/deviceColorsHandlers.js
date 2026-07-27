const { ipcMain } = require("electron");
const { DEVICE_COLORS } = require("../../shared/device-colors");

function notifyDeviceColorsUpdated(mainWindow, hubModalWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("device-colors:updated");
    }
    if (hubModalWindow && !hubModalWindow.isDestroyed()) {
        hubModalWindow.webContents.send("device-colors:updated");
    }
}

function registerDeviceColorsHandlers(deps) {
    const getManager = deps.getDeviceColorsManager;
    const getMainWindow = deps.getMainWindow;
    const getHubModalWindow = deps.getHubModalWindow;
    const getConnectedDeviceIds = deps.getConnectedDeviceIds;

    const notify = () => notifyDeviceColorsUpdated(getMainWindow?.(), getHubModalWindow?.());

    ipcMain.handle("device-colors:getPalette", () => ({
        success: true,
        colors: DEVICE_COLORS
    }));

    ipcMain.handle("device-colors:get", (_event, { deviceId } = {}) => {
        const manager = getManager();
        if (!manager || !deviceId) {
            return { success: false, error: "Paramètres invalides." };
        }
        return {
            success: true,
            deviceColor: manager.getColorForDevice(deviceId)
        };
    });

    ipcMain.handle("device-colors:setManual", (_event, { deviceId, colorId } = {}) => {
        const manager = getManager();
        if (!manager) {
            return { success: false, error: "Gestionnaire indisponible." };
        }

        const result = manager.setManualColor(deviceId, colorId);
        if (result.success) {
            notify();
        }
        return result;
    });

    ipcMain.handle("device-colors:setAuto", (_event, { deviceId } = {}) => {
        const manager = getManager();
        if (!manager) {
            return { success: false, error: "Gestionnaire indisponible." };
        }

        const connectedDeviceIds = typeof getConnectedDeviceIds === "function"
            ? getConnectedDeviceIds()
            : [];
        const result = manager.setAutoMode(deviceId, connectedDeviceIds);
        if (result.success) {
            notify();
        }
        return result;
    });
}

module.exports = { registerDeviceColorsHandlers };
