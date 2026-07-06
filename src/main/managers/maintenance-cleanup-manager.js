const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
        this.autoTimer = null;
        this.cleanupInFlight = false;
    }

    buildTargets() {
        const resolve = (...parts) => path.join(this.userDataPath, ...parts);
        return [
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
                key: "update-log",
                type: "file",
                rootPath: resolve("update.log")
            },
            {
                key: "logs-dir",
                type: "directory",
                rootPath: resolve("logs"),
                recursive: true
            },
            {
                key: "cache-dir",
                type: "directory",
                rootPath: resolve("cache"),
                recursive: true
            }
        ];
    }

    getConfig() {
        return {
            maxAgeDays: this.maxAgeDays,
            maxAgeMs: this.maxAgeMs,
            autoIntervalMs: this.autoIntervalMs,
            targets: this.buildTargets().map((target) => ({
                key: target.key,
                rootPath: target.rootPath,
                type: target.type
            }))
        };
    }

    async startAutoCleanup() {
        await this.runCleanup({ reason: "startup", dryRun: false });
        this.stopAutoCleanup();
        this.autoTimer = setInterval(() => {
            void this.runCleanup({ reason: "interval", dryRun: false });
        }, this.autoIntervalMs);
    }

    stopAutoCleanup() {
        if (this.autoTimer) {
            clearInterval(this.autoTimer);
            this.autoTimer = null;
        }
    }

    async previewCleanup() {
        return this.runCleanup({ reason: "preview", dryRun: true });
    }

    async runCleanup({ reason = "manual", dryRun = false } = {}) {
        if (this.cleanupInFlight) {
            return {
                success: false,
                error: "Nettoyage déjà en cours."
            };
        }

        this.cleanupInFlight = true;
        const startedAt = Date.now();

        try {
            const candidates = await this.collectCandidates();
            const result = {
                success: true,
                reason,
                dryRun,
                maxAgeDays: this.maxAgeDays,
                filesScanned: candidates.scannedCount,
                matchedFiles: candidates.entries.length,
                deletedFiles: 0,
                skippedLocked: 0,
                skippedErrors: 0,
                bytesEligible: candidates.entries.reduce((sum, entry) => sum + entry.size, 0),
                bytesFreed: 0,
                touchedTargets: candidates.touchedTargets,
                durationMs: 0
            };

            if (!dryRun) {
                for (const entry of candidates.entries) {
                    const deletion = await this.tryDeleteFile(entry.filePath);
                    if (deletion.deleted) {
                        result.deletedFiles += 1;
                        result.bytesFreed += entry.size;
                    } else if (deletion.locked) {
                        result.skippedLocked += 1;
                    } else {
                        result.skippedErrors += 1;
                    }
                }

                await this.pruneEmptyTargetDirectories();
            }

            result.durationMs = Date.now() - startedAt;
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

    async collectCandidates() {
        const cutoff = Date.now() - this.maxAgeMs;
        const entries = [];
        let scannedCount = 0;
        const touchedTargets = [];

        const targets = this.buildTargets();
        for (const target of targets) {
            if (!fs.existsSync(target.rootPath)) continue;
            touchedTargets.push(target.rootPath);

            if (target.type === "file") {
                scannedCount += 1;
                const stat = await fs.promises.stat(target.rootPath).catch(() => null);
                if (!stat || !stat.isFile()) continue;
                if (stat.mtimeMs <= cutoff) {
                    entries.push({
                        filePath: target.rootPath,
                        size: stat.size
                    });
                }
                continue;
            }

            if (target.type === "directory") {
                const directoryEntries = await this.collectDirectoryCandidates(target.rootPath, cutoff, target.recursive);
                scannedCount += directoryEntries.scannedCount;
                entries.push(...directoryEntries.entries);
            }
        }

        return {
            entries,
            scannedCount,
            touchedTargets
        };
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
            // Best-effort lock check on Windows: opening in r+ fails if exclusively locked.
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

    async pruneEmptyTargetDirectories() {
        const directories = this.buildTargets()
            .filter((target) => target.type === "directory")
            .map((target) => target.rootPath);

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
        const bytes = result.dryRun ? result.bytesEligible : result.bytesFreed;
        const files = result.dryRun ? result.matchedFiles : result.deletedFiles;
        return `${toBytes(bytes)} · ${files} fichier(s)`;
    }
}

module.exports = {
    MaintenanceCleanupManager,
    DEFAULT_MAX_AGE_DAYS,
    DEFAULT_AUTO_INTERVAL_MS,
    toBytes
};
