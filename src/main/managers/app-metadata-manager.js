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
const { MIN_ICON_FILE_BYTES } = require("../../shared/app-icon-placeholder");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DUMP_TIMEOUT_MS = 12000;
/** Fond : concurrence modérée (évite de saturer ADB). */
const PREFETCH_CONCURRENCY = 8;
/** Visibles / priorité UI. */
const PREFETCH_PRIORITY_CONCURRENCY = 12;
const DEFAULT_PREFETCH_MAX = 48;
const MAX_ICON_EXTRACT_ATTEMPTS = 3;
const INDEX_SAVE_DEBOUNCE_MS = 500;
/** Bump to force re-extract when icon pipeline heuristics change. */
const ICON_PIPELINE_VERSION = 4;

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
        /** @type {Map<string, { concurrency: number }>} */
        this.prefetchQueueMeta = new Map();
        this._verifiedIconPaths = new Set();
        this._indexDirty = false;
        this._indexSaveTimer = null;
        this._stalePrunePromise = null;
        /** @type {Map<string, Promise<{ iconPath: string|null, appName?: string|null }>>} */
        this._inflightPackageExtract = new Map();
        this.loadIndex();
        fs.mkdirSync(this.cacheRoot, { recursive: true });
        void this.pruneStaleIconCacheEntries();
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

    async isIconFileAccessible(iconPath) {
        if (!iconPath || typeof iconPath !== "string") return false;
        try {
            await fs.promises.access(iconPath, fs.constants.R_OK);
            const stat = await fs.promises.stat(iconPath);
            return stat.size >= MIN_ICON_FILE_BYTES;
        } catch (_err) {
            return false;
        }
    }

    async removeIconFileIfExists(iconPath) {
        if (!iconPath) return;
        this._verifiedIconPaths.delete(iconPath);
        try {
            await fs.promises.access(iconPath);
            await fs.promises.unlink(iconPath);
        } catch (_err) {
            // noop — missing or already removed
        }
    }

    async pruneStaleIconCacheEntries() {
        if (this._stalePrunePromise) {
            return this._stalePrunePromise;
        }

        this._stalePrunePromise = (async () => {
            let invalidated = 0;
            /** @type {Map<string, number>} */
            const byDeviceId = new Map();

            for (const entry of Object.values(this.index)) {
                if (!entry?.iconPath) continue;

                if (await this.isIconFileAccessible(entry.iconPath)) continue;

                this._verifiedIconPaths.delete(entry.iconPath);
                entry.iconPath = null;
                entry.iconAttempts = 0;
                invalidated += 1;

                const deviceId = String(entry.deviceId || "unknown");
                byDeviceId.set(deviceId, (byDeviceId.get(deviceId) || 0) + 1);
            }

            if (invalidated > 0) {
                this.scheduleSaveIndex();
                console.log(
                    `[AppMetadataManager] prune stale icon cache: ${invalidated} entree(s) invalidee(s)`,
                    Object.fromEntries(byDeviceId)
                );
            } else {
                console.log("[AppMetadataManager] prune stale icon cache: 0 entree stale");
            }
        })().catch((err) => {
            console.warn("[AppMetadataManager] prune stale icon cache:", err.message);
        });

        return this._stalePrunePromise;
    }

    saveIndex() {
        try {
            fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), "utf-8");
        } catch (err) {
            console.warn("[AppMetadataManager] ecriture cache:", err.message);
        }
    }

    scheduleSaveIndex() {
        this._indexDirty = true;
        if (this._indexSaveTimer) return;
        this._indexSaveTimer = setTimeout(() => {
            this._indexSaveTimer = null;
            if (!this._indexDirty) return;
            this._indexDirty = false;
            this.saveIndex();
        }, INDEX_SAVE_DEBOUNCE_MS);
    }

    flushIndex() {
        if (this._indexSaveTimer) {
            clearTimeout(this._indexSaveTimer);
            this._indexSaveTimer = null;
        }
        if (!this._indexDirty) return;
        this._indexDirty = false;
        this.saveIndex();
    }

    async isFresh(entry) {
        if (!entry?.fetchedAt) return false;
        if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return false;
        if (!entry.iconPath) return true;
        if (!(await this.isIconFileAccessible(entry.iconPath))) {
            this._verifiedIconPaths.delete(entry.iconPath);
            return false;
        }
        this._verifiedIconPaths.add(entry.iconPath);
        return true;
    }

    async hasUsableIcon(entry) {
        if (Number(entry?.iconPipelineVersion) !== ICON_PIPELINE_VERSION) return false;
        return this.isIconFileAccessible(entry?.iconPath);
    }

    async shouldRetryIconExtract(entry) {
        if (!entry) return true;
        if (await this.hasUsableIcon(entry)) return false;
        const attempts = Number(entry.iconAttempts) || 0;
        return attempts < MAX_ICON_EXTRACT_ATTEMPTS;
    }

    resolveAppName(entry, fallbackPackage = "") {
        if (entry?.appName && isUsableAppLabel(entry.appName)) {
            return entry.appName.trim();
        }
        return humanizePackageName(fallbackPackage);
    }

    async formatCachedEntry(entry, packageName) {
        const iconPath = (await this.hasUsableIcon(entry)) ? entry.iconPath : null;
        return {
            ...entry,
            iconPath,
            appName: this.resolveAppName(entry, packageName),
            iconUrl: await this.iconExtractor.toIconUrl(iconPath)
        };
    }

    async rejectFalsePositiveCacheEntry(found, cacheDeviceId, packageName, userId = null) {
        if (!found?.entry) return;
        const entry = found.entry;
        const previousAttempts = Number(entry.iconAttempts) || 0;

        if (entry.iconPath) {
            await this.removeIconFileIfExists(entry.iconPath);
        }

        await this.setCachedEntry(cacheDeviceId, packageName, userId, {
            appName: entry.appName,
            iconPath: null,
            iconAttempts: Math.min(previousAttempts + 1, MAX_ICON_EXTRACT_ATTEMPTS),
            versionCode: entry.versionCode ?? null
        });
    }

    async mergeAppMetadata(cacheDeviceId, app, transportSerial = null) {
        const packageName = app.package || app.packageName;
        const userId = app.userId ?? null;
        const found = await this.lookupCacheEntry(cacheDeviceId, packageName, userId, transportSerial);
        if (found) {
            this.migrateCacheEntry(found, cacheDeviceId, packageName, userId);
        }

        const cached = await this.getCachedEntry(cacheDeviceId, packageName, userId, { transportSerial });
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

    async lookupCacheEntry(cacheDeviceId, packageName, userId = null, transportSerial = null) {
        for (const key of this.buildLookupKeys(cacheDeviceId, packageName, userId, transportSerial)) {
            const entry = this.index[key];
            if (!entry || !(await this.isFresh(entry))) continue;
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
        this.scheduleSaveIndex();
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

    async getCachedEntry(deviceId, packageName, userId = null, { transportSerial = null } = {}) {
        const found = await this.lookupCacheEntry(deviceId, packageName, userId, transportSerial || deviceId);
        if (!found) return null;
        return this.formatCachedEntry(found.entry, packageName);
    }

    async setCachedEntry(deviceId, packageName, userId, data) {
        const key = this.buildKey(deviceId, packageName, userId);
        const previous = this.index[key] || {};
        const iconAttempts = data.iconAttempts !== undefined
            ? data.iconAttempts
            : (previous.iconAttempts || 0);
        const hasUsableSavedIcon = data.iconPath
            ? await this.isIconFileAccessible(data.iconPath)
            : false;

        this.index[key] = {
            deviceId,
            packageName,
            userId: Number.isInteger(userId) ? userId : 0,
            appName: data.appName || previous.appName || humanizePackageName(packageName),
            iconPath: data.iconPath !== undefined ? data.iconPath : (previous.iconPath || null),
            iconAttempts: hasUsableSavedIcon ? 0 : iconAttempts,
            versionCode: data.versionCode !== undefined ? data.versionCode : (previous.versionCode ?? null),
            iconPipelineVersion: hasUsableSavedIcon ? ICON_PIPELINE_VERSION : (data.iconPipelineVersion ?? previous.iconPipelineVersion ?? 0),
            fetchedAt: Date.now()
        };
        this.scheduleSaveIndex();
        return this.index[key];
    }

    async invalidate(deviceId, packageName, userId = null, { transportSerial = null } = {}) {
        const keys = this.buildLookupKeys(deviceId, packageName, userId, transportSerial || deviceId);
        let changed = false;

        for (const key of keys) {
            const entry = this.index[key];
            if (!entry) continue;
            if (entry.iconPath) {
                await this.removeIconFileIfExists(entry.iconPath);
            }
            delete this.index[key];
            changed = true;
        }

        if (changed) {
            this.scheduleSaveIndex();
        }
    }

    async pruneForDevice(deviceId, activePackageKeys) {
        let changed = false;
        for (const [key, entry] of Object.entries(this.index)) {
            if (entry.deviceId !== deviceId) continue;
            const activeKey = this.buildKey(entry.deviceId, entry.packageName, entry.userId);
            if (activePackageKeys.has(activeKey)) continue;

            if (entry.iconPath) {
                await this.removeIconFileIfExists(entry.iconPath);
            }
            delete this.index[key];
            changed = true;
        }

        if (changed) {
            this.scheduleSaveIndex();
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

    async needsIconExtraction(cacheDeviceId, packageName, userId = null, transportSerial = null) {
        const found = await this.lookupCacheEntry(cacheDeviceId, packageName, userId, transportSerial);
        if (!found) return true;
        if (await this.hasUsableIcon(found.entry)) return false;
        return this.shouldRetryIconExtract(found.entry);
    }

    async resolvePrefetchContext(deviceId, options = {}) {
        if (options.cacheDeviceId) {
            const transportSerial = String(options.transportSerial ?? deviceId ?? "");
            return {
                cacheDeviceId: String(options.cacheDeviceId),
                adbSerial: String(options.adbSerial ?? transportSerial),
                transportSerial
            };
        }
        return this.resolveDeviceContext(deviceId);
    }

    async reopenBlockedPrefetchTargets(ctx, apps = []) {
        let changed = false;

        for (const app of apps) {
            const packageName = app.package || app.packageName;
            if (!packageName) continue;

            const found = await this.lookupCacheEntry(
                ctx.cacheDeviceId,
                packageName,
                app.userId ?? null,
                ctx.transportSerial
            );
            if (!found?.entry || await this.hasUsableIcon(found.entry)) continue;

            // Nouvelle passe d'extraction (heuristiques / aapt2) : reset échecs et vieux pipeline.
            const attempts = Number(found.entry.iconAttempts) || 0;
            const stalePipeline = Number(found.entry.iconPipelineVersion) !== ICON_PIPELINE_VERSION;
            if (!found.entry.iconPath || attempts > 0 || stalePipeline) {
                if (stalePipeline && found.entry.iconPath) {
                    await this.removeIconFileIfExists(found.entry.iconPath);
                    found.entry.iconPath = null;
                }
                found.entry.iconAttempts = 0;
                found.entry.iconPipelineVersion = 0;
                changed = true;
            }
        }

        if (changed) {
            this.scheduleSaveIndex();
        }
    }

    /**
     * Réutilise l'icône déjà extraite pour le même package (autres profils / clones).
     * Évite N pulls ADB pour Dofus×3, Contacts clonée, etc.
     */
    async findReusablePackageIcon(cacheDeviceId, packageName, excludeUserId = null, transportSerial = null) {
        const packageNameStr = String(packageName || "");
        if (!packageNameStr) return null;

        const deviceIds = new Set(
            [cacheDeviceId, transportSerial].filter(Boolean).map((id) => String(id))
        );

        for (const entry of Object.values(this.index)) {
            if (!entry || entry.packageName !== packageNameStr) continue;
            if (!deviceIds.has(String(entry.deviceId || ""))) continue;
            if (
                Number.isInteger(excludeUserId)
                && Number(entry.userId) === excludeUserId
            ) {
                continue;
            }
            if (!(await this.hasUsableIcon(entry))) continue;
            return entry;
        }
        return null;
    }

    async copyIconToPath(sourceIconPath, targetIconPath) {
        if (!sourceIconPath || !targetIconPath) return null;
        if (sourceIconPath === targetIconPath) {
            return (await this.isIconFileAccessible(targetIconPath)) ? targetIconPath : null;
        }
        try {
            await fs.promises.mkdir(path.dirname(targetIconPath), { recursive: true });
            await fs.promises.copyFile(sourceIconPath, targetIconPath);
            return (await this.isIconFileAccessible(targetIconPath)) ? targetIconPath : null;
        } catch (_err) {
            return null;
        }
    }

    async resolveOne(deviceId, packageName, userId = null, {
        appNameHint = null,
        prefetch = false,
        cacheDeviceId = null,
        transportSerial = null,
        adbSerial = null
    } = {}) {
        const ctx = await this.resolvePrefetchContext(deviceId, {
            cacheDeviceId,
            transportSerial,
            adbSerial
        });
        const found = await this.lookupCacheEntry(
            ctx.cacheDeviceId,
            packageName,
            userId,
            ctx.transportSerial
        );

        if (found) {
            this.migrateCacheEntry(found, ctx.cacheDeviceId, packageName, userId);
            const cached = await this.formatCachedEntry(
                this.index[this.buildKey(ctx.cacheDeviceId, packageName, userId)] || found.entry,
                packageName
            );

            if (await this.hasUsableIcon(cached)) {
                return {
                    appName: cached.appName,
                    iconPath: cached.iconPath,
                    iconUrl: cached.iconUrl
                };
            }

            if (!(await this.shouldRetryIconExtract(cached))) {
                return {
                    appName: cached.appName,
                    iconPath: null,
                    iconUrl: null
                };
            }

            await this.rejectFalsePositiveCacheEntry(found, ctx.cacheDeviceId, packageName, userId);
        }

        const refreshedFound = await this.lookupCacheEntry(
            ctx.cacheDeviceId,
            packageName,
            userId,
            ctx.transportSerial
        );
        let appName = isUsableAppLabel(appNameHint) ? appNameHint.trim() : null;
        if (!appName && !prefetch) {
            appName = await this.fetchLabelFromDump(ctx.adbSerial, packageName, userId);
        }
        if (!appName) {
            appName = refreshedFound?.entry?.appName
                || found?.entry?.appName
                || (isUsableAppLabel(appNameHint) ? appNameHint.trim() : null)
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

        // 1) Copie depuis un autre profil / clone déjà extrait.
        const reusable = await this.findReusablePackageIcon(
            ctx.cacheDeviceId,
            packageName,
            Number.isInteger(userId) ? userId : null,
            ctx.transportSerial
        );
        if (reusable?.iconPath) {
            savedIconPath = await this.copyIconToPath(reusable.iconPath, iconPath);
            if (!appName && reusable.appName) appName = reusable.appName;
        }

        // 2) Sinon extract ADB — dédupe concurrente par package (plusieurs profils en parallèle).
        if (!savedIconPath) {
            const inflightKey = `${ctx.cacheDeviceId}::${packageName}`;
            let inflight = this._inflightPackageExtract.get(inflightKey);
            if (!inflight) {
                inflight = (async () => {
                    try {
                        const extracted = await this.iconExtractor.extractIcon(
                            ctx.adbSerial,
                            packageName,
                            iconPath,
                            userId
                        );
                        return { iconPath: extracted, appName };
                    } catch (err) {
                        console.warn(`[AppMetadataManager] icone ${packageName}:`, err.message);
                        await this.invalidate(ctx.cacheDeviceId, packageName, userId, {
                            transportSerial: ctx.transportSerial
                        });
                        return { iconPath: null, appName };
                    } finally {
                        this._inflightPackageExtract.delete(inflightKey);
                    }
                })();
                this._inflightPackageExtract.set(inflightKey, inflight);
            }

            const shared = await inflight;
            if (shared?.iconPath) {
                if (shared.iconPath === iconPath) {
                    savedIconPath = shared.iconPath;
                } else {
                    savedIconPath = await this.copyIconToPath(shared.iconPath, iconPath);
                }
            }
            if (!appName && shared?.appName) appName = shared.appName;
        }

        const versionCode = prefetch
            ? (
                this.index[this.buildKey(ctx.cacheDeviceId, packageName, userId)]?.versionCode
                ?? refreshedFound?.entry?.versionCode
                ?? found?.entry?.versionCode
                ?? reusable?.versionCode
                ?? null
            )
            : await this.fetchVersionCode(ctx.adbSerial, packageName, userId);
        const nextAttempts = savedIconPath ? 0 : previousAttempts + 1;

        await this.setCachedEntry(ctx.cacheDeviceId, packageName, userId, {
            appName,
            iconPath: savedIconPath,
            iconAttempts: nextAttempts,
            versionCode
        });

        return {
            appName,
            iconPath: savedIconPath,
            iconUrl: await this.iconExtractor.toIconUrl(savedIconPath)
        };
    }

    async enrichApps(serial, apps = [], options = {}) {
        await this.pruneStaleIconCacheEntries();

        const transportSerial = String(options.transportSerial ?? serial ?? "");
        const cacheDeviceId = options.cacheDeviceId
            ? String(options.cacheDeviceId)
            : null;

        if (cacheDeviceId) {
            return Promise.all(apps.map((app) => this.mergeAppMetadata(cacheDeviceId, app, transportSerial)));
        }

        const ctx = await this.resolveDeviceContext(serial);
        return Promise.all(apps.map((app) => this.mergeAppMetadata(ctx.cacheDeviceId, app, ctx.transportSerial)));
    }

    async queuePrefetch(deviceId, apps = [], options = {}) {
        await this.pruneStaleIconCacheEntries();

        const notify = typeof options.onUpdate === "function"
            ? options.onUpdate
            : this.notifyUpdate;
        const maxCount = Number.isInteger(options.maxCount) && options.maxCount > 0
            ? options.maxCount
            : DEFAULT_PREFETCH_MAX;
        const priority = options.priority === "high" ? "high" : "normal";
        const concurrency = priority === "high"
            ? PREFETCH_PRIORITY_CONCURRENCY
            : PREFETCH_CONCURRENCY;

        const ctx = await this.resolvePrefetchContext(deviceId, {
            cacheDeviceId: options.cacheDeviceId,
            transportSerial: options.transportSerial,
            adbSerial: options.adbSerial
        });

        await this.reopenBlockedPrefetchTargets(ctx, apps);

        const pending = [];
        for (const app of apps) {
            const packageName = app.package || app.packageName;
            if (!packageName) continue;
            if (await this.needsIconExtraction(
                ctx.cacheDeviceId,
                packageName,
                app.userId ?? null,
                ctx.transportSerial
            )) {
                pending.push(app);
            }
        }

        if (!pending.length) return;

        const queueKey = ctx.cacheDeviceId;
        // maxCount s'applique à CE batch (pas au total file), pour pouvoir enfiler tout le catalogue.
        const toAdd = pending.slice(0, maxCount);
        if (!toAdd.length) return;

        const appKeyOf = (app) => {
            const pkg = app.package || app.packageName || "";
            const uid = Number.isInteger(app.userId) ? app.userId : 0;
            return `${pkg}::${uid}`;
        };

        if (this.prefetchQueues.has(queueKey)) {
            const queue = this.prefetchQueues.get(queueKey);
            const queuedKeys = new Set(queue.map(appKeyOf));
            const uniqueToAdd = toAdd.filter((app) => {
                const key = appKeyOf(app);
                if (queuedKeys.has(key)) return false;
                queuedKeys.add(key);
                return true;
            });
            if (!uniqueToAdd.length) return;

            if (priority === "high") {
                queue.unshift(...uniqueToAdd);
                const meta = this.prefetchQueueMeta.get(queueKey) || { concurrency };
                meta.concurrency = Math.max(meta.concurrency || concurrency, concurrency);
                this.prefetchQueueMeta.set(queueKey, meta);
            } else {
                queue.push(...uniqueToAdd);
            }
            return;
        }

        this.prefetchQueues.set(queueKey, [...toAdd]);
        this.prefetchQueueMeta.set(queueKey, { concurrency });

        const resolveCtx = {
            cacheDeviceId: ctx.cacheDeviceId,
            transportSerial: ctx.transportSerial,
            adbSerial: ctx.adbSerial
        };

        const runQueue = async () => {
            while (this.prefetchQueues.get(queueKey)?.length) {
                const meta = this.prefetchQueueMeta.get(queueKey) || { concurrency: PREFETCH_CONCURRENCY };
                const batchSize = meta.concurrency || PREFETCH_CONCURRENCY;
                const batch = this.prefetchQueues.get(queueKey).splice(0, batchSize);
                await Promise.all(batch.map(async (app) => {
                    const packageName = app.package || app.packageName;
                    try {
                        const metadata = await this.resolveOne(deviceId, packageName, app.userId ?? null, {
                            appNameHint: app.labelName || app.displayName || app.appName,
                            prefetch: true,
                            ...resolveCtx
                        });
                        const update = {
                            deviceId: ctx.cacheDeviceId,
                            package: packageName,
                            packageName,
                            userId: app.userId ?? null,
                            appName: metadata.appName,
                            iconPath: metadata.iconPath,
                            iconUrl: metadata.iconUrl
                        };
                        if ((update.iconUrl || update.iconPath) && typeof notify === "function") {
                            notify({ serial: ctx.transportSerial, updates: [update] });
                        }
                    } catch (err) {
                        console.warn(`[AppMetadataManager] prefetch ${packageName}:`, err.message);
                    }
                }));
                // Respirer l'event loop seulement tous les 2 batches (fallback main).
                if ((this.prefetchQueues.get(queueKey)?.length || 0) % 2 === 1) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }

            this.prefetchQueues.delete(queueKey);
            this.prefetchQueueMeta.delete(queueKey);
            this.flushIndex();
        };

        runQueue().catch((err) => {
            console.warn("[AppMetadataManager] prefetch queue:", err.message);
            this.prefetchQueues.delete(queueKey);
            this.prefetchQueueMeta.delete(queueKey);
        });
    }

    async prefetchHistoryApps(byDevice) {
        for (const [historyDeviceId, apps] of byDevice.entries()) {
            try {
                await this.queuePrefetch(historyDeviceId, apps, { maxCount: DEFAULT_PREFETCH_MAX });
            } catch (err) {
                console.warn(`[AppMetadataManager] history prefetch ${historyDeviceId}:`, err.message);
            }
        }
    }

    async enrichHistoryEntries(entries = []) {
        const contextCache = new Map();
        const getCtx = async (deviceId) => {
            if (!deviceId) return null;
            if (!contextCache.has(deviceId)) {
                contextCache.set(deviceId, await this.resolveDeviceContext(deviceId));
            }
            return contextCache.get(deviceId);
        };

        const enriched = [];
        const uncachedHistoryApps = [];

        for (const entry of entries) {
            const merged = { ...entry };
            const ctx = await getCtx(entry.deviceId);

            if (ctx) {
                const cached = await this.getCachedEntry(
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

                if (entry.packageName && await this.needsIconExtraction(
                    ctx.cacheDeviceId,
                    entry.packageName,
                    entry.userId ?? null,
                    ctx.transportSerial
                )) {
                    uncachedHistoryApps.push({
                        deviceId: entry.deviceId,
                        package: entry.packageName,
                        packageName: entry.packageName,
                        userId: entry.userId ?? null,
                        appName: merged.appName
                    });
                }
            } else {
                merged.appName = isUsableAppLabel(entry.appName)
                    ? entry.appName
                    : humanizePackageName(entry.packageName);
            }

            enriched.push(merged);
        }

        if (uncachedHistoryApps.length) {
            const byDevice = new Map();
            for (const app of uncachedHistoryApps) {
                if (!byDevice.has(app.deviceId)) byDevice.set(app.deviceId, []);
                byDevice.get(app.deviceId).push(app);
            }
            void this.prefetchHistoryApps(byDevice);
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
