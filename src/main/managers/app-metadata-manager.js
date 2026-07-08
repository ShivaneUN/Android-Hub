const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const {
    extractLabelFromDumpOutput,
    humanizePackageName,
    isUsableAppLabel
} = require("../../shared/app-display");
const { AppIconExtractor } = require("./app-icon-extractor");
const { adbSerialArg } = require("../../shared/adb-serial-arg");
const { isValidIconFileSize } = require("../../shared/app-icon-placeholder");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DUMP_TIMEOUT_MS = 12000;
const PREFETCH_CONCURRENCY = 2;
const DEFAULT_PREFETCH_MAX = 16;
const MAX_ICON_EXTRACT_ATTEMPTS = 3;

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(String(stdout || "").trim());
        });
    });
}

function execWithTimeout(command, timeoutMs) {
    return Promise.race([
        execPromise(command),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs);
        })
    ]);
}

class AppMetadataManager {
    constructor(userDataPath, adbPath, options = {}) {
        this.cacheRoot = path.join(userDataPath, "app-icons");
        this.indexPath = path.join(userDataPath, "app-metadata-cache.json");
        this.adbPath = adbPath;
        this.notifyUpdate = typeof options.notifyUpdate === "function" ? options.notifyUpdate : null;
        this.iconExtractor = new AppIconExtractor(adbPath);
        this.index = {};
        this.prefetchQueues = new Map();
        this.loadIndex();
        fs.mkdirSync(this.cacheRoot, { recursive: true });
    }

    buildKey(deviceId, packageName, userId = null) {
        const uid = Number.isInteger(userId) ? userId : 0;
        return `${String(deviceId || "")}::${String(packageName || "")}::${uid}`;
    }

    buildLookupKeys(cacheDeviceId, packageName, userId = null, transportSerial = null) {
        const keys = [];
        const seen = new Set();
        for (const deviceId of [cacheDeviceId, transportSerial]) {
            if (!deviceId) continue;
            const key = this.buildKey(deviceId, packageName, userId);
            if (seen.has(key)) continue;
            seen.add(key);
            keys.push(key);
        }
        return keys;
    }

    loadIndex() {
        try {
            if (!fs.existsSync(this.indexPath)) {
                this.index = {};
                return;
            }
            const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
            this.index = parsed && typeof parsed === "object" ? parsed : {};
        } catch (err) {
            console.warn("[AppMetadataManager] lecture cache:", err.message);
            this.index = {};
        }
    }

    saveIndex() {
        try {
            fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), "utf-8");
        } catch (err) {
            console.warn("[AppMetadataManager] ecriture cache:", err.message);
        }
    }

    isFresh(entry) {
        if (!entry?.fetchedAt) return false;
        if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return false;
        if (entry.iconPath && !fs.existsSync(entry.iconPath)) return false;
        return true;
    }

    hasUsableIcon(entry) {
        return isValidIconFileSize(entry?.iconPath);
    }

    shouldRetryIconExtract(entry) {
        if (!entry) return true;
        if (this.hasUsableIcon(entry)) return false;
        const attempts = Number(entry.iconAttempts) || 0;
        return attempts < MAX_ICON_EXTRACT_ATTEMPTS;
    }

    resolveAppName(entry, fallbackPackage = "") {
        if (entry?.appName && isUsableAppLabel(entry.appName)) {
            return entry.appName.trim();
        }
        return humanizePackageName(fallbackPackage);
    }

    formatCachedEntry(entry, packageName) {
        const iconPath = this.hasUsableIcon(entry) ? entry.iconPath : null;
        return {
            ...entry,
            iconPath,
            appName: this.resolveAppName(entry, packageName),
            iconUrl: this.iconExtractor.toIconUrl(iconPath)
        };
    }

    rejectFalsePositiveCacheEntry(found, cacheDeviceId, packageName, userId = null) {
        if (!found?.entry) return;
        const entry = found.entry;
        const previousAttempts = Number(entry.iconAttempts) || 0;

        if (entry.iconPath && fs.existsSync(entry.iconPath)) {
            try {
                fs.unlinkSync(entry.iconPath);
            } catch (_err) {
                // noop
            }
        }

        this.setCachedEntry(cacheDeviceId, packageName, userId, {
            appName: entry.appName,
            iconPath: null,
            iconAttempts: Math.min(previousAttempts + 1, MAX_ICON_EXTRACT_ATTEMPTS),
            versionCode: entry.versionCode ?? null
        });
    }

    lookupCacheEntry(cacheDeviceId, packageName, userId = null, transportSerial = null) {
        for (const key of this.buildLookupKeys(cacheDeviceId, packageName, userId, transportSerial)) {
            const entry = this.index[key];
            if (!entry || !this.isFresh(entry)) continue;
            return { entry, key };
        }
        return null;
    }

    migrateCacheEntry(found, cacheDeviceId, packageName, userId = null) {
        if (!found) return;
        const canonicalKey = this.buildKey(cacheDeviceId, packageName, userId);
        if (found.key === canonicalKey) return;

        this.index[canonicalKey] = {
            ...found.entry,
            deviceId: cacheDeviceId
        };
        delete this.index[found.key];
        this.saveIndex();
    }

    async resolveDeviceContext(deviceId) {
        const transportSerial = String(deviceId || "");
        let cacheDeviceId = transportSerial;
        let adbSerial = transportSerial;

        if (global.deviceRegistry) {
            try {
                const stable = await global.deviceRegistry.resolveStableDeviceIdFromTransport(transportSerial);
                if (stable) cacheDeviceId = stable;
            } catch (_err) {
                // noop
            }

            try {
                const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
                    deviceId: cacheDeviceId,
                    serial: transportSerial
                });
                if (resolved) adbSerial = resolved;
            } catch (_err) {
                // noop
            }
        }

        return { cacheDeviceId, adbSerial, transportSerial };
    }

    getCachedEntry(deviceId, packageName, userId = null, { transportSerial = null } = {}) {
        const found = this.lookupCacheEntry(deviceId, packageName, userId, transportSerial || deviceId);
        if (!found) return null;
        return this.formatCachedEntry(found.entry, packageName);
    }

    setCachedEntry(deviceId, packageName, userId, data) {
        const key = this.buildKey(deviceId, packageName, userId);
        const previous = this.index[key] || {};
        const iconAttempts = data.iconAttempts !== undefined
            ? data.iconAttempts
            : (previous.iconAttempts || 0);

        this.index[key] = {
            deviceId,
            packageName,
            userId: Number.isInteger(userId) ? userId : 0,
            appName: data.appName || previous.appName || humanizePackageName(packageName),
            iconPath: data.iconPath !== undefined ? data.iconPath : (previous.iconPath || null),
            iconAttempts: this.hasUsableIcon({ iconPath: data.iconPath }) ? 0 : iconAttempts,
            versionCode: data.versionCode !== undefined ? data.versionCode : (previous.versionCode ?? null),
            fetchedAt: Date.now()
        };
        this.saveIndex();
        return this.index[key];
    }

    invalidate(deviceId, packageName, userId = null, { transportSerial = null } = {}) {
        const keys = this.buildLookupKeys(deviceId, packageName, userId, transportSerial || deviceId);
        let changed = false;

        for (const key of keys) {
            const entry = this.index[key];
            if (!entry) continue;
            if (entry.iconPath && fs.existsSync(entry.iconPath)) {
                try {
                    fs.unlinkSync(entry.iconPath);
                } catch (_err) {
                    // noop
                }
            }
            delete this.index[key];
            changed = true;
        }

        if (changed) {
            this.saveIndex();
        }
    }

    pruneForDevice(deviceId, activePackageKeys) {
        let changed = false;
        for (const [key, entry] of Object.entries(this.index)) {
            if (entry.deviceId !== deviceId) continue;
            const activeKey = this.buildKey(entry.deviceId, entry.packageName, entry.userId);
            if (activePackageKeys.has(activeKey)) continue;

            if (entry.iconPath && fs.existsSync(entry.iconPath)) {
                try {
                    fs.unlinkSync(entry.iconPath);
                } catch (_err) {
                    // noop
                }
            }
            delete this.index[key];
            changed = true;
        }

        if (changed) {
            this.saveIndex();
        }
        return changed;
    }

    async fetchLabelFromDump(serial, packageName, userId = null) {
        const userArg = Number.isInteger(userId) ? ` --user ${userId}` : "";
        try {
            const stdout = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell pm dump${userArg} ${packageName}`,
                DUMP_TIMEOUT_MS
            );
            const label = extractLabelFromDumpOutput(stdout);
            if (isUsableAppLabel(label)) {
                return label.trim();
            }
        } catch (err) {
            console.warn(`[AppMetadataManager] pm dump ${packageName}:`, err.message);
        }
        return null;
    }

    async fetchVersionCode(serial, packageName, userId = null) {
        const userArg = Number.isInteger(userId) ? ` --user ${userId}` : "";
        try {
            const stdout = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell dumpsys package${userArg} ${packageName}`,
                DUMP_TIMEOUT_MS
            );
            const match = stdout.match(/versionCode=(\d+)/);
            return match ? Number(match[1]) : null;
        } catch (_err) {
            return null;
        }
    }

    needsIconExtraction(cacheDeviceId, packageName, userId = null, transportSerial = null) {
        const found = this.lookupCacheEntry(cacheDeviceId, packageName, userId, transportSerial);
        if (!found) return true;
        if (this.hasUsableIcon(found.entry)) return false;
        return this.shouldRetryIconExtract(found.entry);
    }

    async resolveOne(deviceId, packageName, userId = null, { appNameHint = null } = {}) {
        const ctx = await this.resolveDeviceContext(deviceId);
        const found = this.lookupCacheEntry(
            ctx.cacheDeviceId,
            packageName,
            userId,
            ctx.transportSerial
        );

        if (found) {
            this.migrateCacheEntry(found, ctx.cacheDeviceId, packageName, userId);
            const cached = this.formatCachedEntry(
                this.index[this.buildKey(ctx.cacheDeviceId, packageName, userId)] || found.entry,
                packageName
            );

            if (this.hasUsableIcon(cached)) {
                return {
                    appName: cached.appName,
                    iconPath: cached.iconPath,
                    iconUrl: cached.iconUrl
                };
            }

            if (!this.shouldRetryIconExtract(cached)) {
                return {
                    appName: cached.appName,
                    iconPath: null,
                    iconUrl: null
                };
            }

            this.rejectFalsePositiveCacheEntry(found, ctx.cacheDeviceId, packageName, userId);
        }

        const refreshedFound = this.lookupCacheEntry(
            ctx.cacheDeviceId,
            packageName,
            userId,
            ctx.transportSerial
        );
        let appName = isUsableAppLabel(appNameHint) ? appNameHint.trim() : null;
        if (!appName) {
            appName = await this.fetchLabelFromDump(ctx.adbSerial, packageName, userId);
        }
        if (!appName) {
            appName = refreshedFound?.entry?.appName
                || found?.entry?.appName
                || humanizePackageName(packageName);
        }

        const iconPath = this.iconExtractor.buildIconFilePath(
            this.cacheRoot,
            ctx.cacheDeviceId,
            packageName,
            userId
        );
        let savedIconPath = null;
        const previousAttempts = Number(
            this.index[this.buildKey(ctx.cacheDeviceId, packageName, userId)]?.iconAttempts
            || refreshedFound?.entry?.iconAttempts
            || found?.entry?.iconAttempts
            || 0
        );

        try {
            savedIconPath = await this.iconExtractor.extractIcon(
                ctx.adbSerial,
                packageName,
                iconPath,
                userId
            );
        } catch (err) {
            console.warn(`[AppMetadataManager] icone ${packageName}:`, err.message);
            this.invalidate(ctx.cacheDeviceId, packageName, userId, {
                transportSerial: ctx.transportSerial
            });
        }

        const versionCode = await this.fetchVersionCode(ctx.adbSerial, packageName, userId);
        const nextAttempts = savedIconPath ? 0 : previousAttempts + 1;

        this.setCachedEntry(ctx.cacheDeviceId, packageName, userId, {
            appName,
            iconPath: savedIconPath,
            iconAttempts: nextAttempts,
            versionCode
        });

        return {
            appName,
            iconPath: savedIconPath,
            iconUrl: this.iconExtractor.toIconUrl(savedIconPath)
        };
    }

    mergeAppMetadata(cacheDeviceId, app, transportSerial = null) {
        const packageName = app.package || app.packageName;
        const userId = app.userId ?? null;
        const found = this.lookupCacheEntry(cacheDeviceId, packageName, userId, transportSerial);
        if (found) {
            this.migrateCacheEntry(found, cacheDeviceId, packageName, userId);
        }

        const cached = this.getCachedEntry(cacheDeviceId, packageName, userId, { transportSerial });
        const appNameHint = app.labelName || app.displayName || app.appName || null;

        const appName = cached?.appName
            || (isUsableAppLabel(appNameHint) ? appNameHint.trim() : humanizePackageName(packageName));

        return {
            ...app,
            appName,
            labelName: app.labelName || appName,
            displayName: app.displayName || appName,
            iconPath: cached?.iconPath || app.iconPath || null,
            iconUrl: cached?.iconUrl || app.iconUrl || null
        };
    }

    async enrichApps(serial, apps = []) {
        const ctx = await this.resolveDeviceContext(serial);
        const activeKeys = new Set();
        const enriched = apps.map((app) => {
            const merged = this.mergeAppMetadata(ctx.cacheDeviceId, app, ctx.transportSerial);
            activeKeys.add(this.buildKey(ctx.cacheDeviceId, merged.package, merged.userId));
            return merged;
        });

        this.pruneForDevice(ctx.cacheDeviceId, activeKeys);
        return enriched;
    }

    async queuePrefetch(deviceId, apps = [], options = {}) {
        const notify = typeof options.onUpdate === "function"
            ? options.onUpdate
            : this.notifyUpdate;
        const maxCount = Number.isInteger(options.maxCount) && options.maxCount > 0
            ? options.maxCount
            : DEFAULT_PREFETCH_MAX;

        const ctx = await this.resolveDeviceContext(deviceId);

        const pending = apps.filter((app) => {
            const packageName = app.package || app.packageName;
            return packageName && this.needsIconExtraction(
                ctx.cacheDeviceId,
                packageName,
                app.userId ?? null,
                ctx.transportSerial
            );
        });

        if (!pending.length) return;

        const queueKey = ctx.cacheDeviceId;
        const existing = this.prefetchQueues.get(queueKey) || [];
        const remaining = Math.max(0, maxCount - existing.length);
        if (remaining === 0) return;

        const toAdd = pending.slice(0, remaining);
        if (!toAdd.length) return;

        if (this.prefetchQueues.has(queueKey)) {
            this.prefetchQueues.get(queueKey).push(...toAdd);
            return;
        }

        this.prefetchQueues.set(queueKey, [...toAdd]);

        const runQueue = async () => {
            while (this.prefetchQueues.get(queueKey)?.length) {
                const batch = this.prefetchQueues.get(queueKey).splice(0, PREFETCH_CONCURRENCY);
                const results = await Promise.all(batch.map(async (app) => {
                    const packageName = app.package || app.packageName;
                    try {
                        const metadata = await this.resolveOne(deviceId, packageName, app.userId ?? null, {
                            appNameHint: app.labelName || app.displayName || app.appName
                        });
                        return {
                            deviceId: ctx.cacheDeviceId,
                            package: packageName,
                            packageName,
                            userId: app.userId ?? null,
                            appName: metadata.appName,
                            iconPath: metadata.iconPath,
                            iconUrl: metadata.iconUrl
                        };
                    } catch (err) {
                        console.warn(`[AppMetadataManager] prefetch ${packageName}:`, err.message);
                        return null;
                    }
                }));

                const updates = results.filter(Boolean);
                if (updates.length && typeof notify === "function") {
                    notify({ serial: ctx.transportSerial, updates });
                }
            }

            this.prefetchQueues.delete(queueKey);
        };

        runQueue().catch((err) => {
            console.warn("[AppMetadataManager] prefetch queue:", err.message);
            this.prefetchQueues.delete(queueKey);
        });
    }

    async enrichHistoryEntries(entries = []) {
        const enriched = [];

        for (const entry of entries) {
            const merged = { ...entry };
            const ctx = await this.resolveDeviceContext(entry.deviceId);
            const cached = this.getCachedEntry(
                ctx.cacheDeviceId,
                entry.packageName,
                entry.userId ?? null,
                { transportSerial: ctx.transportSerial }
            );

            if (cached) {
                merged.appName = cached.appName || entry.appName || entry.packageName;
                merged.iconPath = cached.iconPath || entry.iconPath || null;
                merged.iconUrl = cached.iconUrl || entry.iconUrl || null;
            } else {
                merged.appName = isUsableAppLabel(entry.appName)
                    ? entry.appName
                    : humanizePackageName(entry.packageName);
            }

            enriched.push(merged);
        }

        const uncachedHistoryApps = [];
        for (const entry of enriched) {
            if (!entry.deviceId || !entry.packageName) continue;
            const ctx = await this.resolveDeviceContext(entry.deviceId);
            if (!this.needsIconExtraction(
                ctx.cacheDeviceId,
                entry.packageName,
                entry.userId ?? null,
                ctx.transportSerial
            )) {
                continue;
            }
            uncachedHistoryApps.push({
                deviceId: entry.deviceId,
                package: entry.packageName,
                packageName: entry.packageName,
                userId: entry.userId ?? null,
                appName: entry.appName
            });
        }

        if (uncachedHistoryApps.length) {
            const byDevice = new Map();
            for (const app of uncachedHistoryApps) {
                if (!byDevice.has(app.deviceId)) byDevice.set(app.deviceId, []);
                byDevice.get(app.deviceId).push(app);
            }
            for (const [historyDeviceId, apps] of byDevice.entries()) {
                this.queuePrefetch(historyDeviceId, apps, { maxCount: DEFAULT_PREFETCH_MAX });
            }
        }

        return enriched;
    }
}

module.exports = {
    AppMetadataManager,
    CACHE_TTL_MS,
    DEFAULT_PREFETCH_MAX,
    MAX_ICON_EXTRACT_ATTEMPTS
};
