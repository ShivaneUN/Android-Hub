const { Menu, MenuItem, dialog, nativeImage, ipcMain } = require("electron");
const { DEVICE_COLORS } = require("../../shared/device-colors");
const { getColorLabel } = require("../../shared/locale");
const { resolveStableDeviceId, collectDeviceAliasKeys, performSessionReset } = require("./namesHandlers");

const colorSwatchCache = new Map();

function notifyNamesUpdated(mainWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("names:updated");
    }
}

function notifyDeviceColorsUpdated(mainWindow, hubModalWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("device-colors:updated");
    }
    if (hubModalWindow && !hubModalWindow.isDestroyed()) {
        hubModalWindow.webContents.send("device-colors:updated");
    }
}

function createColorSwatchIcon(hex, size = 14) {
    const cacheKey = `${hex}:${size}`;
    if (colorSwatchCache.has(cacheKey)) {
        return colorSwatchCache.get(cacheKey);
    }

    const radius = size / 2 - 1;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${hex}"/></svg>`;
    const icon = nativeImage.createFromDataURL(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    );
    colorSwatchCache.set(cacheKey, icon);
    return icon;
}

function buildDeviceColorSubmenu(target, deps) {
    const getDeviceColorsManager = deps.getDeviceColorsManager;
    const getMainWindow = deps.getMainWindow;
    const getHubModalWindow = deps.getHubModalWindow;
    const getConnectedDeviceIds = deps.getConnectedDeviceIds;
    const getUiPreferencesManager = deps.getUiPreferencesManager;
    const manager = getDeviceColorsManager?.();
    if (!manager || !target.serial) return null;

    const localeApi = getUiPreferencesManager?.()?.localeApi;
    const t = (key) => localeApi?.t(key) || key;
    const current = manager.getColorForDevice(target.serial);
    const colorMenu = new Menu();
    const notify = () => notifyDeviceColorsUpdated(getMainWindow?.(), getHubModalWindow?.());

    colorMenu.append(new MenuItem({
        label: t("contextMenu.auto"),
        type: current?.mode === "auto" ? "checkbox" : "normal",
        checked: current?.mode === "auto",
        click: () => {
            const connectedDeviceIds = typeof getConnectedDeviceIds === "function"
                ? getConnectedDeviceIds()
                : [];
            const result = manager.setAutoMode(target.serial, connectedDeviceIds);
            if (result.success) {
                notify();
            }
        }
    }));

    colorMenu.append(new MenuItem({ type: "separator" }));

    for (const color of DEVICE_COLORS) {
        colorMenu.append(new MenuItem({
            label: getColorLabel(localeApi, color.id) || color.name,
            icon: createColorSwatchIcon(color.hex),
            type: current?.colorId === color.id && current?.mode === "manual" ? "checkbox" : "normal",
            checked: current?.colorId === color.id && current?.mode === "manual",
            click: () => {
                const result = manager.setManualColor(target.serial, color.id);
                if (result.success) {
                    notify();
                }
            }
        }));
    }

    return colorMenu;
}

async function confirmReset(mainWindow, getUiPreferencesManager) {
    const t = (key) => getUiPreferencesManager?.()?.t(key) || key;
    const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        buttons: [t("contextMenu.cancel"), t("contextMenu.reset")],
        defaultId: 0,
        cancelId: 0,
        title: t("contextMenu.confirmResetTitle"),
        message: t("contextMenu.confirmResetMessage")
    });
    return result.response === 1;
}

function registerContextMenuHandlers(deps) {
    const getMainWindow = deps.getMainWindow;
    const getCustomNamesManager = deps.getCustomNamesManager;
    const getBrowserViewManager = deps.getBrowserViewManager;
    const getRenameDialogManager = deps.getRenameDialogManager;
    const getDeviceColorsManager = deps.getDeviceColorsManager;
    const getConnectedDeviceIds = deps.getConnectedDeviceIds;
    const getUiPreferencesManager = deps.getUiPreferencesManager;

    ipcMain.handle("context-menu:show", async (event, payload = {}) => {
        const t = (key) => getUiPreferencesManager?.()?.t(key) || key;
        const mainWindow = getMainWindow();
        const popupWindow = mainWindow && !mainWindow.isDestroyed()
            ? mainWindow
            : require("electron").BrowserWindow.fromWebContents(event.sender);

        if (!popupWindow) {
            return { success: false, error: t("contextMenu.windowNotFound") };
        }

        const { x, y, target } = payload;
        if (!target?.kind) {
            return { success: false, error: t("contextMenu.invalidTarget") };
        }

        // Menu couleurs seul (ex. pastille batterie du dock tablette).
        if (target.colorsOnly && target.kind === "device" && target.serial && getDeviceColorsManager) {
            const colorMenu = buildDeviceColorSubmenu(target, {
                getDeviceColorsManager,
                getMainWindow,
                getConnectedDeviceIds,
                getUiPreferencesManager
            });
            if (!colorMenu) {
                return { success: false, error: t("contextMenu.invalidTarget") };
            }
            colorMenu.popup({
                window: popupWindow,
                x: Math.round(x),
                y: Math.round(y)
            });
            return { success: true };
        }

        if (target.kind === "homeFab" && target.fabId) {
            const fabMenu = new Menu();
            const locked = Boolean(target.locked);
            fabMenu.append(new MenuItem({
                label: locked ? t("contextMenu.unlock") : t("contextMenu.lock"),
                click: () => {
                    const mainWin = getMainWindow();
                    const win = mainWin && !mainWin.isDestroyed() ? mainWin : popupWindow;
                    if (win && !win.isDestroyed()) {
                        win.webContents.send("context-menu:action", {
                            action: "home-fab-toggle-lock",
                            fabId: target.fabId
                        });
                    }
                }
            }));
            fabMenu.popup({
                window: popupWindow,
                x: Math.round(x),
                y: Math.round(y)
            });
            return { success: true };
        }

        if (target.kind === "homeFabGroup" && Array.isArray(target.fabIds) && target.fabIds.length) {
            const groupMenu = new Menu();
            const locked = Boolean(target.locked);
            groupMenu.append(new MenuItem({
                label: locked
                    ? t("contextMenu.unlockGroup")
                    : t("contextMenu.lockGroup"),
                click: () => {
                    const mainWin = getMainWindow();
                    const win = mainWin && !mainWin.isDestroyed() ? mainWin : popupWindow;
                    if (win && !win.isDestroyed()) {
                        win.webContents.send("context-menu:action", {
                            action: "home-fab-group-toggle-lock",
                            fabIds: target.fabIds
                        });
                    }
                }
            }));
            groupMenu.popup({
                window: popupWindow,
                x: Math.round(x),
                y: Math.round(y)
            });
            return { success: true };
        }

        const menu = new Menu();

        menu.append(new MenuItem({
            label: t("contextMenu.rename"),
            click: async () => {
                const dialogManager = getRenameDialogManager?.();
                if (!dialogManager) return;

                if (target.kind === "device") {
                    await dialogManager.show({
                        kind: "device",
                        serial: target.serial,
                        currentName: target.currentName,
                        originalName: target.originalName || target.currentName
                    });
                } else if (target.kind === "session") {
                    await dialogManager.show({
                        kind: "session",
                        sessionId: target.sessionId,
                        currentName: target.currentName
                    });
                }
            }
        }));

        if (target.hasCustomName) {
            menu.append(new MenuItem({
                label: t("contextMenu.resetName"),
                click: async () => {
                    const manager = getCustomNamesManager?.();
                    const mainWin = getMainWindow();
                    if (!manager || !(await confirmReset(mainWin, getUiPreferencesManager))) return;

                    if (target.kind === "device" && target.serial) {
                        const stableId = await resolveStableDeviceId(target.serial);
                        const aliasKeys = collectDeviceAliasKeys(stableId, target.serial);
                        const original = manager.resetDeviceName(stableId, aliasKeys);

                        const wifiConfig = global.wifiDevicesManager?.getByDeviceId?.(stableId);
                        if (wifiConfig && original) {
                            global.wifiDevicesManager.rename(stableId, original);
                        }

                        notifyNamesUpdated(mainWin);
                    } else if (target.kind === "session" && target.sessionId) {
                        const bvm = getBrowserViewManager?.();
                        if (!bvm) return;
                        await performSessionReset(manager, bvm, mainWin, target.sessionId);
                    }
                }
            }));
        }

        if (target.kind === "device" && target.connected && target.serial && getDeviceColorsManager) {
            const colorSubmenu = buildDeviceColorSubmenu(target, {
                getDeviceColorsManager,
                getMainWindow,
                getConnectedDeviceIds,
                getUiPreferencesManager
            });
            if (colorSubmenu) {
                menu.append(new MenuItem({ type: "separator" }));
                menu.append(new MenuItem({
                    label: t("contextMenu.color"),
                    submenu: colorSubmenu
                }));
            }
        }

        if (target.kind === "session" && target.sessionId) {
            menu.append(new MenuItem({ type: "separator" }));
            menu.append(new MenuItem({
                label: t("contextMenu.close"),
                click: () => {
                    const mainWin = getMainWindow();
                    if (mainWin && !mainWin.isDestroyed()) {
                        mainWin.webContents.send("context-menu:action", {
                            action: "close-session",
                            sessionId: target.sessionId
                        });
                    }
                }
            }));
        }

        menu.popup({
            window: popupWindow,
            x: Math.round(x),
            y: Math.round(y)
        });

        return { success: true };
    });
}

module.exports = { registerContextMenuHandlers };
