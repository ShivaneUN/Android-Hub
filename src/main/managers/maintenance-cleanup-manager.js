const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;

const CLEANUP_CATEGORIES = {
    cache: { label: "Cache" },
    history: { label: "Historique des apps" }
};

const DEFAULT_PREFERENCES = {
    autoClean: {
        enabled: true,
        cache: true,
        history: true
    }
};

function toBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    const precision = index === 0 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[index]}`;
}

function parseMaxAgeDaysFromEnv() {
    const raw = process.env.ANDROID_HUB_CLEANUP_MAX_AGE_DAYS;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return DEFAULT_MAX_AGE_DAYS;
}

function normalizeCategories(categories = {}) {
    return {
        cache: categories.cache !== false,
        history: categories.history !== false
    };
}

function respectsMaxAge(reason) {
    return reason === "startup" || reason === "interval";
}

function createEmptyCategoryResult(selected = false) {
    return {
        selected,
        matchedFiles: 0,
        deletedFiles: 0,
        skippedLocked: 0,
        skippedErrors: 0,
        bytesEligible: 0,
        bytesFreed: 0,
        entriesEligible: 0,
        entriesRemoved: 0
    };
}

class MaintenanceCleanupManager {
    constructor(userDataPath, options = {}) {
        this.userDataPath = userDataPath;
        this.maxAgeDays = Number.isFinite(options.maxAgeDays) && options.maxAgeDays > 0
            ? options.maxAgeDays
            : parseMaxAgeDaysFromEnv();
        this.maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;
        this.autoIntervalMs = Number.isFinite(options.autoIntervalMs) && options.autoIntervalMs > 0
            ? options.autoIntervalMs
            : DEFAULT_AUTO_INTERVAL_MS;
        this.launchHistoryManager = options.launchHistoryManager || null;
        this.preferencesPath = path.join(userDataPath, "maintenance-preferences.json");
        this.preferences = this.loadPreferences();
        this.autoTimer = null;
        this.cleanupInFlight = false;
    }

    setLaunchHistoryManager(manager) {
        this.launchHistoryManager = manager || null;
    }

    loadPreferences() {
        try {
            if (!fs.existsSync(this.preferencesPath)) {
                return structuredClone(DEFAULT_PREFERENCES);
            }

            const parsed = JSON.parse(fs.readFileSync(this.preferencesPath, "utf-8"));
            const autoClean = parsed?.autoClean && typeof parsed.autoClean === "object"
                ? parsed.autoClean
                : {};

            return {
                autoClean: {
                    enabled: autoClean.enabled !== false,
                    cache: autoClean.cache !== false,
                    history: autoClean.history !== false
                }
            };
        } catch (err) {
            console.error("[MaintenanceCleanupManager] Erreur lecture préférences:", err.message);
            return structuredClone(DEFAULT_PREFERENCES);
        }
    }

    savePreferences() {
        try {
            fs.writeFileSync(this.preferencesPath, JSON.stringify(this.preferences, null, 2), "utf-8");
        } catch (err) {
            console.error("[MaintenanceCleanupManager] Erreur écriture préférences:", err.message);
        }
    }

    getPreferences() {
        return structuredClone(this.preferences);
    }

    isAutoCleanupEnabled() {
        return this.preferences?.autoClean?.enabled !== false;
    }

    setPreferences(nextPreferences = {}) {
        const autoClean = nextPreferences?.autoClean && typeof nextPreferences.autoClean === "object"
            ? nextPreferences.autoClean
            : {};
        const wasEnabled = this.isAutoCleanupEnabled();

        this.preferences = {
            autoClean: {
                enabled: autoClean.enabled !== false,
                cache: autoClean.cache !== false,
                history: autoClean.history !== false
            }
        };
        this.savePreferences();

        const nowEnabled = this.isAutoCleanupEnabled();
        if (!nowEnabled) {
            this.stopAutoCleanup();
        } else if (!wasEnabled || !this.autoTimer) {
            void this.startAutoCleanup();
        }

        return this.getPreferences();
    }

    getAutoCategories() {
        const { autoClean } = this.preferences;
        return {
            cache: autoClean.cache !== false,
            history: autoClean.history !== false
        };
    }

    buildTargetsByCategory() {
        const resolve = (...parts) => path.join(this.userDataPath, ...parts);
        return {
            cache: [
                {
                    key: "app-icons-dir",
                    type: "directory",
                    rootPath: resolve("app-icons"),
                    recursive: true
                },
                {
                    key: "app-metadata-cache-index",
                    type: "file",
                    rootPath: resolve("app-metadata-cache.json")
                },
                {
                    key: "cache-dir",
                    type: "directory",
                    rootPath: resolve("cache"),
                    recursive: true
                }
            ]
        };
    }

    getConfig() {
        const targetsByCategory = this.buildTargetsByCategory();
        return {
            maxAgeDays: this.maxAgeDays,
            maxAgeMs: this.maxAgeMs,
            autoIntervalMs: this.autoIntervalMs,
            categories: Object.keys(CLEANUP_CATEGORIES),
            preferences: this.getPreferences(),
            targets: Object.entries(targetsByCategory).flatMap(([category, targets]) =>
                targets.map((target) => ({
                    category,
                    key: target.key,
                    rootPath: target.rootPath,
                    type: target.type
                }))
            )
        };
    }

    async startAutoCleanup() {
        this.stopAutoCleanup();
        if (!this.isAutoCleanupEnabled()) {
            return;
        }

        const categories = this.getAutoCategories();
        if (!categories.cache && !categories.history) {
            return;
        }

        await this.runCleanup({ reason: "startup", dryRun: false, categories });
        this.autoTimer = setInterval(() => {
            if (!this.isAutoCleanupEnabled()) {
                this.stopAutoCleanup();
                return;
            }
            const nextCategories = this.getAutoCategories();
            if (!nextCategories.cache && !nextCategories.history) {
                return;
            }
            void this.runCleanup({
                reason: "interval",
                dryRun: false,
                categories: nextCategories
            });
        }, this.autoIntervalMs);
    }

    applyAutoCleanupSchedule() {
        if (!this.isAutoCleanupEnabled()) {
            this.stopAutoCleanup();
            return;
        }
        if (this.autoTimer) {
            return;
        }
        void this.startAutoCleanup();
    }

    stopAutoCleanup() {
        if (this.autoTimer) {
            clearInterval(this.autoTimer);
            this.autoTimer = null;
        }
    }

    async previewCleanup(categories) {
        return this.runCleanup({
            reason: "preview",
            dryRun: true,
            categories: normalizeCategories(categories)
        });
    }

    resolveCutoff(reason) {
        // Auto : conserve les N derniers jours. Manuel / preview : tout est éligible.
        if (respectsMaxAge(reason)) {
            return Date.now() - this.maxAgeMs;
        }
        return Date.now();
    }

    async runCleanup({ reason = "manual", dryRun = false, categories } = {}) {
        if (this.cleanupInFlight) {
            return {
                success: false,
                error: "Nettoyage déjà en cours."
            };
        }

        const selectedCategories = normalizeCategories(categories);
        this.cleanupInFlight = true;
        const startedAt = Date.now();
        const cutoff = this.resolveCutoff(reason);

        try {
            const categoryResults = {
                cache: createEmptyCategoryResult(selectedCategories.cache),
                history: createEmptyCategoryResult(selectedCategories.history)
            };

            let filesScanned = 0;
            const touchedTargets = [];

            if (selectedCategories.cache) {
                const fileCandidates = await this.collectFileCandidates(selectedCategories, cutoff);
                filesScanned += fileCandidates.scannedCount;
                touchedTargets.push(...fileCandidates.touchedTargets);

                for (const entry of fileCandidates.entries) {
                    const bucket = categoryResults[entry.category];
                    if (!bucket) continue;

                    bucket.matchedFiles += 1;
                    bucket.bytesEligible += entry.size;

                    if (!dryRun) {
                        const deletion = await this.tryDeleteFile(entry.filePath);
                        if (deletion.deleted) {
                            bucket.deletedFiles += 1;
                            bucket.bytesFreed += entry.size;
                        } else if (deletion.locked) {
                            bucket.skippedLocked += 1;
                        } else {
                            bucket.skippedErrors += 1;
                        }
                    }
                }

                if (!dryRun) {
                    await this.pruneEmptyTargetDirectories(selectedCategories);
                }
            }

            if (selectedCategories.history) {
                const historyResult = await this.cleanupHistory({ cutoff, dryRun });
                categoryResults.history.entriesEligible = historyResult.entriesEligible;
                categoryResults.history.entriesRemoved = historyResult.entriesRemoved;
            }

            const result = {
                success: true,
                reason,
                dryRun,
                maxAgeDays: this.maxAgeDays,
                respectMaxAge: respectsMaxAge(reason),
                categories: selectedCategories,
                categoryResults,
                filesScanned,
                matchedFiles: categoryResults.cache.matchedFiles,
                deletedFiles: categoryResults.cache.deletedFiles,
                skippedLocked: categoryResults.cache.skippedLocked,
                skippedErrors: categoryResults.cache.skippedErrors,
                bytesEligible: categoryResults.cache.bytesEligible,
                bytesFreed: categoryResults.cache.bytesFreed,
                historyEntriesEligible: categoryResults.history.entriesEligible,
                historyEntriesRemoved: categoryResults.history.entriesRemoved,
                touchedTargets,
                durationMs: Date.now() - startedAt
            };

            return result;
        } catch (err) {
            return {
                success: false,
                error: err.message || String(err)
            };
        } finally {
            this.cleanupInFlight = false;
        }
    }

    async collectFileCandidates(selectedCategories, cutoff) {
        const entries = [];
        let scannedCount = 0;
        const touchedTargets = [];
        const targetsByCategory = this.buildTargetsByCategory();

        for (const [category, targets] of Object.entries(targetsByCategory)) {
            if (!selectedCategories[category]) continue;

            for (const target of targets) {
                if (!fs.existsSync(target.rootPath)) continue;
                touchedTargets.push(target.rootPath);

                if (target.type === "file") {
                    scannedCount += 1;
                    const stat = await fs.promises.stat(target.rootPath).catch(() => null);
                    if (!stat || !stat.isFile()) continue;
                    if (stat.mtimeMs <= cutoff) {
                        entries.push({
                            category,
                            filePath: target.rootPath,
                            size: stat.size
                        });
                    }
                    continue;
                }

                if (target.type === "directory") {
                    const directoryEntries = await this.collectDirectoryCandidates(
                        target.rootPath,
                        cutoff,
                        target.recursive
                    );
                    scannedCount += directoryEntries.scannedCount;
                    entries.push(...directoryEntries.entries.map((entry) => ({
                        ...entry,
                        category
                    })));
                }
            }
        }

        return {
            entries,
            scannedCount,
            touchedTargets
        };
    }

    async cleanupHistory({ cutoff, dryRun }) {
        const manager = this.launchHistoryManager;
        if (!manager || typeof manager.purgeOlderThan !== "function") {
            return { entriesEligible: 0, entriesRemoved: 0 };
        }

        return manager.purgeOlderThan(cutoff, { dryRun });
    }

    async collectDirectoryCandidates(rootPath, cutoff, recursive = true) {
        const entries = [];
        let scannedCount = 0;

        const stack = [rootPath];
        while (stack.length > 0) {
            const currentPath = stack.pop();
            let dirents = [];
            try {
                dirents = await fs.promises.readdir(currentPath, { withFileTypes: true });
            } catch (_err) {
                continue;
            }

            for (const dirent of dirents) {
                const fullPath = path.join(currentPath, dirent.name);
                if (dirent.isDirectory()) {
                    if (recursive) {
                        stack.push(fullPath);
                    }
                    continue;
                }
                if (!dirent.isFile()) continue;

                scannedCount += 1;
                const stat = await fs.promises.stat(fullPath).catch(() => null);
                if (!stat || !stat.isFile()) continue;
                if (stat.mtimeMs > cutoff) continue;

                entries.push({
                    filePath: fullPath,
                    size: stat.size
                });
            }
        }

        return {
            entries,
            scannedCount
        };
    }

    async tryDeleteFile(filePath) {
        try {
            const handle = await fs.promises.open(filePath, "r+");
            await handle.close();
        } catch (err) {
            if (["EBUSY", "EPERM", "EACCES"].includes(err.code)) {
                return { deleted: false, locked: true };
            }
        }

        try {
            await fs.promises.unlink(filePath);
            return { deleted: true, locked: false };
        } catch (err) {
            if (["EBUSY", "EPERM", "EACCES"].includes(err.code)) {
                return { deleted: false, locked: true };
            }
            return { deleted: false, locked: false };
        }
    }

    async pruneEmptyTargetDirectories(selectedCategories) {
        const targetsByCategory = this.buildTargetsByCategory();
        const directories = [];

        for (const [category, targets] of Object.entries(targetsByCategory)) {
            if (!selectedCategories[category]) continue;
            for (const target of targets) {
                if (target.type === "directory") {
                    directories.push(target.rootPath);
                }
            }
        }

        for (const rootPath of directories) {
            if (!fs.existsSync(rootPath)) continue;
            await this.pruneEmptyChildren(rootPath);
        }
    }

    async pruneEmptyChildren(rootPath) {
        let dirents = [];
        try {
            dirents = await fs.promises.readdir(rootPath, { withFileTypes: true });
        } catch (_err) {
            return false;
        }

        let hasFiles = false;
        for (const dirent of dirents) {
            const fullPath = path.join(rootPath, dirent.name);
            if (dirent.isDirectory()) {
                const removed = await this.pruneEmptyChildren(fullPath);
                if (!removed) {
                    hasFiles = true;
                }
                continue;
            }
            if (dirent.isFile()) {
                hasFiles = true;
            }
        }

        if (!hasFiles) {
            try {
                await fs.promises.rmdir(rootPath);
                return true;
            } catch (_err) {
                return false;
            }
        }

        return false;
    }

    formatSummary(result) {
        if (!result?.success) {
            return "Nettoyage impossible.";
        }
        return this.formatCategorySummary(result, { dryRun: result.dryRun });
    }

    formatCategorySummary(result, { dryRun = false } = {}) {
        const parts = [];
        const categoryResults = result.categoryResults || {};
        const selectedCategories = result.categories || {};

        for (const [key, meta] of Object.entries(CLEANUP_CATEGORIES)) {
            if (!selectedCategories[key]) {
                parts.push(`${meta.label}: non sélectionné`);
                continue;
            }

            const bucket = categoryResults[key] || {};
            if (key === "history") {
                const count = dryRun ? bucket.entriesEligible : bucket.entriesRemoved;
                parts.push(`${meta.label}: ${count} entrée(s) supprimée(s)`);
                continue;
            }

            const bytes = dryRun ? bucket.bytesEligible : bucket.bytesFreed;
            parts.push(`${meta.label}: ${toBytes(bytes)} supprimés`);
        }

        return parts.join(" — ");
    }
}

module.exports = {
    MaintenanceCleanupManager,
    CLEANUP_CATEGORIES,
    DEFAULT_MAX_AGE_DAYS,
    DEFAULT_AUTO_INTERVAL_MS,
    DEFAULT_PREFERENCES,
    toBytes,
    normalizeCategories,
    respectsMaxAge
};
