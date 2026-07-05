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

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DUMP_TIMEOUT_MS = 12000;
const PREFETCH_CONCURRENCY = 2;
const DEFAULT_PREFETCH_MAX = 16;

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

    resolveAppName(entry, fallbackPackage = "") {
        if (entry?.appName && isUsableAppLabel(entry.appName)) {
            return entry.appName.trim();
        }
        return humanizePackageName(fallbackPackage);
    }

    getCachedEntry(deviceId, packageName, userId = null) {
        const key = this.buildKey(deviceId, packageName, userId);
        const entry = this.index[key];
        if (!entry || !this.isFresh(entry)) {
            return null;
        }

        return {
            ...entry,
            appName: this.resolveAppName(entry, packageName),
            iconUrl: this.iconExtractor.toIconUrl(entry.iconPath)
        };
    }

    setCachedEntry(deviceId, packageName, userId, data) {
        const key = this.buildKey(deviceId, packageName, userId);
        this.index[key] = {
            deviceId,
            packageName,
            userId: Number.isInteger(userId) ? userId : 0,
            appName: data.appName || humanizePackageName(packageName),
            iconPath: data.iconPath || null,
            versionCode: data.versionCode ?? null,
            fetchedAt: Date.now()
        };
        this.saveIndex();
        return this.index[key];
    }

    invalidate(deviceId, packageName, userId = null) {
        const key = this.buildKey(deviceId, packageName, userId);
        const entry = this.index[key];
        if (entry?.iconPath && fs.existsSync(entry.iconPath)) {
            try {
                fs.unlinkSync(entry.iconPath);
            } catch (_err) {
                // noop
            }
        }
        delete this.index[key];
        this.saveIndex();
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

    async resolveOne(serial, packageName, userId = null, { appNameHint = null } = {}) {
        const cached = this.getCachedEntry(serial, packageName, userId);
        if (cached) {
            return {
                appName: cached.appName,
                iconPath: cached.iconPath,
                iconUrl: cached.iconUrl
            };
        }

        let appName = isUsableAppLabel(appNameHint) ? appNameHint.trim() : null;
        if (!appName) {
            appName = await this.fetchLabelFromDump(serial, packageName, userId);
        }
        if (!appName) {
            appName = humanizePackageName(packageName);
        }

        const iconPath = this.iconExtractor.buildIconFilePath(this.cacheRoot, serial, packageName, userId);
        let savedIconPath = null;

        try {
            savedIconPath = await this.iconExtractor.extractIcon(serial, packageName, iconPath, userId);
        } catch (err) {
            console.warn(`[AppMetadataManager] icone ${packageName}:`, err.message);
            this.invalidate(serial, packageName, userId);
        }

        const versionCode = await this.fetchVersionCode(serial, packageName, userId);

        this.setCachedEntry(serial, packageName, userId, {
            appName,
            iconPath: savedIconPath,
            versionCode
        });

        return {
            appName,
            iconPath: savedIconPath,
            iconUrl: this.iconExtractor.toIconUrl(savedIconPath)
        };
    }

    mergeAppMetadata(serial, app) {
        const packageName = app.package || app.packageName;
        const userId = app.userId ?? null;
        const cached = this.getCachedEntry(serial, packageName, userId);
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

    enrichApps(serial, apps = []) {
        const activeKeys = new Set();
        const enriched = apps.map((app) => {
            const merged = this.mergeAppMetadata(serial, app);
            activeKeys.add(this.buildKey(serial, merged.package, merged.userId));
            return merged;
        });

        this.pruneForDevice(serial, activeKeys);
        return enriched;
    }

    queuePrefetch(serial, apps = [], options = {}) {
        const notify = typeof options.onUpdate === "function"
            ? options.onUpdate
            : this.notifyUpdate;
        const maxCount = Number.isInteger(options.maxCount) && options.maxCount > 0
            ? options.maxCount
            : DEFAULT_PREFETCH_MAX;

        const pending = apps.filter((app) => {
            const packageName = app.package || app.packageName;
            return packageName && !this.getCachedEntry(serial, packageName, app.userId ?? null);
        });

        if (!pending.length) return;

        const queueKey = serial;
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
                        const metadata = await this.resolveOne(serial, packageName, app.userId ?? null, {
                            appNameHint: app.labelName || app.displayName || app.appName
                        });
                        return {
                            deviceId: serial,
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
                    notify({ serial, updates });
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
            const cached = this.getCachedEntry(entry.deviceId, entry.packageName, entry.userId ?? null);

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

        const uncachedHistoryApps = enriched
            .filter((entry) => entry.deviceId && entry.packageName)
            .filter((entry) => !this.getCachedEntry(entry.deviceId, entry.packageName, entry.userId ?? null))
            .map((entry) => ({
                deviceId: entry.deviceId,
                package: entry.packageName,
                packageName: entry.packageName,
                userId: entry.userId ?? null,
                appName: entry.appName
            }));

        if (uncachedHistoryApps.length) {
            const byDevice = new Map();
            for (const app of uncachedHistoryApps) {
                if (!byDevice.has(app.deviceId)) byDevice.set(app.deviceId, []);
                byDevice.get(app.deviceId).push(app);
            }
            for (const [deviceId, apps] of byDevice.entries()) {
                this.queuePrefetch(deviceId, apps, { maxCount: DEFAULT_PREFETCH_MAX });
            }
        }

        return enriched;
    }
}

module.exports = { AppMetadataManager, CACHE_TTL_MS, DEFAULT_PREFETCH_MAX };
