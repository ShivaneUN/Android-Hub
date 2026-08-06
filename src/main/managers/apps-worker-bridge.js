const path = require("path");
const { fork } = require("child_process");
const { LaunchHistoryManager } = require("./launch-history-manager");

const WORKER_PATH = path.join(__dirname, "../workers/apps-worker.js");
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const APP_LIST_REQUEST_TIMEOUT_MS = 90000;
const PREFETCH_REQUEST_TIMEOUT_MS = 60000;
const MAX_RESTART_ATTEMPTS = 3;

class AppsWorkerBridge {
    constructor() {
        /** @type {import("child_process").ChildProcess|null} */
        this.child = null;
        this.pending = new Map();
        this.nextRequestId = 1;
        this.started = false;
        this.useFallback = false;
        this.restartAttempts = 0;
        this.userDataPath = null;
        this.adbPath = null;
        /** @type {((ctx: { transportSerial: string, cacheDeviceId: string, adbSerial: string }) => Promise<unknown[]>)|null} */
        this.fallbackGetAppList = null;
        /** @type {((ctx: { transportSerial: string, cacheDeviceId: string }, apps: unknown[]) => Promise<unknown[]>)|null} */
        this.fallbackEnrichApps = null;
        /** @type {((ctx: { transportSerial: string, cacheDeviceId: string, adbSerial: string }, apps: unknown[], options?: { maxCount?: number }) => Promise<void>)|null} */
        this.fallbackPrefetchAppMetadata = null;
        /** @type {((payload: { serial?: string, updates?: unknown[] }) => void)|null} */
        this.metadataUpdatedRelay = null;
        /** @type {(() => void)|null} */
        this.historyMutatedRelay = null;
        /** @type {(() => Set<string>)|null} */
        this.getActiveTypeBKeys = null;
        /** @type {LaunchHistoryManager|null} */
        this.fallbackManager = null;
        /** @type {Promise<void>|null} */
        this.readyPromise = null;
    }

    getActiveKeysArray() {
        if (typeof this.getActiveTypeBKeys !== "function") return [];
        return Array.from(this.getActiveTypeBKeys());
    }

    createFallbackManager() {
        if (!this.userDataPath) return null;
        if (this.fallbackManager) {
            this.fallbackManager.destroy();
        }
        this.fallbackManager = new LaunchHistoryManager(this.userDataPath, {
            getActiveTypeBKeys: () => this.getActiveTypeBKeys?.() || new Set()
        });
        return this.fallbackManager;
    }

    activateFallback(reason) {
        console.warn("[AppsWorkerBridge] fallback in-process:", reason);
        this.useFallback = true;
        if (this.child && !this.child.killed) {
            try {
                this.child.kill("SIGTERM");
            } catch (_err) {
                // noop
            }
        }
        this.child = null;
        this.rejectAllPending(new Error(reason));
        this.createFallbackManager();
    }

    rejectAllPending(error) {
        for (const [id, entry] of this.pending.entries()) {
            clearTimeout(entry.timer);
            entry.reject(error);
            this.pending.delete(id);
        }
    }

    attachChildListeners() {
        if (!this.child) return;

        this.child.on("message", (message) => {
            if (message?.type === "METADATA_UPDATED" && message.payload) {
                if (typeof this.metadataUpdatedRelay === "function") {
                    this.metadataUpdatedRelay(message.payload);
                }
                return;
            }

            if (!message?.id) return;
            const entry = this.pending.get(message.id);
            if (!entry) return;

            clearTimeout(entry.timer);
            this.pending.delete(message.id);

            if (message.ok) {
                entry.resolve(message.result);
                return;
            }
            entry.reject(new Error(message.error || "AppsWorker error"));
        });

        this.child.on("error", (err) => {
            console.error("[AppsWorkerBridge] child error:", err.message);
            this.handleChildExit("error");
        });

        this.child.on("exit", (code, signal) => {
            if (this.useFallback) return;
            const reason = `worker exit code=${code ?? "?"} signal=${signal ?? "?"}`;
            this.handleChildExit(reason);
        });
    }

    handleChildExit(reason) {
        this.child = null;
        this.rejectAllPending(new Error(`AppsWorker indisponible: ${reason}`));

        if (!this.started || this.useFallback) return;

        this.restartAttempts += 1;
        if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
            this.activateFallback(`restart epuise (${reason})`);
            return;
        }

        console.warn(`[AppsWorkerBridge] restart ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}...`);
        void this.spawnWorker().catch((err) => {
            this.activateFallback(err.message);
        });
    }

    async spawnWorker() {
        this.child = fork(WORKER_PATH, [], {
            stdio: ["pipe", "pipe", "pipe", "ipc"],
            env: process.env,
            windowsHide: true
        });
        this.attachChildListeners();
        await this.request("INIT", {
            userDataPath: this.userDataPath,
            adbPath: this.adbPath
        }, 15000);
        this.restartAttempts = 0;
    }

    setAppListFallback({ getAppList, enrichApps, prefetchAppMetadata } = {}) {
        this.fallbackGetAppList = typeof getAppList === "function" ? getAppList : null;
        this.fallbackEnrichApps = typeof enrichApps === "function" ? enrichApps : null;
        this.fallbackPrefetchAppMetadata = typeof prefetchAppMetadata === "function"
            ? prefetchAppMetadata
            : null;
    }

    setMetadataUpdatedRelay(handler) {
        this.metadataUpdatedRelay = typeof handler === "function" ? handler : null;
    }

    setHistoryMutatedRelay(handler) {
        this.historyMutatedRelay = typeof handler === "function" ? handler : null;
    }

    _emitHistoryMutated(result) {
        if (result && result.success === false) return;
        if (typeof this.historyMutatedRelay === "function") {
            try {
                this.historyMutatedRelay();
            } catch (_err) {
                /* ignore */
            }
        }
    }

    async start({ userDataPath, adbPath, getActiveTypeBKeys }) {
        if (this.started) return;

        this.userDataPath = userDataPath;
        this.adbPath = adbPath;
        this.getActiveTypeBKeys = getActiveTypeBKeys;
        this.started = true;
        this.useFallback = false;
        this.restartAttempts = 0;

        try {
            await this.spawnWorker();
            console.log("[AppsWorkerBridge] worker pret (P0 historique + P1 apps + P2 prefetch)");
        } catch (err) {
            this.activateFallback(err.message);
        }
    }

    async shutdown() {
        this.started = false;

        if (this.useFallback) {
            this.fallbackManager?.destroy();
            this.fallbackManager = null;
            return;
        }

        if (this.child && !this.child.killed) {
            try {
                await this.request("SHUTDOWN", {}, 5000);
            } catch (_err) {
                try {
                    this.child.kill("SIGTERM");
                } catch (_killErr) {
                    // noop
                }
            }
        }

        this.child = null;
        this.rejectAllPending(new Error("AppsWorker shutdown"));
        this.fallbackManager?.destroy();
        this.fallbackManager = null;
    }

    request(type, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        if (this.useFallback) {
            return Promise.reject(new Error("AppsWorker fallback actif — utiliser les methodes facade."));
        }
        if (!this.child || this.child.killed) {
            return Promise.reject(new Error("AppsWorker non demarre."));
        }

        const id = String(this.nextRequestId++);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`AppsWorker timeout: ${type}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });

            try {
                this.child.send({ id, type, payload });
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    async ensureReady() {
        if (this.readyPromise) {
            await this.readyPromise;
        }
        if (this.useFallback && !this.fallbackManager) {
            this.createFallbackManager();
        }
    }

    async listHistory() {
        await this.ensureReady();
        if (this.useFallback) {
            return this.fallbackManager?.list() || [];
        }
        const result = await this.request("GET_HISTORY", {
            activeKeys: this.getActiveKeysArray()
        });
        return result?.entries || [];
    }

    async recordLaunch(payload) {
        await this.ensureReady();
        let result;
        if (this.useFallback) {
            result = this.fallbackManager?.recordLaunch(payload)
                || { success: false, error: "Historique indisponible." };
        } else {
            result = await this.request("ADD_HISTORY_ENTRY", payload);
        }
        this._emitHistoryMutated(result);
        return result;
    }

    async remove(payload) {
        await this.ensureReady();
        let result;
        if (this.useFallback) {
            result = this.fallbackManager?.remove(payload)
                || { success: false, error: "Historique indisponible." };
        } else {
            result = await this.request("REMOVE_HISTORY_ENTRY", payload);
        }
        this._emitHistoryMutated(result);
        return result;
    }

    async purgeOlderThan(cutoff, { dryRun = false } = {}) {
        await this.ensureReady();
        let result;
        if (this.useFallback) {
            result = this.fallbackManager?.purgeOlderThan(cutoff, { dryRun })
                || { entriesEligible: 0, entriesRemoved: 0 };
        } else {
            result = await this.request("PURGE_HISTORY_OLDER_THAN", {
                cutoff,
                dryRun,
                activeKeys: this.getActiveKeysArray()
            });
        }
        if (!dryRun && (result?.entriesRemoved > 0 || result?.success)) {
            this._emitHistoryMutated({ success: true });
        }
        return result;
    }

    async getAppList({ transportSerial, cacheDeviceId, adbSerial }) {
        await this.ensureReady();
        if (this.useFallback) {
            if (this.fallbackGetAppList) {
                return this.fallbackGetAppList({ transportSerial, cacheDeviceId, adbSerial });
            }
            throw new Error("Liste apps indisponible (fallback sans handler).");
        }
        const result = await this.request("GET_APP_LIST", {
            transportSerial,
            cacheDeviceId,
            adbSerial
        }, APP_LIST_REQUEST_TIMEOUT_MS);
        return result?.apps || [];
    }

    async enrichApps({ transportSerial, cacheDeviceId }, apps = []) {
        await this.ensureReady();
        if (this.useFallback) {
            if (this.fallbackEnrichApps) {
                return this.fallbackEnrichApps({ transportSerial, cacheDeviceId }, apps);
            }
            return apps;
        }
        const result = await this.request("ENRICH_APPS", {
            transportSerial,
            cacheDeviceId,
            apps
        }, DEFAULT_REQUEST_TIMEOUT_MS);
        return result?.apps || apps;
    }

    async prefetchAppMetadata({ transportSerial, cacheDeviceId, adbSerial }, apps = [], options = {}) {
        await this.ensureReady();
        if (this.useFallback) {
            if (this.fallbackPrefetchAppMetadata) {
                await this.fallbackPrefetchAppMetadata(
                    { transportSerial, cacheDeviceId, adbSerial },
                    apps,
                    options
                );
                return { ok: true };
            }
            throw new Error("Prefetch apps indisponible (fallback sans handler).");
        }
        const result = await this.request("PREFETCH_APP_METADATA", {
            transportSerial,
            cacheDeviceId,
            adbSerial,
            apps,
            maxCount: options.maxCount,
            priority: options.priority === "high" ? "high" : "normal"
        }, PREFETCH_REQUEST_TIMEOUT_MS);
        return result || { ok: true };
    }

    getFacade() {
        const bridge = this;
        return {
            list: () => bridge.listHistory(),
            recordLaunch: (payload) => bridge.recordLaunch(payload),
            remove: (payload) => bridge.remove(payload),
            purgeOlderThan: (cutoff, options) => bridge.purgeOlderThan(cutoff, options)
        };
    }

    bootstrapReady(readyPromise) {
        this.readyPromise = readyPromise;
    }
}

module.exports = { AppsWorkerBridge };
