const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { autoUpdater } = require("electron-updater");

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 5000;

let intervalHandle = null;
let configured = false;
let installMode = "dev";
let updateState = {
    status: "idle",
    version: null,
    releaseNotes: null,
    progress: null,
    error: null,
    feedUrl: null
};

function appendLog(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(`[AutoUpdater] ${message}`);
    try {
        const logPath = path.join(app.getPath("userData"), "update.log");
        fs.appendFileSync(logPath, `${line}\n`, "utf8");
    } catch (_err) {
        // noop
    }
}

function setState(patch = {}) {
    updateState = { ...updateState, ...patch };
}

function broadcast(channel, payload = {}) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(channel, payload);
    }
}

function getInstallMode() {
    if (!app.isPackaged) return "dev";
    if (process.env.PORTABLE_EXECUTABLE_DIR) return "portable";
    if (process.execPath.toLowerCase().includes(`${path.sep}win-unpacked${path.sep}`)) {
        return "unpacked";
    }
    return "installed";
}

function canInstallUpdates() {
    return installMode === "installed";
}

function loadEmbeddedFeed() {
    try {
        return require("../shared/update-feed.json");
    } catch (_err) {
        return { configured: false };
    }
}

function readAppUpdateYml() {
    const ymlPath = path.join(process.resourcesPath, "app-update.yml");
    if (!fs.existsSync(ymlPath)) {
        return null;
    }
    try {
        return fs.readFileSync(ymlPath, "utf8");
    } catch (err) {
        appendLog(`Impossible de lire app-update.yml: ${err.message}`);
        return null;
    }
}

function parseSimpleYaml(text = "") {
    const result = {};
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
        if (!match) continue;
        result[match[1]] = match[2].trim();
    }
    return result;
}

function resolveGithubToken(embedded = {}) {
    return (
        embedded.token
        || process.env.GH_UPDATE_TOKEN
        || process.env.GH_TOKEN
        || null
    );
}

function applyGithubFeed({ owner, repo, token, isPrivate = true }) {
    const feed = {
        provider: "github",
        owner,
        repo,
        private: isPrivate
    };
    if (token) {
        feed.token = token;
    }
    autoUpdater.setFeedURL(feed);
    configured = true;
    updateState.feedUrl = `https://github.com/${owner}/${repo}/releases/latest`;
    appendLog(`Feed GitHub: ${updateState.feedUrl}${token ? " (auth)" : " (sans token)"}`);
}

function configureUpdaterFeed() {
    installMode = getInstallMode();
    configured = false;

    if (installMode === "dev") {
        const devConfigPath = path.join(app.getAppPath(), "dev-app-update.yml");
        if (fs.existsSync(devConfigPath)) {
            autoUpdater.forceDevUpdateConfig = true;
            appendLog("Mode dev — utilisation de dev-app-update.yml");
            configured = true;
            return { ok: true, mode: "dev" };
        }
        return {
            ok: false,
            mode: "dev",
            error: "Mode développement. Créez dev-app-update.yml pour tester, ou utilisez l'installateur NSIS."
        };
    }

    const ymlText = readAppUpdateYml();
    const ymlConfig = ymlText ? parseSimpleYaml(ymlText) : null;
    const embedded = loadEmbeddedFeed();
    const token = resolveGithubToken(embedded);

    if (ymlConfig?.provider === "github") {
        if (/NON_CONFIGURE/i.test(ymlConfig.owner) || /NON_CONFIGURE/i.test(ymlConfig.repo)) {
            return {
                ok: false,
                mode: installMode,
                error: "Dépôt GitHub non configuré au build. Relancez le build avec GH_OWNER et GH_REPO."
            };
        }
        applyGithubFeed({
            owner: ymlConfig.owner,
            repo: ymlConfig.repo,
            token,
            isPrivate: true
        });
        return { ok: true, mode: installMode };
    }

    if (ymlConfig?.provider === "generic" && ymlConfig.url) {
        autoUpdater.setFeedURL({ provider: "generic", url: ymlConfig.url });
        configured = true;
        updateState.feedUrl = ymlConfig.url;
        appendLog(`Feed generic: ${ymlConfig.url}`);
        return { ok: true, mode: installMode };
    }

    if (embedded?.configured && embedded.provider === "github") {
        applyGithubFeed({
            owner: embedded.owner,
            repo: embedded.repo,
            token,
            isPrivate: embedded.private !== false
        });
        return { ok: true, mode: installMode };
    }

    if (embedded?.configured && embedded.provider === "generic" && embedded.url) {
        autoUpdater.setFeedURL({ provider: "generic", url: embedded.url });
        configured = true;
        updateState.feedUrl = embedded.url;
        appendLog(`Feed embarqué generic: ${embedded.url}`);
        return { ok: true, mode: installMode };
    }

    const overrideUrl = process.env.ANDROID_HUB_UPDATE_URL || process.env.UPDATE_FEED_URL;
    if (overrideUrl) {
        autoUpdater.setFeedURL({ provider: "generic", url: overrideUrl });
        configured = true;
        updateState.feedUrl = overrideUrl;
        appendLog(`Feed override: ${overrideUrl}`);
        return { ok: true, mode: installMode };
    }

    return {
        ok: false,
        mode: installMode,
        error: "Configuration de mise à jour absente. Rebuild avec GH_UPDATE_TOKEN ou ajoutez dev-app-update.yml."
    };
}

function getPublicState() {
    return {
        status: updateState.status,
        version: updateState.version,
        releaseNotes: updateState.releaseNotes,
        progress: updateState.progress,
        error: updateState.error,
        currentVersion: app.getVersion(),
        enabled: configured && installMode !== "dev",
        installMode,
        canInstall: canInstallUpdates(),
        feedUrl: updateState.feedUrl
    };
}

function attachAutoUpdaterEvents() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on("checking-for-update", () => {
        setState({ status: "checking", error: null, progress: null });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("update-available", (info) => {
        appendLog(`Mise à jour disponible: v${info.version}`);
        setState({
            status: "available",
            version: info.version,
            releaseNotes: normalizeReleaseNotes(info.releaseNotes),
            error: null,
            progress: null
        });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("update-not-available", (info) => {
        appendLog(`Aucune mise à jour (actuelle: v${info?.version || app.getVersion()})`);
        setState({
            status: "idle",
            version: null,
            releaseNotes: null,
            error: null,
            progress: null,
            lastCheckedAt: Date.now()
        });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("error", (err) => {
        const message = err?.message || String(err);
        appendLog(`Erreur: ${message}`);
        setState({ status: "error", error: message });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("download-progress", (progress) => {
        setState({
            status: "downloading",
            progress: {
                percent: progress.percent,
                transferred: progress.transferred,
                total: progress.total,
                bytesPerSecond: progress.bytesPerSecond
            }
        });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("update-downloaded", (info) => {
        appendLog(`Mise à jour téléchargée: v${info.version}`);
        setState({
            status: "downloaded",
            version: info.version,
            releaseNotes: normalizeReleaseNotes(info.releaseNotes),
            progress: { percent: 100 },
            error: null
        });
        broadcast("update:status", getPublicState());
    });
}

function normalizeReleaseNotes(notes) {
    if (!notes) return null;
    if (typeof notes === "string") return notes;
    if (Array.isArray(notes)) {
        return notes.map((entry) => (typeof entry === "string" ? entry : entry.note || ""))
            .filter(Boolean)
            .join("\n");
    }
    return String(notes);
}

async function checkForUpdates({ manual = false } = {}) {
    if (!configured) {
        const state = {
            ...getPublicState(),
            status: installMode === "dev" && manual ? "dev-mode" : (manual ? "error" : "idle"),
            enabled: false,
            error: manual
                ? (installMode === "dev" ? null : (updateState.error || "Mises à jour non configurées."))
                : updateState.error
        };
        if (manual) {
            broadcast("update:status", state);
        }
        return state;
    }

    try {
        if (manual) {
            setState({ status: "checking", error: null, progress: null });
            broadcast("update:status", getPublicState());
        }
        await autoUpdater.checkForUpdates();
        return getPublicState();
    } catch (err) {
        const message = err?.message || String(err);
        appendLog(`Erreur check: ${message}`);
        setState({ status: "error", error: message });
        broadcast("update:status", getPublicState());
        return getPublicState();
    }
}

async function downloadUpdate() {
    if (!configured) {
        throw new Error("Mises à jour non configurées.");
    }
    if (updateState.status !== "available" && updateState.status !== "error") {
        throw new Error("Aucune mise à jour disponible à télécharger.");
    }

    setState({ status: "downloading", error: null, progress: { percent: 0 } });
    broadcast("update:status", getPublicState());
    await autoUpdater.downloadUpdate();
    return getPublicState();
}

function quitAndInstall() {
    if (!canInstallUpdates()) {
        throw new Error("Installation impossible — utilisez l'installateur NSIS (Setup.exe).");
    }
    autoUpdater.quitAndInstall(false, true);
}

function schedulePeriodicChecks() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
    intervalHandle = setInterval(() => {
        void checkForUpdates({ manual: false }).catch((err) => {
            appendLog(`Check périodique échoué: ${err.message}`);
        });
    }, CHECK_INTERVAL_MS);
}

function initAutoUpdater(_mainWindow) {
    const result = configureUpdaterFeed();
    if (!result.ok) {
        appendLog(result.error || "Mises à jour non configurées.");
        if (result.error) {
            setState({ error: result.error });
        }
        return;
    }

    attachAutoUpdaterEvents();

    if (installMode !== "installed") {
        appendLog(`Mises à jour automatiques désactivées (mode: ${installMode}).`);
        return;
    }

    appendLog("Mises à jour GitHub Releases activées.");
    setTimeout(() => {
        void checkForUpdates({ manual: false }).catch((err) => {
            appendLog(`Check initial échoué: ${err.message}`);
        });
    }, STARTUP_CHECK_DELAY_MS);

    schedulePeriodicChecks();
}

module.exports = {
    initAutoUpdater,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    getPublicState
};
