function registerHubModalHandlers(getManager) {
    const { ipcMain } = require("electron");

    ipcMain.handle("hub-modal:open", async (_event, payload) => {
        const manager = getManager?.();
        if (!manager) return { success: false, error: "HubModalOverlayManager indisponible" };
        await manager.open(payload || {});
        return { success: true };
    });

    ipcMain.handle("hub-modal:close", async () => {
        const manager = getManager?.();
        if (!manager) return { success: false };
        manager.hide();
        return { success: true };
    });

    ipcMain.handle("hub-modal:isOpen", async () => {
        const manager = getManager?.();
        return {
            open: Boolean(manager?.isOpen?.()),
            panel: manager?.getCurrentPanel?.() || null
        };
    });

    ipcMain.handle("hub-modal:invoke-main", async (_event, { action, args }) => {
        const manager = getManager?.();
        const mainWindow = manager?.mainWindow;
        if (!mainWindow || mainWindow.isDestroyed()) {
            return { success: false, error: "Fenetre principale indisponible" };
        }

        const safeAction = String(action || "");
        const safeArgs = Array.isArray(args) ? args : [];
        const script = `(async () => {
            const fn = window.__hubModalMainActions?.[${JSON.stringify(safeAction)}];
            if (typeof fn !== "function") {
                throw new Error("Action hub modal inconnue: " + ${JSON.stringify(safeAction)});
            }
            return await fn(...${JSON.stringify(safeArgs)});
        })()`;

        try {
            const result = await mainWindow.webContents.executeJavaScript(script, true);
            return { success: true, result };
        } catch (err) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    ipcMain.on("hub-modal:close-request", () => {
        getManager()?.hide();
    });
}

module.exports = { registerHubModalHandlers };
