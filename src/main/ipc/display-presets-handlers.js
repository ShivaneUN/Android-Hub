const { ipcMain } = require("electron");

function notifyDisplayPresetsUpdated(getWindows) {
    for (const win of getWindows()) {
        if (win && !win.isDestroyed()) {
            win.webContents.send("display-presets:updated");
        }
    }
}

function registerDisplayPresetsHandlers(deps) {
    const getManager = deps.getDisplayPresetsManager;
    const getMainWindow = deps.getMainWindow;
    const getHubModalWindow = deps.getHubModalWindow;

    const getWindows = () => {
        const windows = [];
        const main = getMainWindow?.();
        if (main && !main.isDestroyed()) windows.push(main);
        const hub = getHubModalWindow?.();
        if (hub && !hub.isDestroyed()) windows.push(hub);
        return windows;
    };

    const requireManager = () => {
        const manager = getManager?.();
        if (!manager) {
            return { manager: null, error: { success: false, error: "Gestionnaire de presets indisponible" } };
        }
        return { manager, error: null };
    };

    ipcMain.handle("display-presets:list", () => {
        const { manager, error } = requireManager();
        if (error) return error;
        return manager.list();
    });

    ipcMain.handle("display-presets:get-default", (_event, { transport } = {}) => {
        const { manager, error } = requireManager();
        if (error) return error;
        return manager.getDefault(transport || "usb");
    });

    ipcMain.handle("display-presets:resolve-params", (_event, { presetId } = {}) => {
        const { manager, error } = requireManager();
        if (error) return error;
        return {
            success: true,
            presetId: presetId || manager.list().defaultPresetUsb,
            params: manager.resolveParams(presetId || null)
        };
    });

    ipcMain.handle("display-presets:get-allowed-options", () => {
        const { manager, error } = requireManager();
        if (error) return error;
        return {
            success: true,
            options: manager.getAllowedOptions()
        };
    });

    ipcMain.handle("display-presets:save", (_event, payload = {}) => {
        const { manager, error } = requireManager();
        if (error) return error;

        const result = manager.savePreset({
            name: payload.name,
            params: payload.params,
            id: payload.id || null
        });

        if (result.success) {
            notifyDisplayPresetsUpdated(getWindows);
        }

        return result;
    });

    ipcMain.handle("display-presets:set-default", (_event, { presetId, transport } = {}) => {
        const { manager, error } = requireManager();
        if (error) return error;

        const result = manager.setDefaultPreset(presetId, transport || "usb");
        if (result.success) {
            notifyDisplayPresetsUpdated(getWindows);
        }

        return result;
    });

    ipcMain.handle("display-presets:update-default-from-params", (_event, { params, transport } = {}) => {
        const { manager, error } = requireManager();
        if (error) return error;

        const result = manager.updateDefaultFromParams(params, transport || "usb");
        if (result.success) {
            notifyDisplayPresetsUpdated(getWindows);
        }

        return result;
    });

    ipcMain.handle("display-presets:delete", (_event, { presetId } = {}) => {
        const { manager, error } = requireManager();
        if (error) return error;

        const result = manager.deletePreset(presetId);
        if (result.success) {
            notifyDisplayPresetsUpdated(getWindows);
        }

        return result;
    });

    ipcMain.handle("display-presets:reset-transport-factory", (_event, { transport } = {}) => {
        const { manager, error } = requireManager();
        if (error) return error;

        const result = manager.resetTransportToFactory(transport || "usb");
        if (result.success) {
            notifyDisplayPresetsUpdated(getWindows);
        }

        return result;
    });
}

module.exports = { registerDisplayPresetsHandlers };
