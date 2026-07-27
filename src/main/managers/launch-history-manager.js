const fs = require("fs");
const path = require("path");

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

class LaunchHistoryManager {
    constructor(userDataPath, { getActiveTypeBKeys, enablePruneTimer = true } = {}) {
        this.filePath = path.join(userDataPath, "launch-history.json");
        this.entries = {};
        this.getActiveTypeBKeys = typeof getActiveTypeBKeys === "function" ? getActiveTypeBKeys : () => new Set();
        this.load();
        this.pruneStale();
        if (enablePruneTimer) {
            this._pruneTimer = setInterval(() => this.pruneStale(), PRUNE_INTERVAL_MS);
            if (typeof this._pruneTimer.unref === "function") {
                this._pruneTimer.unref();
            }
        }
    }

    normalizeUserId(userId) {
        return Number.isInteger(userId) ? userId : 0;
    }

    buildKey(deviceId, packageName, userId = null) {
        const uid = this.normalizeUserId(userId);
        return `${String(deviceId || "")}::${String(packageName || "")}::${uid}`;
    }

    isValidEntry(entry) {
        return Boolean(
            entry
            && typeof entry === "object"
            && entry.deviceId
            && entry.packageName
            && Number.isFinite(entry.lastLaunchedAt)
        );
    }

    migrateLegacyKeys(rawEntries) {
        const migrated = {};

        for (const [rawKey, entry] of Object.entries(rawEntries || {})) {
            if (!entry || typeof entry !== "object") continue;
            if (!entry.deviceId || !entry.packageName) continue;

            const canonicalKey = this.buildKey(entry.deviceId, entry.packageName, entry.userId);
            const existing = migrated[canonicalKey];

            if (!existing || (entry.lastLaunchedAt || 0) >= (existing.lastLaunchedAt || 0)) {
                migrated[canonicalKey] = {
                    ...entry,
                    userId: Number.isInteger(entry.userId) ? entry.userId : null,
                    launchCount: entry.launchCount || 1
                };
            }

            if (rawKey !== canonicalKey) {
                console.log("[LaunchHistoryManager] migration clé historique", rawKey, "->", canonicalKey);
            }
        }

        return migrated;
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                this.entries = {};
                return;
            }

            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            let shouldPersistMigration = false;

            if (Array.isArray(parsed)) {
                const fromArray = {};
                for (const entry of parsed) {
                    if (!this.isValidEntry(entry)) continue;
                    const key = this.buildKey(entry.deviceId, entry.packageName, entry.userId);
                    fromArray[key] = entry;
                }
                this.entries = fromArray;
                shouldPersistMigration = true;
            } else if (parsed && typeof parsed === "object") {
                const beforeKeys = Object.keys(parsed);
                this.entries = this.migrateLegacyKeys(parsed);
                const afterKeys = Object.keys(this.entries);
                shouldPersistMigration = beforeKeys.some((rawKey) => {
                    const entry = parsed[rawKey];
                    return entry && this.buildKey(entry.deviceId, entry.packageName, entry.userId) !== rawKey;
                }) || beforeKeys.length !== afterKeys.length;
            } else {
                this.entries = {};
            }

            if (shouldPersistMigration && Object.keys(this.entries).length > 0) {
                this.save();
            }
        } catch (err) {
            console.error("[LaunchHistoryManager] Erreur lecture:", err.message);
            this.entries = {};
        }
    }

    save() {
        try {
            const payload = JSON.stringify(this.entries, null, 2);
            fs.writeFileSync(this.filePath, payload, "utf-8");
        } catch (err) {
            console.error("[LaunchHistoryManager] Erreur écriture:", err.message);
        }
    }

    recordLaunch({ deviceId, packageName, appName, iconPath = null, userId = null }) {
        if (!deviceId || !packageName) {
            return { success: false, error: "deviceId et packageName requis." };
        }

        let { resolveHistoryAppName } = {};
        try {
            ({ resolveHistoryAppName } = require("../../shared/app-display"));
        } catch (_err) {
            resolveHistoryAppName = null;
        }
        const cleanAppName = resolveHistoryAppName
            ? resolveHistoryAppName({ appName, packageName })
            : (appName || packageName);

        const key = this.buildKey(deviceId, packageName, userId);
        const now = Date.now();
        const existing = this.entries[key];

        if (existing) {
            existing.lastLaunchedAt = now;
            existing.launchCount = (existing.launchCount || 1) + 1;
            if (cleanAppName) existing.appName = cleanAppName;
            if (iconPath) existing.iconPath = iconPath;
            existing.userId = Number.isInteger(userId) ? userId : null;
            existing.deviceId = deviceId;
        } else {
            this.entries[key] = {
                deviceId,
                packageName,
                appName: cleanAppName || packageName,
                iconPath: iconPath || null,
                lastLaunchedAt: now,
                launchCount: 1,
                userId: Number.isInteger(userId) ? userId : null
            };
        }

        this.save();
        return { success: true, entry: { ...this.entries[key], key } };
    }

    list() {
        this.pruneStale();
        return Object.entries(this.entries)
            .filter(([, entry]) => this.isValidEntry(entry))
            .map(([key, entry]) => ({ ...entry, key }))
            .sort((a, b) => (b.lastLaunchedAt || 0) - (a.lastLaunchedAt || 0));
    }

    /**
     * Migre les entrées dont deviceId est un serial ADB (USB / ip:port) vers deviceId stable.
     */
    async migrateDeviceIdsToStable(resolveStableIdFn) {
        if (typeof resolveStableIdFn !== "function") return false;

        const next = {};
        let changed = false;

        for (const [key, entry] of Object.entries(this.entries)) {
            if (!this.isValidEntry(entry)) continue;

            const stableId = await resolveStableIdFn(entry.deviceId);
            const canonicalDeviceId = stableId || entry.deviceId;
            const newKey = this.buildKey(canonicalDeviceId, entry.packageName, entry.userId);
            const migrated = {
                ...entry,
                deviceId: canonicalDeviceId
            };

            const existing = next[newKey];
            if (!existing || (migrated.lastLaunchedAt || 0) >= (existing.lastLaunchedAt || 0)) {
                next[newKey] = migrated;
            }

            if (canonicalDeviceId !== entry.deviceId || newKey !== key) {
                changed = true;
                console.log(
                    "[LaunchHistoryManager] migration deviceId",
                    entry.deviceId,
                    "->",
                    canonicalDeviceId,
                    `(${key} -> ${newKey})`
                );
            }
        }

        if (changed) {
            this.entries = next;
            this.save();
        }

        return changed;
    }

    remove({ deviceId, packageName, userId = null, key = null } = {}) {
        const targetKey = key || (deviceId && packageName ? this.buildKey(deviceId, packageName, userId) : null);
        const storeKeys = Object.keys(this.entries);

        console.log("[LaunchHistoryManager] remove", {
            requestedKey: targetKey,
            deviceId,
            packageName,
            userId,
            storeKeys
        });

        if (!targetKey || !this.entries[targetKey]) {
            return {
                success: false,
                error: "Entrée introuvable.",
                requestedKey: targetKey,
                storeKeys
            };
        }

        delete this.entries[targetKey];
        this.save();

        console.log("[LaunchHistoryManager] remove OK", {
            removedKey: targetKey,
            remaining: Object.keys(this.entries).length
        });

        return { success: true, removedKey: targetKey };
    }

    pruneStale() {
        const now = Date.now();
        const activeKeys = this.getActiveTypeBKeys();
        let changed = false;

        for (const [key, entry] of Object.entries(this.entries)) {
            if (!this.isValidEntry(entry)) {
                delete this.entries[key];
                changed = true;
                continue;
            }

            if (activeKeys.has(key)) continue;

            const lastLaunchedAt = entry.lastLaunchedAt;
            if (now - lastLaunchedAt > TWO_DAYS_MS) {
                delete this.entries[key];
                changed = true;
            }
        }

        if (changed) {
            this.save();
        }
    }

    collectOlderThan(cutoffMs) {
        const activeKeys = this.getActiveTypeBKeys();
        const keys = [];

        for (const [key, entry] of Object.entries(this.entries)) {
            if (!this.isValidEntry(entry)) continue;
            if (activeKeys.has(key)) continue;
            if ((entry.lastLaunchedAt || 0) <= cutoffMs) {
                keys.push(key);
            }
        }

        return keys;
    }

    purgeOlderThan(cutoffMs, { dryRun = false } = {}) {
        const keys = this.collectOlderThan(cutoffMs);
        const entriesEligible = keys.length;

        if (dryRun || entriesEligible === 0) {
            return { entriesEligible, entriesRemoved: 0 };
        }

        for (const key of keys) {
            delete this.entries[key];
        }
        this.save();

        return {
            entriesEligible,
            entriesRemoved: keys.length
        };
    }

    destroy() {
        if (this._pruneTimer) {
            clearInterval(this._pruneTimer);
            this._pruneTimer = null;
        }
    }
}

module.exports = { LaunchHistoryManager, TWO_DAYS_MS, PRUNE_INTERVAL_MS };
