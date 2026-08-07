const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { autoUpdater } = require("electron-updater");

// electron-updater n'active onProgress que si listenerCount > 0 au démarrage du download.
autoUpdater.on("download-progress", () => {});

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 5000;
const GITHUB_OWNER = "ShivaneUN";
const GITHUB_REPO = "Android-Hub";

let intervalHandle = null;
let configured = false;
let downloadPromise = null;
let progressPollHandle = null;
let expectedDownloadBytes = 0;
let lastPollBytes = 0;
let lastPollAt = 0;
let installMode = "dev";
let githubToken = null;
let pendingSameVersionPatch = null;
let patchInstallerPath = null;
let updateState = {
    status: "idle",
    version: null,
    releaseNotes: null,
    progress: null,
    error: null,
    feedUrl: null,
    isPatch: false,
    patchRevision: null
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

function getLocalPatchRevision() {
    try {
        // Packagé : package.json à la racine de app.asar (pas sous src/).
        const candidates = [
            path.join(app.getAppPath(), "package.json"),
            path.join(__dirname, "..", "..", "package.json"),
            path.join(__dirname, "..", "package.json")
        ];
        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue;
            const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
            if (pkg && typeof pkg === "object") {
                return Number(pkg.patchRevision) || 0;
            }
        }
    } catch (_err) {
        // noop
    }
    return 0;
}

function parseLatestYml(text = "") {
    const result = {
        version: null,
        path: null,
        sha512: null,
        size: 0,
        patchRevision: 0
    };
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const versionMatch = line.match(/^version:\s*(.+)$/);
        if (versionMatch) result.version = versionMatch[1].trim().replace(/^['"]|['"]$/g, "");
        const pathMatch = line.match(/^path:\s*(.+)$/);
        if (pathMatch) result.path = pathMatch[1].trim().replace(/^['"]|['"]$/g, "");
        const patchMatch = line.match(/^patchRevision:\s*(\d+)\s*$/);
        if (patchMatch) result.patchRevision = Number(patchMatch[1]) || 0;
        const shaMatch = line.match(/^\s*-\s*sha512:\s*(.+)$/) || line.match(/^\s*sha512:\s*(.+)$/);
        if (shaMatch && !result.sha512) {
            result.sha512 = shaMatch[1].trim().replace(/^['"]|['"]$/g, "");
        }
        const urlMatch = line.match(/^\s*-\s*url:\s*(.+)$/) || line.match(/^\s*url:\s*(.+)$/);
        if (urlMatch && !result.path) {
            result.path = urlMatch[1].trim().replace(/^['"]|['"]$/g, "");
        }
        const sizeMatch = line.match(/^\s*size:\s*(\d+)\s*$/);
        if (sizeMatch && !result.size) {
            result.size = Number(sizeMatch[1]) || 0;
        }
    }
    return result;
}

async function githubApiJson(apiPath) {
    if (!githubToken) return null;
    const response = await fetch(`https://api.github.com${apiPath}`, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: githubToken.startsWith("Bearer ")
                ? githubToken
                : `Bearer ${githubToken}`,
            "X-GitHub-Api-Version": "2022-11-28"
        }
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`GitHub API ${response.status}: ${apiPath}`);
    }
    return response.json();
}

async function downloadGithubAsset(assetId, destPath, onProgress) {
    const response = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/${assetId}`,
        {
            headers: {
                Accept: "application/octet-stream",
                Authorization: githubToken.startsWith("Bearer ")
                    ? githubToken
                    : `Bearer ${githubToken}`,
                "X-GitHub-Api-Version": "2022-11-28"
            },
            redirect: "follow"
        }
    );
    if (!response.ok) {
        throw new Error(`Téléchargement asset échoué (${response.status})`);
    }

    const total = Number(response.headers.get("content-length")) || 0;
    const reader = response.body?.getReader?.();
    if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(destPath, buffer);
        if (onProgress) onProgress(buffer.length, total || buffer.length);
        return buffer.length;
    }

    const chunks = [];
    let transferred = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        transferred += value.length;
        if (onProgress) onProgress(transferred, total);
    }
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(destPath, buffer);
    return buffer.length;
}

function sha512FileBase64(filePath) {
    const hash = crypto.createHash("sha512");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("base64");
}

/**
 * Même version semver, mais patchRevision distant plus élevé → proposer le patch.
 */
async function detectSameVersionPatch() {
    if (!githubToken || !canInstallUpdates()) return null;

    const localVersion = app.getVersion();
    const localPatch = getLocalPatchRevision();
    const release = await githubApiJson(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/v${localVersion}`
    );
    if (!release || !Array.isArray(release.assets)) return null;

    const ymlAsset = release.assets.find((a) => a.name === "latest.yml");
    const setupAsset = release.assets.find((a) => /\.exe$/i.test(a.name || ""));
    if (!ymlAsset || !setupAsset) return null;

    const ymlRes = await fetch(ymlAsset.url, {
        headers: {
            Accept: "application/octet-stream",
            Authorization: githubToken.startsWith("Bearer ")
                ? githubToken
                : `Bearer ${githubToken}`,
            "X-GitHub-Api-Version": "2022-11-28"
        },
        redirect: "follow"
    });
    if (!ymlRes.ok) return null;
    const ymlText = await ymlRes.text();
    const remote = parseLatestYml(ymlText);
    const remotePatch = Number(remote.patchRevision) || 0;

    if (remotePatch <= localPatch) {
        appendLog(`Patch: à jour (local #${localPatch}, remote #${remotePatch})`);
        return null;
    }

    appendLog(`Patch détecté: v${localVersion} #${localPatch} → #${remotePatch}`);
    return {
        version: localVersion,
        patchRevision: remotePatch,
        localPatchRevision: localPatch,
        setupAssetId: setupAsset.id,
        setupName: setupAsset.name,
        setupSize: Number(setupAsset.size) || Number(remote.size) || 0,
        sha512: remote.sha512 || null,
        releaseNotes: typeof release.body === "string" ? release.body : null
    };
}

function applyGithubAuthHeaders(token) {
    if (!token) return;
    autoUpdater.requestHeaders = {
        Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
        Accept: "application/octet-stream"
    };
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
    githubToken = token || null;
    autoUpdater.setFeedURL(feed);
    applyGithubAuthHeaders(token);
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
    githubToken = token || null;

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
        feedUrl: updateState.feedUrl,
        isPatch: Boolean(updateState.isPatch),
        patchRevision: updateState.patchRevision ?? null,
        localPatchRevision: getLocalPatchRevision()
    };
}

function extractSetupFileSize(info = {}) {
    const files = Array.isArray(info.files) ? info.files : [];
    const setup = files.find((file) => /\.exe$/i.test(String(file.url || "")));
    return Number(setup?.size || files[0]?.size || 0);
}

function getUpdaterCacheDir() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;
    return path.join(localAppData, "android-hub-updater");
}

function measureCacheBytes(cacheDir) {
    if (!cacheDir || !fs.existsSync(cacheDir)) return 0;

    let bytes = 0;
    const stack = [cacheDir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_err) {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            try {
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (entry.isFile()) {
                    bytes = Math.max(bytes, fs.statSync(fullPath).size);
                }
            } catch (_err) {
                // noop
            }
        }
    }
    return bytes;
}

function stopDownloadProgressPolling() {
    if (progressPollHandle) {
        clearInterval(progressPollHandle);
        progressPollHandle = null;
    }
}

function publishDownloadProgress(cacheBytes, totalBytes, bytesPerSecond = 0) {
    if (updateState.status !== "downloading") return;

    const total = totalBytes > 0 ? totalBytes : Math.max(cacheBytes, 1);
    const normalized = normalizeDownloadProgress({
        percent: totalBytes > 0 ? (cacheBytes / totalBytes) * 100 : 0,
        transferred: cacheBytes,
        total,
        bytesPerSecond
    });

    const previousPercent = updateState.progress?.percent ?? 0;
    if (Math.abs(normalized.percent - previousPercent) < 0.25 && normalized.percent < 100) {
        return;
    }

    setState({ status: "downloading", progress: normalized });
    broadcast("update:status", getPublicState());
}

function startDownloadProgressPolling(totalBytes) {
    stopDownloadProgressPolling();
    const cacheDir = getUpdaterCacheDir();
    lastPollBytes = measureCacheBytes(cacheDir);
    lastPollAt = Date.now();

    progressPollHandle = setInterval(() => {
        const cacheBytes = measureCacheBytes(cacheDir);
        const now = Date.now();
        const elapsedSec = Math.max(0.001, (now - lastPollAt) / 1000);
        const bytesPerSecond = Math.max(0, (cacheBytes - lastPollBytes) / elapsedSec);
        lastPollBytes = cacheBytes;
        lastPollAt = now;
        publishDownloadProgress(cacheBytes, totalBytes, bytesPerSecond);
    }, 400);
}

async function ensureUpdateInfoBeforeDownload() {
    if (autoUpdater.updateInfoAndProvider) {
        return;
    }
    appendLog("Resynchronisation des métadonnées avant téléchargement…");
    await autoUpdater.checkForUpdates();
}

function normalizeDownloadProgress(progress = {}) {
    let percent = Number(progress.percent);
    if (!Number.isFinite(percent) && Number(progress.total) > 0) {
        percent = (Number(progress.transferred) / Number(progress.total)) * 100;
    }
    if (!Number.isFinite(percent)) {
        percent = 0;
    }
    return {
        percent: Math.max(0, Math.min(100, percent)),
        transferred: progress.transferred ?? 0,
        total: progress.total ?? 0,
        bytesPerSecond: progress.bytesPerSecond ?? 0
    };
}

function attachAutoUpdaterEvents() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.logger = {
        info: (message) => appendLog(String(message)),
        warn: (message) => appendLog(`WARN ${message}`),
        error: (message) => appendLog(`ERROR ${message}`),
        debug: () => {}
    };

    autoUpdater.on("checking-for-update", () => {
        setState({ status: "checking", error: null, progress: null });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("update-available", (info) => {
        pendingSameVersionPatch = null;
        patchInstallerPath = null;
        expectedDownloadBytes = extractSetupFileSize(info);
        appendLog(`Mise à jour disponible: v${info.version}${expectedDownloadBytes ? ` (${Math.round(expectedDownloadBytes / 1024 / 1024)} Mo)` : ""}`);
        setState({
            status: "available",
            version: info.version,
            releaseNotes: normalizeReleaseNotes(info.releaseNotes),
            error: null,
            progress: null,
            isPatch: false,
            patchRevision: null
        });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("update-not-available", (info) => {
        pendingSameVersionPatch = null;
        appendLog(`Aucune nouvelle version semver (actuelle: v${info?.version || app.getVersion()})`);
        setState({
            status: "idle",
            version: null,
            releaseNotes: null,
            error: null,
            progress: null,
            isPatch: false,
            patchRevision: null,
            lastCheckedAt: Date.now()
        });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("error", (err) => {
        const message = err?.message || String(err);
        appendLog(`Erreur: ${message}`);
        stopDownloadProgressPolling();
        setState({ status: "error", error: message, progress: null });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("download-progress", (progress) => {
        const normalized = normalizeDownloadProgress(progress);
        if (normalized.percent > 0) {
            stopDownloadProgressPolling();
        }
        setState({
            status: "downloading",
            progress: normalized
        });
        broadcast("update:status", getPublicState());
    });

    autoUpdater.on("update-downloaded", (info) => {
        stopDownloadProgressPolling();
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

async function applySameVersionPatchIfNeeded() {
    if (updateState.status === "available" && !updateState.isPatch) {
        return false;
    }
    try {
        const patch = await detectSameVersionPatch();
        if (!patch) return false;

        pendingSameVersionPatch = patch;
        patchInstallerPath = null;
        expectedDownloadBytes = patch.setupSize || 0;
        setState({
            status: "available",
            version: patch.version,
            releaseNotes: normalizeReleaseNotes(patch.releaseNotes)
                || `Patch #${patch.patchRevision}`,
            error: null,
            progress: null,
            isPatch: true,
            patchRevision: patch.patchRevision
        });
        broadcast("update:status", getPublicState());
        return true;
    } catch (err) {
        appendLog(`Patch check: ${err?.message || err}`);
        return false;
    }
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
        await applySameVersionPatchIfNeeded();
        return getPublicState();
    } catch (err) {
        const message = err?.message || String(err);
        appendLog(`Erreur check: ${message}`);
        setState({ status: "error", error: message });
        broadcast("update:status", getPublicState());
        return getPublicState();
    }
}

function startDownloadUpdate() {
    if (!configured) {
        throw new Error("Mises à jour non configurées.");
    }
    if (downloadPromise) {
        return getPublicState();
    }
    if (updateState.status !== "available" && updateState.status !== "error") {
        throw new Error("Aucune mise à jour disponible à télécharger.");
    }

    setState({
        status: "downloading",
        error: null,
        progress: { percent: 0, transferred: 0, total: expectedDownloadBytes, bytesPerSecond: 0 }
    });
    broadcast("update:status", getPublicState());
    appendLog(
        pendingSameVersionPatch
            ? `Démarrage téléchargement patch #${pendingSameVersionPatch.patchRevision}…`
            : "Démarrage du téléchargement…"
    );
    startDownloadProgressPolling(expectedDownloadBytes);

    downloadPromise = (async () => {
        try {
            if (pendingSameVersionPatch) {
                const patch = pendingSameVersionPatch;
                const destDir = path.join(app.getPath("userData"), "pending-patch");
                fs.mkdirSync(destDir, { recursive: true });
                const destPath = path.join(destDir, patch.setupName || "AndroidHub-Setup-patch.exe");
                expectedDownloadBytes = patch.setupSize || expectedDownloadBytes;
                startDownloadProgressPolling(expectedDownloadBytes);

                await downloadGithubAsset(patch.setupAssetId, destPath, (transferred, total) => {
                    const bytesPerSecond = 0;
                    publishDownloadProgress(transferred, total || expectedDownloadBytes, bytesPerSecond);
                });

                if (patch.sha512) {
                    const actual = sha512FileBase64(destPath);
                    if (actual !== patch.sha512) {
                        try {
                            fs.unlinkSync(destPath);
                        } catch (_err) {
                            // noop
                        }
                        throw new Error("Contrôle d'intégrité du patch échoué (sha512).");
                    }
                }

                patchInstallerPath = destPath;
                stopDownloadProgressPolling();
                appendLog(`Patch téléchargé: ${destPath}`);
                setState({
                    status: "downloaded",
                    version: patch.version,
                    releaseNotes: normalizeReleaseNotes(patch.releaseNotes)
                        || `Patch #${patch.patchRevision}`,
                    progress: { percent: 100 },
                    error: null,
                    isPatch: true,
                    patchRevision: patch.patchRevision
                });
                broadcast("update:status", getPublicState());
                return getPublicState();
            }

            await ensureUpdateInfoBeforeDownload();
            if (!expectedDownloadBytes && autoUpdater.updateInfoAndProvider?.info) {
                expectedDownloadBytes = extractSetupFileSize(autoUpdater.updateInfoAndProvider.info);
            }
            startDownloadProgressPolling(expectedDownloadBytes);
            await autoUpdater.downloadUpdate();
            appendLog("Téléchargement terminé côté electron-updater.");
            return getPublicState();
        } catch (err) {
            const message = err?.message || String(err);
            appendLog(`Erreur download: ${message}`);
            setState({ status: "error", error: message, progress: null });
            broadcast("update:status", getPublicState());
            throw err;
        } finally {
            stopDownloadProgressPolling();
            downloadPromise = null;
        }
    })();

    return getPublicState();
}

async function downloadUpdate() {
    startDownloadUpdate();
    if (downloadPromise) {
        await downloadPromise;
    }
    return getPublicState();
}

function quitAndInstall() {
    if (!canInstallUpdates()) {
        throw new Error("Installation impossible — utilisez l'installateur NSIS (Setup.exe).");
    }

    if (patchInstallerPath && fs.existsSync(patchInstallerPath)) {
        appendLog(`Installation patch via ${patchInstallerPath}`);
        const child = spawn(patchInstallerPath, [], {
            detached: true,
            stdio: "ignore"
        });
        child.unref();
        app.quit();
        return;
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
    startDownloadUpdate,
    downloadUpdate,
    quitAndInstall,
    getPublicState
};
