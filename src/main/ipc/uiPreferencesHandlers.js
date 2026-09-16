const { ipcMain, BrowserWindow } = require("electron");

function broadcastLocaleChanged(getWindows, locale) {
    for (const win of getWindows()) {
        if (win && !win.isDestroyed()) {
            win.webContents.send("ui:locale-changed", { locale });
        }
    }
}

function broadcastWallpaperChanged(getWindows, state) {
    for (const win of getWindows()) {
        if (win && !win.isDestroyed()) {
            win.webContents.send("ui:wallpaper-changed", state);
        }
    }
}

function broadcastPerformanceChanged(getWindows, performance) {
    const payload = { performance };
    for (const win of getWindows()) {
        if (win && !win.isDestroyed()) {
            win.webContents.send("ui:performance-changed", payload);
        }
    }
    global.browserViewManager?.broadcastToSessionViews?.("ui:performance-changed", payload);
}

function broadcastDisplayPresetsUpdated(getWindows) {
    for (const win of getWindows()) {
        if (win && !win.isDestroyed()) {
            win.webContents.send("display-presets:updated");
        }
    }
}

function registerUiPreferencesHandlers(deps) {
    const getUiPreferencesManager = deps.getUiPreferencesManager;
    const getHubWallpaperManager = deps.getHubWallpaperManager;
    const getDisplayPresetsManager = deps.getDisplayPresetsManager;
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
            return { locale: "fr", sidebarOpen: true, streamDeckMode: false };
        }
        return manager.getPreferences();
    });

    ipcMain.handle("ui:get-performance-prefs", async () => {
        const manager = getUiPreferencesManager?.();
        if (!manager?.getPerformancePrefs) {
            return {
                performanceMode: false,
                fpsMonitor: true,
                appLogos: true,
                homePreview: true,
                hoverPreview: true,
                dockBatteryLive: true,
                uiAnimations: true,
                sessionTransportSwitch: true
            };
        }
        return manager.getPerformancePrefs();
    });

    ipcMain.handle("ui:set-performance-prefs", async (_event, payload = {}) => {
        const manager = getUiPreferencesManager?.();
        if (!manager?.setPerformancePrefs) {
            return { success: false, error: "manager-unavailable" };
        }
        const before = manager.getPerformancePrefs?.() || {};
        const result = manager.setPerformancePrefs(payload || {});
        if (result.success) {
            broadcastPerformanceChanged(getWindows, result.performance);
            const turnedOn = result.performance?.performanceMode === true
                && before.performanceMode !== true;
            const turnedOff = result.performance?.performanceMode !== true
                && before.performanceMode === true;
            const presets = getDisplayPresetsManager?.();
            if (turnedOn) {
                const presetResult = presets?.applyPerformanceResolution?.();
                if (presetResult?.success) {
                    broadcastDisplayPresetsUpdated(getWindows);
                }
            } else if (turnedOff) {
                const presetResult = presets?.restorePerformanceResolution?.({ healSeeds: true });
                if (presetResult?.success) {
                    broadcastDisplayPresetsUpdated(getWindows);
                }
            }
        }
        return result;
    });

    ipcMain.handle("ui:get-device-screen-power-prefs", async () => {
        const manager = getUiPreferencesManager?.();
        if (!manager?.getDeviceScreenPowerPrefs) {
            return { rememberAcrossDisconnect: false, byDeviceId: {} };
        }
        return manager.getDeviceScreenPowerPrefs();
    });

    ipcMain.handle("ui:set-remember-screen-across-disconnect", async (_event, payload = {}) => {
        const manager = getUiPreferencesManager?.();
        if (!manager?.setRememberScreenAcrossDisconnect) {
            return { success: false, error: "manager-unavailable" };
        }
        return manager.setRememberScreenAcrossDisconnect(payload?.enabled === true);
    });

    ipcMain.handle("ui:get-clipboard-autosync", async () => {
        const manager = getUiPreferencesManager?.();
        return { clipboardAutosync: manager?.getClipboardAutosync?.() !== false };
    });

    ipcMain.handle("ui:set-clipboard-autosync", async (_event, payload = {}) => {
        const manager = getUiPreferencesManager?.();
        if (!manager?.setClipboardAutosync) {
            return { success: false, error: "manager-unavailable" };
        }
        const result = manager.setClipboardAutosync(payload?.enabled !== false);
        if (result.success) {
            for (const win of getWindows()) {
                if (win && !win.isDestroyed()) {
                    win.webContents.send("ui:clipboard-autosync-changed", {
                        clipboardAutosync: result.clipboardAutosync
                    });
                }
            }
        }
        return result;
    });

    ipcMain.handle("ui:set-sidebar-open", async (_event, payload = {}) => {
        const manager = getUiPreferencesManager?.();
        if (!manager) {
            return { success: false, error: "manager-unavailable" };
        }
        return manager.setSidebarOpen(payload?.sidebarOpen);
    });

    ipcMain.handle("ui:set-display-preferences", async (_event, payload = {}) => {
        const manager = getUiPreferencesManager?.();
        if (!manager) {
            return { success: false, error: "manager-unavailable" };
        }
        return manager.setDisplayPreferences(payload);
    });

    ipcMain.handle("ui:get-hub-wallpaper", async () => {
        const manager = getHubWallpaperManager?.();
        if (!manager) {
            return { active: false, fileName: null, url: null };
        }
        return manager.getState();
    });

    ipcMain.handle("ui:pick-hub-wallpaper", async (event) => {
        const manager = getHubWallpaperManager?.();
        if (!manager) {
            return { success: false, error: "manager-unavailable", active: false };
        }
        const parent = BrowserWindow.fromWebContents(event.sender);
        const result = await manager.pickFromDialog(parent);
        if (result.success) {
            broadcastWallpaperChanged(getWindows, {
                active: result.active,
                fileName: result.fileName,
                url: result.url
            });
        }
        return result;
    });

    ipcMain.handle("ui:clear-hub-wallpaper", async () => {
        const manager = getHubWallpaperManager?.();
        if (!manager) {
            return { success: false, error: "manager-unavailable", active: false };
        }
        const state = manager.clear();
        broadcastWallpaperChanged(getWindows, state);
        return { success: true, ...state };
    });
}

module.exports = { registerUiPreferencesHandlers };
