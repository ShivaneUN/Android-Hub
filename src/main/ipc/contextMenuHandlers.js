const { Menu, MenuItem, dialog, nativeImage, ipcMain } = require("electron");
const { DEVICE_COLORS } = require("../../shared/device-colors");
const { resolveStableDeviceId, collectDeviceAliasKeys, performSessionReset } = require("./namesHandlers");

const colorSwatchCache = new Map();

function notifyNamesUpdated(mainWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("names:updated");
    }
}

function notifyDeviceColorsUpdated(mainWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("device-colors:updated");
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
    const getConnectedDeviceIds = deps.getConnectedDeviceIds;
    const manager = getDeviceColorsManager?.();
    if (!manager || !target.serial) return null;

    const current = manager.getColorForDevice(target.serial);
    const colorMenu = new Menu();

    colorMenu.append(new MenuItem({
        label: "Auto",
        type: current?.mode === "auto" ? "checkbox" : "normal",
        checked: current?.mode === "auto",
        click: () => {
            const connectedDeviceIds = typeof getConnectedDeviceIds === "function"
                ? getConnectedDeviceIds()
                : [];
            const result = manager.setAutoMode(target.serial, connectedDeviceIds);
            if (result.success) {
                notifyDeviceColorsUpdated(getMainWindow());
            }
        }
    }));

    colorMenu.append(new MenuItem({ type: "separator" }));

    for (const color of DEVICE_COLORS) {
        colorMenu.append(new MenuItem({
            label: color.name,
            icon: createColorSwatchIcon(color.hex),
            type: current?.colorId === color.id && current?.mode === "manual" ? "checkbox" : "normal",
            checked: current?.colorId === color.id && current?.mode === "manual",
            click: () => {
                const result = manager.setManualColor(target.serial, color.id);
                if (result.success) {
                    notifyDeviceColorsUpdated(getMainWindow());
                }
            }
        }));
    }

    return colorMenu;
}

async function confirmReset(mainWindow) {
    const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        buttons: ["Annuler", "Réinitialiser"],
        defaultId: 0,
        cancelId: 0,
        title: "Réinitialiser le nom",
        message: "Réinitialiser le nom d'origine ?"
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

    ipcMain.handle("context-menu:show", async (event, payload = {}) => {
        const mainWindow = getMainWindow();
        const popupWindow = mainWindow && !mainWindow.isDestroyed()
            ? mainWindow
            : require("electron").BrowserWindow.fromWebContents(event.sender);

        if (!popupWindow) {
            return { success: false, error: "Fenêtre introuvable." };
        }

        const { x, y, target } = payload;
        if (!target?.kind) {
            return { success: false, error: "Cible invalide." };
        }

        const menu = new Menu();

        menu.append(new MenuItem({
            label: "Renommer",
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
                label: "Réinitialiser le nom",
                click: async () => {
                    const manager = getCustomNamesManager?.();
                    const mainWin = getMainWindow();
                    if (!manager || !(await confirmReset(mainWin))) return;

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
                getConnectedDeviceIds
            });
            if (colorSubmenu) {
                menu.append(new MenuItem({ type: "separator" }));
                menu.append(new MenuItem({
                    label: "Couleur",
                    submenu: colorSubmenu
                }));
            }
        }

        if (target.kind === "session" && target.sessionId) {
            menu.append(new MenuItem({ type: "separator" }));
            menu.append(new MenuItem({
                label: "Fermer",
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
