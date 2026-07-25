const {
    toBytes,
    CLEANUP_CATEGORIES,
    normalizeCategories
} = require("../managers/maintenance-cleanup-manager");

function buildCategoryPreview(categoryResults = {}, selectedCategories = {}) {
    const preview = {};

    for (const [key, meta] of Object.entries(CLEANUP_CATEGORIES)) {
        const bucket = categoryResults[key] || {};
        if (key === "history") {
            preview[key] = {
                label: meta.label,
                selected: selectedCategories[key] !== false,
                entries: bucket.entriesEligible || 0,
                detail: `${bucket.entriesEligible || 0} entrée(s)`
            };
            continue;
        }

        const bytes = bucket.bytesEligible || 0;
        preview[key] = {
            label: meta.label,
            selected: selectedCategories[key] !== false,
            bytes,
            files: bucket.matchedFiles || 0,
            detail: toBytes(bytes)
        };
    }

    return preview;
}

function buildUiSummary(result) {
    if (!result?.success) {
        return {
            message: result?.error || "Nettoyage impossible."
        };
    }

    const managerLike = {
        formatCategorySummary: (payload, options) => {
            const parts = [];
            const categoryResults = payload.categoryResults || {};
            const selectedCategories = payload.categories || {};

            for (const [key, meta] of Object.entries(CLEANUP_CATEGORIES)) {
                if (!selectedCategories[key]) {
                    parts.push(`${meta.label}: non sélectionné`);
                    continue;
                }

                const bucket = categoryResults[key] || {};
                if (key === "history") {
                    const count = options?.dryRun ? bucket.entriesEligible : bucket.entriesRemoved;
                    parts.push(`${meta.label}: ${count} entrée(s) supprimée(s)`);
                    continue;
                }

                const bytes = options?.dryRun ? bucket.bytesEligible : bucket.bytesFreed;
                parts.push(`${meta.label}: ${toBytes(bytes)} supprimés`);
            }

            return parts.join(" — ");
        }
    };

    const message = managerLike.formatCategorySummary(result, { dryRun: result.dryRun });
    return {
        message,
        bytes: result.bytesEligible ?? result.bytesFreed ?? 0,
        files: result.matchedFiles ?? result.deletedFiles ?? 0,
        historyEntries: result.historyEntriesEligible ?? result.historyEntriesRemoved ?? 0,
        categoryPreview: buildCategoryPreview(result.categoryResults, result.categories)
    };
}

function registerMaintenanceHandlers({
    ipcMain,
    getMaintenanceCleanupManager,
    notifyCleanupCompleted
} = {}) {
    ipcMain.handle("maintenance:cleanup-preview", async (_event, payload = {}) => {
        const manager = getMaintenanceCleanupManager?.();
        if (!manager) {
            return { success: false, error: "Service de maintenance indisponible." };
        }

        const categories = normalizeCategories(payload.categories);
        const result = await manager.previewCleanup(categories);
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
        const categories = normalizeCategories(payload.categories);
        const result = await manager.runCleanup({ reason, dryRun: false, categories });
        if (result?.success && typeof notifyCleanupCompleted === "function") {
            try {
                notifyCleanupCompleted(result);
            } catch (err) {
                console.warn("[maintenance] notifyCleanupCompleted:", err.message);
            }
        }
        return {
            ...result,
            summary: buildUiSummary(result),
            config: manager.getConfig()
        };
    });

    ipcMain.handle("maintenance:get-preferences", async () => {
        const manager = getMaintenanceCleanupManager?.();
        if (!manager) {
            return { success: false, error: "Service de maintenance indisponible." };
        }

        return {
            success: true,
            preferences: manager.getPreferences(),
            config: manager.getConfig()
        };
    });

    ipcMain.handle("maintenance:set-preferences", async (_event, payload = {}) => {
        const manager = getMaintenanceCleanupManager?.();
        if (!manager) {
            return { success: false, error: "Service de maintenance indisponible." };
        }

        const preferences = manager.setPreferences(payload.preferences || payload);
        return {
            success: true,
            preferences,
            config: manager.getConfig()
        };
    });
}

module.exports = { registerMaintenanceHandlers, buildUiSummary, buildCategoryPreview };
