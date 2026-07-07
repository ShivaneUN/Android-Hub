const { ipcMain, BrowserWindow } = require("electron");

function broadcastLocaleChanged(getWindows, locale) {
    for (const win of getWindows()) {
        if (win && !win.isDestroyed()) {
            win.webContents.send("ui:locale-changed", { locale });
        }
    }
}

function registerUiPreferencesHandlers(deps) {
    const getUiPreferencesManager = deps.getUiPreferencesManager;
    const getMainWindow = deps.getMainWindow;
    const getHubModalWindow = deps.getHubModalWindow;

    const getWindows = () => {
        const windows = [];
        const main = getMainWindow?.();
        if (main && !main.isDestroyed()) windows.push(main);
        const hub = getHubModalWindow?.();
        if (hub && !hub.isDestroyed()) windows.push(hub);
        for (const win of BrowserWindow.getAllWindows()) {
            if (!windows.includes(win) && !win.isDestroyed()) {
                windows.push(win);
            }
        }
        return windows;
    };

    ipcMain.handle("ui:get-locale-data", async () => {
        const manager = getUiPreferencesManager?.();
        if (!manager) {
            return { locale: "fr", bundles: {} };
        }
        return manager.getLocaleData();
    });

    ipcMain.handle("ui:get-locale", async () => {
        const manager = getUiPreferencesManager?.();
        return { locale: manager?.getLocale?.() || "fr" };
    });

    ipcMain.handle("ui:set-locale", async (_event, payload = {}) => {
        const manager = getUiPreferencesManager?.();
        if (!manager) {
            return { success: false, error: "manager-unavailable" };
        }
        const locale = payload?.locale;
        const result = manager.setLocale(locale);
        if (result.success) {
            broadcastLocaleChanged(getWindows, result.locale);
        }
        return result;
    });

    ipcMain.handle("ui:get-preferences", async () => {
        const manager = getUiPreferencesManager?.();
        if (!manager) {
            return { locale: "fr", sidebarOpen: true };
        }
        return manager.getPreferences();
    });

    ipcMain.handle("ui:set-sidebar-open", async (_event, payload = {}) => {
        const manager = getUiPreferencesManager?.();
        if (!manager) {
            return { success: false, error: "manager-unavailable" };
        }
        return manager.setSidebarOpen(payload?.sidebarOpen);
    });
}

module.exports = { registerUiPreferencesHandlers };
