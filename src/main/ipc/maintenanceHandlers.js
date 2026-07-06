const { toBytes } = require("../managers/maintenance-cleanup-manager");

function buildUiSummary(result) {
    if (!result?.success) {
        return {
            message: result?.error || "Nettoyage impossible."
        };
    }

    const bytes = result.dryRun ? result.bytesEligible : result.bytesFreed;
    const files = result.dryRun ? result.matchedFiles : result.deletedFiles;
    return {
        message: `${toBytes(bytes)} libérés, ${files} fichier(s) supprimé(s)`,
        bytes,
        files
    };
}

function registerMaintenanceHandlers({ ipcMain, getMaintenanceCleanupManager } = {}) {
    ipcMain.handle("maintenance:cleanup-preview", async () => {
        const manager = getMaintenanceCleanupManager?.();
        if (!manager) {
            return { success: false, error: "Service de maintenance indisponible." };
        }

        const result = await manager.previewCleanup();
        return {
            ...result,
            summary: buildUiSummary(result),
            config: manager.getConfig()
        };
    });

    ipcMain.handle("maintenance:cleanup-run", async (_event, payload = {}) => {
        const manager = getMaintenanceCleanupManager?.();
        if (!manager) {
            return { success: false, error: "Service de maintenance indisponible." };
        }

        const reason = payload.reason || "manual";
        const result = await manager.runCleanup({ reason, dryRun: false });
        return {
            ...result,
            summary: buildUiSummary(result),
            config: manager.getConfig()
        };
    });
}

module.exports = { registerMaintenanceHandlers };
