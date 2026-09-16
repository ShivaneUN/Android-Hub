const { ipcMain, dialog, BrowserWindow, shell, app } = require("electron");
const fs = require("fs");
const path = require("path");
const { DEFAULT_PUSH_TARGET } = require("../managers/device-fs-manager");

function registerDeviceFsHandlers({
    getDeviceFsManager,
    getMainWindow,
    getHubModalWindow,
    resolveSerial
}) {
    const getWindows = () => {
        const windows = [];
        const main = getMainWindow?.();
        if (main && !main.isDestroyed()) windows.push(main);
        const hub = getHubModalWindow?.();
        if (hub && !hub.isDestroyed()) windows.push(hub);
        return windows;
    };

    const sendProgress = (payload) => {
        for (const win of getWindows()) {
            win.webContents.send("device-fs:progress", payload);
        }
    };

    const sendToast = (message, type = "info") => {
        const hub = getHubModalWindow?.();
        if (hub && !hub.isDestroyed() && hub.isVisible?.()) {
            hub.webContents.send("device-fs:toast", { message, type });
            return;
        }
        const win = getMainWindow?.();
        if (win && !win.isDestroyed()) {
            win.webContents.send("device-fs:toast", { message, type });
        }
    };

    async function resolveDeviceSerial(hint = {}) {
        const serial = await resolveSerial?.(hint);
        if (!serial) throw new Error("Appareil introuvable");
        return serial;
    }

    function parentWindow(event) {
        return BrowserWindow.fromWebContents(event.sender) || getMainWindow?.() || null;
    }

    ipcMain.handle("device-fs:shortcuts", async () => {
        const manager = getDeviceFsManager?.();
        return { success: true, shortcuts: manager?.getShortcuts?.() || [] };
    });

    ipcMain.handle("device-fs:list", async (_event, payload = {}) => {
        try {
            const manager = getDeviceFsManager?.();
            if (!manager) return { success: false, error: "Explorateur indisponible" };
            const serial = await resolveDeviceSerial(payload);
            const remotePath = payload.path || "/sdcard";
            const listing = await manager.list(serial, remotePath);
            const deviceKey = payload.deviceId || payload.stableDeviceId || serial;
            manager.setPushTarget(deviceKey, listing.path);
            return { success: true, ...listing };
        } catch (err) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.handle("device-fs:mkdir", async (_event, payload = {}) => {
        try {
            const manager = getDeviceFsManager?.();
            if (!manager) return { success: false, error: "Explorateur indisponible" };
            const serial = await resolveDeviceSerial(payload);
            const result = await manager.mkdir(serial, payload.path, payload.name);
            return { success: true, ...result };
        } catch (err) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.handle("device-fs:remove", async (_event, payload = {}) => {
        try {
            const manager = getDeviceFsManager?.();
            if (!manager) return { success: false, error: "Explorateur indisponible" };
            const serial = await resolveDeviceSerial(payload);
            const result = await manager.remove(serial, payload.path);
            sendToast(`${path.basename(String(payload.path || ""))} supprimé`, "success");
            return { success: true, ...result };
        } catch (err) {
            sendToast(err?.message || String(err), "error");
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.handle("device-fs:preview", async (_event, payload = {}) => {
        try {
            const manager = getDeviceFsManager?.();
            if (!manager) return { success: false, error: "Explorateur indisponible" };
            const serial = await resolveDeviceSerial(payload);
            const result = await manager.preview(serial, payload.path);
            return { success: true, ...result };
        } catch (err) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.handle("device-fs:open-local", async (_event, payload = {}) => {
        try {
            const manager = getDeviceFsManager?.();
            if (!manager) return { success: false, error: "Explorateur indisponible" };
            if (payload.isDir) {
                return { success: false, error: "Ouvrez le dossier dans la liste" };
            }
            const serial = await resolveDeviceSerial(payload);
            const remotePath = payload.path;
            const name = String(payload.name || path.basename(String(remotePath || "")) || "file");
            const tmpDir = path.join(app.getPath("temp"), "android-hub-device-fs");
            fs.mkdirSync(tmpDir, { recursive: true });
            const dest = path.join(tmpDir, name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_"));
            const transferId = `fs-${Date.now()}`;
            const result = await manager.pull(serial, remotePath, dest, (progress) => {
                sendProgress({ transferId, ...progress });
            });
            const openError = await shell.openPath(result.localPath);
            if (openError) {
                return { success: false, error: openError, ...result };
            }
            return { success: true, opened: true, ...result };
        } catch (err) {
            sendToast(err?.message || String(err), "error");
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.handle("device-fs:pick-and-push", async (event, payload = {}) => {
        try {
            const manager = getDeviceFsManager?.();
            if (!manager) return { success: false, error: "Explorateur indisponible" };
            const parent = parentWindow(event);
            const picked = await dialog.showOpenDialog(parent, {
                properties: ["openFile", "openDirectory", "multiSelections"]
            });
            if (picked.canceled || !picked.filePaths?.length) {
                return { success: false, cancelled: true };
            }
            return pushPaths(event, payload, picked.filePaths);
        } catch (err) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    async function scanAfterPush(serial, remoteDir) {
        const client = global.clipboardSyncManager?.getClientForSerial?.(serial);
        if (!client) return;
        await global.clipboardSyncManager.sendScanFile(client, remoteDir);
    }

    async function pushPaths(event, payload, localPaths) {
        const manager = getDeviceFsManager?.();
        const serial = await resolveDeviceSerial(payload);
        const deviceKey = payload.deviceId || payload.stableDeviceId || serial;
        const remoteDir = payload.path || manager.getPushTarget(deviceKey) || DEFAULT_PUSH_TARGET;
        const apks = localPaths.filter((item) => manager.isApk(item));
        const others = localPaths.filter((item) => !manager.isApk(item));
        const transferId = `fs-${Date.now()}`;

        if (apks.length) {
            for (const apk of apks) {
                await manager.installApk(serial, apk, (progress) => {
                    sendProgress({ transferId, ...progress });
                });
            }
        }

        let pushed = { remoteDir, files: [] };
        if (others.length) {
            pushed = await manager.push(serial, others, remoteDir, (progress) => {
                sendProgress({ transferId, ...progress });
            });
            await scanAfterPush(serial, pushed.remoteDir);
        }

        const count = apks.length + others.length;
        sendToast(
            apks.length && !others.length
                ? (apks.length === 1 ? "APK installé" : `${apks.length} APK installés`)
                : `${count} élément(s) envoyé(s)`,
            "success"
        );
        return {
            success: true,
            remoteDir: pushed.remoteDir,
            installed: apks.length,
            pushed: others.length
        };
    }

    ipcMain.handle("device-fs:push-paths", async (event, payload = {}) => {
        try {
            const paths = Array.isArray(payload.paths) ? payload.paths : [];
            if (paths.length === 0) return { success: false, error: "Aucun fichier" };
            return await pushPaths(event, payload, paths);
        } catch (err) {
            sendToast(err?.message || String(err), "error");
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.handle("device-fs:pull", async (event, payload = {}) => {
        try {
            const manager = getDeviceFsManager?.();
            if (!manager) return { success: false, error: "Explorateur indisponible" };
            const serial = await resolveDeviceSerial(payload);
            const parent = parentWindow(event);
            const remotePath = payload.path;
            const name = String(payload.name || path.basename(String(remotePath || "")) || "download");
            const isDir = payload.isDir === true;
            let dest = payload.dest || "";

            if (!dest) {
                if (isDir) {
                    const picked = await dialog.showOpenDialog(parent, {
                        properties: ["openDirectory", "createDirectory"],
                        title: name
                    });
                    if (picked.canceled || !picked.filePaths?.[0]) {
                        return { success: false, cancelled: true };
                    }
                    dest = picked.filePaths[0];
                } else {
                    const picked = await dialog.showSaveDialog(parent, {
                        defaultPath: name
                    });
                    if (picked.canceled || !picked.filePath) {
                        return { success: false, cancelled: true };
                    }
                    dest = picked.filePath;
                }
            }

            const transferId = `fs-${Date.now()}`;
            const result = await manager.pull(serial, remotePath, dest, (progress) => {
                sendProgress({ transferId, ...progress });
            });
            sendToast(`${result.name} récupéré`, "success");
            return { success: true, ...result };
        } catch (err) {
            sendToast(err?.message || String(err), "error");
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.handle("device-fs:open-explorer", async (_event, payload = {}) => {
        const modal = global.hubModalOverlayManager;
        if (!modal?.open) {
            return { success: false, error: "Fenêtre Hub indisponible" };
        }
        await modal.open({
            panel: "settings",
            tab: "files",
            openFiles: {
                deviceId: payload.deviceId || null,
                serial: payload.serial || null,
                deviceName: payload.deviceName || ""
            }
        });
        return { success: true };
    });
}

module.exports = { registerDeviceFsHandlers };
