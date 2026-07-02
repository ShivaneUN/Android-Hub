/**
 * new-session.js
 *
 * UI Type B (Nouvelle instance) uniquement:
 * - Selection appareil
 * - Selection application
 * - Apercu commande
 * - Lancement pipeline dedie (session/tab/canvas/input independants)
 */

let selectedDevice = null;
let selectedApp = null;
let allApps = [];
let launchPipeline = null;

const newInstanceSessions = new Map();
let activeNewInstanceSessionId = null;

function buildAppKey(app = {}) {
    if (app.appKey) return String(app.appKey);
    const pkg = String(app.package || "");
    const userId = app.userId === undefined || app.userId === null ? "0" : String(app.userId);
    return `${pkg}@@${userId}`;
}

function getNewInstanceElements() {
    return {
        deviceList: document.getElementById("new-instance-device-list"),
        appSearchBlock: document.getElementById("new-instance-app-search-block"),
        appSearchInput: document.getElementById("new-instance-app-search-input"),
        appResults: document.getElementById("new-instance-app-results"),
        launchBtn: document.getElementById("new-instance-launch-btn"),
        launchHint: document.getElementById("new-instance-launch-hint"),
        status: document.getElementById("new-instance-status"),
        commandPreview: document.getElementById("new-instance-command-preview")
    };
}

function setStatus(message = "", isError = false) {
    const { status } = getNewInstanceElements();
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
}

function updateCommandPreview() {
    const { commandPreview } = getNewInstanceElements();
    if (!commandPreview) return;
    const packageName = selectedApp?.package || "";
    commandPreview.textContent = `scrcpy --new-display=1920x1080 --start-app=${packageName}`;
}

function updateLaunchState() {
    const { launchBtn, launchHint } = getNewInstanceElements();
    if (!launchBtn || !launchHint) return;

    const hasDevice = Boolean(selectedDevice);
    const hasApp = Boolean(selectedApp);
    const isReady = hasDevice && hasApp;

    launchBtn.classList.toggle("is-active", isReady);

    if (!hasDevice) {
        launchHint.textContent = "Selectionnez un appareil";
        updateCommandPreview();
        return;
    }

    if (!hasApp) {
        launchHint.textContent = "Selectionnez une application";
        updateCommandPreview();
        return;
    }

    launchHint.textContent = "Pret a lancer la nouvelle instance";
    updateCommandPreview();
}

function renderDeviceList(devices) {
    const { deviceList } = getNewInstanceElements();
    if (!deviceList) return;

    if (!devices.length) {
        deviceList.innerHTML = '<p class="apps-loading">Aucun appareil connecte</p>';
        return;
    }

    deviceList.innerHTML = devices.map((d) => `
        <button type="button" class="new-instance-device-item ${selectedDevice && selectedDevice.serial === d.serial ? "selected" : ""}" data-serial="${d.serial}" data-name="${d.name}">
            <span class="status-dot status-${d.status}"></span>
            <span class="new-instance-device-main">
                <span class="new-instance-device-name">${d.name}</span>
                <span class="new-instance-device-serial">${d.serial}</span>
            </span>
        </button>
    `).join("");

    deviceList.querySelectorAll(".new-instance-device-item").forEach((btn) => {
        btn.addEventListener("click", () => {
            selectDevice(btn.dataset.serial, btn.dataset.name);
        });
    });
}

function renderAppsList(apps) {
    const { appResults } = getNewInstanceElements();
    if (!appResults) return;

    if (!apps.length) {
        appResults.innerHTML = '<p class="apps-loading">Aucune application trouvee</p>';
        return;
    }

    appResults.innerHTML = apps.map((app) => `
        <button type="button" class="new-instance-app-item ${selectedApp && selectedApp.appKey === buildAppKey(app) ? "selected" : ""}" data-package="${app.package}" data-display="${app.displayName}" data-app-key="${buildAppKey(app)}" data-user-id="${app.userId ?? ""}">
            <span class="new-instance-app-name">${app.displayName}</span>
            <span class="new-instance-app-package">${app.package}${app.userId !== undefined && app.userId !== null ? ` (profil ${app.userId})` : ""}</span>
        </button>
    `).join("");

    appResults.querySelectorAll(".new-instance-app-item").forEach((btn) => {
        btn.addEventListener("click", () => {
            selectedApp = {
                package: btn.dataset.package,
                displayName: btn.dataset.display,
                userId: btn.dataset.userId === "" ? null : Number(btn.dataset.userId),
                appKey: btn.dataset.appKey
            };
            renderAppsList(allApps);
            updateLaunchState();
            setStatus("");
        });
    });
}

function filterAppsAndRender(query) {
    const normalized = query.toLowerCase().trim();
    if (!normalized) {
        renderAppsList(allApps);
        return;
    }

    const filtered = allApps.filter((app) => {
        const displayName = String(app.displayName || "").toLowerCase();
        const pkg = String(app.package || "").toLowerCase();
        const profile = app.userId === undefined || app.userId === null ? "" : String(app.userId).toLowerCase();
        return displayName.includes(normalized) || pkg.includes(normalized) || profile.includes(normalized);
    });

    renderAppsList(filtered);
}

async function loadAppsForSelectedDevice() {
    const { appSearchBlock, appResults } = getNewInstanceElements();
    if (!selectedDevice || !appResults || !appSearchBlock) return;

    appSearchBlock.classList.remove("hidden");
    appResults.innerHTML = '<p class="apps-loading">Chargement des applications...</p>';

    try {
        const response = await window.electronAPI.getAppsWithDetails(selectedDevice.serial);
        const apps = Array.isArray(response)
            ? response
            : Array.isArray(response?.apps)
                ? response.apps
                : [];

        allApps = apps.map((app) => ({
            ...app,
            appKey: buildAppKey(app)
        }));
        renderAppsList(allApps);
    } catch (err) {
        allApps = [];
        appResults.innerHTML = '<p class="apps-loading">Erreur lors du chargement des applications</p>';
        setStatus(`Erreur apps: ${err.message}`, true);
    }
}

async function selectDevice(serial, name) {
    selectedDevice = { serial, name };
    selectedApp = null;
    allApps = [];

    const devices = (Array.isArray(currentDevices) ? currentDevices : []).filter((d) => d.connected);
    renderDeviceList(devices);
    updateLaunchState();
    setStatus("");
    await loadAppsForSelectedDevice();
}

async function loadConnectedDevices() {
    const devices = (Array.isArray(currentDevices) ? currentDevices : []).filter((d) => d.connected);

    renderDeviceList(devices);

    const { appSearchBlock, appSearchInput, appResults } = getNewInstanceElements();
    if (!selectedDevice) {
        if (appSearchBlock) appSearchBlock.classList.add("hidden");
        if (appSearchInput) appSearchInput.value = "";
        if (appResults) appResults.innerHTML = "";
    }

    if (devices.length === 1 && !selectedDevice) {
        await selectDevice(devices[0].serial, devices[0].name);
    }
}

function createLaunchPipeline(sessionId) {
    return {
        sessionId,
        adbSocketConnected: false,
        h264FirstPacket: false,
        decoderReady: false,
        canvasActive: false
    };
}

function renderLaunchPipelineStatus(prefix = "Pipeline") {
    if (!launchPipeline) return;

    const parts = [
        `ADB Socket ${launchPipeline.adbSocketConnected ? "OK" : "..."}`,
        `H.264 ${launchPipeline.h264FirstPacket ? "OK" : "..."}`,
        `Decode ${launchPipeline.decoderReady ? "OK" : "..."}`,
        `Canvas ${launchPipeline.canvasActive ? "OK" : "..."}`
    ];

    setStatus(`${prefix}: ${parts.join(" | ")}`);
}

function setAllTabsInactive() {
    document.querySelectorAll(".scrcpy-tab").forEach((tab) => tab.classList.remove("active"));
}

function createNewInstanceTab(sessionId, label) {
    const tabsBar = document.getElementById("tabs-bar");
    if (!tabsBar) return null;

    const tab = document.createElement("div");
    tab.className = "scrcpy-tab active";
    tab.dataset.tabId = sessionId;
    tab.dataset.kind = "new-instance";
    tab.innerHTML = `
        <span class="tab-icon"></span>
        <span class="tab-label">${label}</span>
        <span class="tab-close">&#10005;</span>
    `;

    tab.addEventListener("click", (event) => {
        if (event.target.classList.contains("tab-close")) return;
        activateNewInstanceSession(sessionId);
    });

    const closeButton = tab.querySelector(".tab-close");
    if (closeButton) {
        closeButton.addEventListener("click", async (event) => {
            event.stopPropagation();
            await closeNewInstanceSession(sessionId);
        });
    }

    setAllTabsInactive();
    tabsBar.appendChild(tab);
    return tab;
}

function activateNewInstanceSession(sessionId) {
    const entry = newInstanceSessions.get(sessionId);
    if (!entry) return;

    const stage = document.getElementById("video-stage");
    if (!stage) return;

    stage.classList.add("active");

    stage.querySelectorAll("canvas").forEach((canvas) => {
        canvas.style.display = canvas.dataset.sessionId === sessionId ? "block" : "none";
    });

    document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
    setAllTabsInactive();
    if (entry.tab) {
        entry.tab.classList.add("active");
    }

    activeNewInstanceSessionId = sessionId;
    const titlebarTitle = document.querySelector(".titlebar-title");
    if (titlebarTitle) {
        titlebarTitle.textContent = entry.label || "Nouvelle instance";
    }
}

async function closeNewInstanceSession(sessionId) {
    const entry = newInstanceSessions.get(sessionId);
    if (!entry) return;

    try {
        // Suppression de l'Input Controller (identique au bouton Mirroring)
        if (typeof window.removeInputHandlers === "function") {
            window.removeInputHandlers(sessionId);
        }

        if (entry.player) {
            try {
                await entry.player.stop();
            } catch (_err) {
                // noop
            }
        }

        if (entry.pipeline) {
            await entry.pipeline.stop();
        }
    } catch (err) {
        console.error(`[NewSession] Erreur fermeture session ${sessionId}:`, err);
    }

    if (entry.canvas) {
        entry.canvas.remove();
    }

    if (entry.tab) {
        entry.tab.remove();
    }

    newInstanceSessions.delete(sessionId);

    if (activeNewInstanceSessionId === sessionId) {
        activeNewInstanceSessionId = null;
        const remaining = Array.from(newInstanceSessions.keys());
        if (remaining.length > 0) {
            activateNewInstanceSession(remaining[remaining.length - 1]);
        } else {
            const stage = document.getElementById("video-stage");
            if (stage) {
                stage.classList.remove("active");
            }
            showPage("page-new");
            document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
        }
    }
}

async function launchNewInstanceSession() {
    if (!selectedDevice) {
        updateLaunchState();
        return;
    }
    if (!selectedApp) {
        updateLaunchState();
        return;
    }

    const payload = {
        serial: selectedDevice.serial,
        packageName: selectedApp.package,
        userId: Number.isInteger(selectedApp.userId) ? selectedApp.userId : null,
        tabLabel: selectedApp.displayName
    };

    setStatus("Lancement en cours...");

    const created = await window.electronAPI.newInstanceCreate(payload);
    if (!created?.success || !created?.session?.sessionId) {
        setStatus(`Erreur lancement: ${created?.error || "creation session impossible"}`, true);
        return;
    }

    const session = created.session;
    const sessionId = session.sessionId;
    const stage = document.getElementById("video-stage");

    const canvas = document.createElement("canvas");
    canvas.id = `canvas-${sessionId}`;
    canvas.dataset.sessionId = sessionId;
    canvas.dataset.kind = "new-instance";
    canvas.style.display = "none";

    if (stage) {
        stage.appendChild(canvas);
    }

    const tab = createNewInstanceTab(sessionId, selectedApp.displayName || selectedApp.package);
    const pipeline = window.createNewInstanceVideoPipeline(sessionId, canvas);

    newInstanceSessions.set(sessionId, {
        sessionId,
        label: selectedApp.displayName || selectedApp.package,
        tab,
        canvas,
        pipeline,
        serial: selectedDevice.serial,
        packageName: selectedApp.package
    });

    activateNewInstanceSession(sessionId);

    try {
        const started = await pipeline.start();
        if (!started?.success) {
            throw new Error(started?.error || "demarrage session echoue");
        }

        // Input Controller (identique au bouton Mirroring - utilise input-controller.js)
        if (typeof window.installInputHandlers === "function") {
            window.installInputHandlers(canvas, sessionId, selectedDevice.serial, "portrait");
        }

        launchPipeline = createLaunchPipeline(sessionId);
        renderLaunchPipelineStatus(`Instance lancee pour ${selectedApp.displayName}`);
    } catch (err) {
        await closeNewInstanceSession(sessionId);
        setStatus(`Erreur lancement: ${err.message}`, true);
    }
}

async function launchMirrorSession() {
    if (!selectedDevice) {
        setStatus("Selectionnez d'abord un appareil", true);
        return;
    }

    const serial = selectedDevice.serial;
    const deviceName = selectedDevice.name || serial;
    const sessionId = "mirror-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    const stage = document.getElementById("video-stage");

    const canvas = document.createElement("canvas");
    canvas.id = `canvas-${sessionId}`;
    canvas.dataset.sessionId = sessionId;
    canvas.dataset.kind = "mirror";
    canvas.style.display = "none";

    if (stage) {
        stage.appendChild(canvas);
    }

    const tab = createNewInstanceTab(sessionId, deviceName + " (Mirror)");

    // Utilise le pipeline new-instance existant pour le flux vidéo
    const pipeline = window.createNewInstanceVideoPipeline(sessionId, canvas);

    newInstanceSessions.set(sessionId, {
        sessionId,
        label: deviceName + " (Mirror)",
        tab,
        canvas,
        pipeline,
        serial,
        packageName: null
    });

    activateNewInstanceSession(sessionId);

    setStatus("Lancement du mirroring...");

    // Utilise le système de player existant (identique à instance-manager.js)
    const player = createVideoPlayer(sessionId, canvas);

    try {
        const result = await player.start(serial, null, {});
        if (!result?.success) {
            throw new Error(result?.error || "echec demarrage stream video");
        }

        // Installe l'Input Controller complet (identique à instance-manager.js)
        if (typeof window.installInputHandlers === "function") {
            window.installInputHandlers(canvas, sessionId, serial, "portrait");
        }

        // Stocke le player pour pouvoir l'arrêter
        newInstanceSessions.get(sessionId).player = player;

        setStatus(`Mirroring actif pour ${deviceName}`);
    } catch (err) {
        await closeNewInstanceSession(sessionId);
        setStatus(`Erreur mirroring: ${err.message}`, true);
    }
}

async function openNewSessionPanel() {
    showPage("page-new-session");
    document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
    document.getElementById("nav-new-session").classList.add("active");
    selectedDevice = null;
    selectedApp = null;
    allApps = [];
    launchPipeline = null;
    setStatus("");
    updateLaunchState();
    await loadConnectedDevices();
}

document.addEventListener("DOMContentLoaded", () => {
    const navNewSession = document.getElementById("nav-new-session");
    const appSearchInput = document.getElementById("new-instance-app-search-input");
    const launchBtn = document.getElementById("new-instance-launch-btn");

    if (navNewSession) {
        navNewSession.addEventListener("click", openNewSessionPanel);
    }

    if (appSearchInput) {
        appSearchInput.addEventListener("input", (e) => {
            filterAppsAndRender(e.target.value || "");
        });
    }

    if (launchBtn) {
        launchBtn.addEventListener("click", () => {
            launchNewInstanceSession().catch((err) => {
                setStatus(`Erreur lancement: ${err.message}`, true);
            });
        });
    }

    const mirrorBtn = document.getElementById("new-instance-mirror-btn");
    if (mirrorBtn) {
        mirrorBtn.addEventListener("click", () => {
            launchMirrorSession().catch((err) => {
                setStatus(`Erreur mirroring: ${err.message}`, true);
            });
        });
    }

    if (window.electronAPI?.onNewInstanceState) {
        window.electronAPI.onNewInstanceState((data) => {
            if (!launchPipeline || !data || data.sessionId !== launchPipeline.sessionId) return;
            if (data.state === "started") {
                launchPipeline.adbSocketConnected = true;
                renderLaunchPipelineStatus("Pipeline Android -> Canvas");
            }
            if (data.state === "display-ready") {
                launchPipeline.adbSocketConnected = true;
                renderLaunchPipelineStatus("Pipeline Android -> Canvas");
            }
        });
    }

    if (window.electronAPI?.onNewInstanceVideoCodecMeta) {
        window.electronAPI.onNewInstanceVideoCodecMeta((data) => {
            if (!launchPipeline || !data || data.sessionId !== launchPipeline.sessionId) return;
            launchPipeline.decoderReady = true;
            renderLaunchPipelineStatus("Pipeline Android -> Canvas");
        });
    }

    if (window.electronAPI?.onNewInstanceVideoPacket) {
        window.electronAPI.onNewInstanceVideoPacket((data) => {
            if (!launchPipeline || !data || data.sessionId !== launchPipeline.sessionId) return;
            launchPipeline.h264FirstPacket = true;
            renderLaunchPipelineStatus("Pipeline Android -> Canvas");
        });
    }

    if (window.electronAPI?.onNewInstanceVideoError) {
        window.electronAPI.onNewInstanceVideoError((data) => {
            if (!launchPipeline || !data || data.sessionId !== launchPipeline.sessionId) return;
            setStatus(`Erreur flux video: ${data.error || "inconnue"}`, true);
        });
    }

    window.addEventListener("new-instance:first-frame", (event) => {
        const sessionId = event?.detail?.sessionId;
        if (!launchPipeline || sessionId !== launchPipeline.sessionId) return;
        launchPipeline.canvasActive = true;
        renderLaunchPipelineStatus("Pipeline Android -> Canvas");
    });

    window.addEventListener("devices-refreshed", async () => {
        const panel = document.getElementById("page-new-session");
        if (!panel || panel.classList.contains("hidden")) return;

        const connectedDevices = (Array.isArray(currentDevices) ? currentDevices : []).filter((d) => d.connected);
        if (selectedDevice && !connectedDevices.some((d) => d.serial === selectedDevice.serial)) {
            selectedDevice = null;
            selectedApp = null;
            allApps = [];
            setStatus("L'appareil selectionne n'est plus connecte.", true);
            await loadConnectedDevices();
            updateLaunchState();
            return;
        }

        renderDeviceList(connectedDevices);
        updateLaunchState();
    });

    updateLaunchState();
});
