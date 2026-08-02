/**
 * instance-manager.js
 *
 * Gère le cycle de vie complet des instances (onglets) :
 * création, activation, fermeture. Chaque instance est indépendante
 * et possède son propre flux vidéo (socket + décodeur + canvas).
 */

const instances = {}; // { instanceId: Instance }
let activeInstanceId = null;

/**
 * Crée une nouvelle instance : génère un id unique, crée le canvas,
 * le lecteur vidéo, l'onglet, et démarre le flux.
 *
 * @param {string} deviceId - serial ADB de l'appareil
 * @param {string} deviceName - nom lisible de l'appareil
 * @param {string|null} packageName - package à lancer au démarrage, ou null pour juste l'écran
 * @returns {Promise<string>} l'id de l'instance créée
 */
async function createInstance(deviceId, deviceName, packageName = null, options = {}) {
    const id = "instance-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

    if (options.latencyTraceId && window.LaunchLatency?.bindSession) {
        await window.LaunchLatency.bindSession(options.latencyTraceId, id);
    }

    const label = options.tabLabel || (packageName
        ? (window.AppDisplay?.humanizePackageName?.(packageName) || packageName.split(".").pop())
        : deviceName);

    return await setupInstance(id, deviceId, deviceName, packageName, label, options);
}

async function setupInstance(id, deviceId, deviceName, packageName, label, options) {
    const canvas = document.createElement("canvas");
    canvas.id = `canvas-${id}`;
    canvas.style.display = "none";

    const stage = document.getElementById("video-stage");
    stage.appendChild(canvas);

    const player = createVideoPlayer(id, canvas);

    const instance = {
        id,
        deviceId,
        deviceName,
        packageName,
        label,
        canvas,
        player,
        status: "connecting",
        options
    };

    instances[id] = instance;

    try {
        if (window.sessionAPI) {
            await window.sessionAPI.registerView(id, "A", {
                deviceId,
                stableDeviceId: options.stableDeviceId || null,
                label,
                packageName: packageName || null
            });
        }

        const result = await player.start(deviceId, packageName, options);
        instance.status = result.success ? "active" : "error";

        if (result.success && window.__sessionStreamBridge) {
            window.__sessionStreamBridge.registerSessionStreamHandle(id, {
                type: "A",
                stop: () => player.stop(),
                restart: (serial, pkg, opts) => player.restart(serial, pkg, opts)
            });
        }

        if (result.success) {
            if (typeof finalizeSessionUI === "function") {
                await finalizeSessionUI(id, { label });
            } else {
                activateInstance(id);
            }
        } else {
            console.error(`[InstanceManager] Échec démarrage instance ${id}:`, result.error);
            if (window.sessionAPI) await window.sessionAPI.close(id);
            instance.player.dispose?.();
            instance.canvas.remove();
            delete instances[id];
        }
    } catch (err) {
        console.error(`[InstanceManager] Erreur instance ${id}:`, err);
        if (window.sessionAPI) await window.sessionAPI.close(id);
        instance.player.dispose?.();
        instance.canvas.remove();
        delete instances[id];
    }

    return id;
}

/**
 * Active une instance : affiche son canvas, cache les autres,
 * cache les pages classiques (accueil, panneaux).
 */
async function activateInstance(id) {
    const instance = instances[id];
    if (!instance) return;

    document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));

    if (window.sessionAPI) {
        await window.sessionAPI.switchTo(id);
        if (typeof renderSidebar === "function") renderSidebar();
    }

    activeInstanceId = id;
}

/**
 * Ferme une instance : arrête le flux, retire le canvas et l'onglet.
 * Active automatiquement une session restante (A ou B), ou revient
 * à l’accueil s’il n’y en a plus.
 */
async function closeInstance(id) {
    const instance = instances[id];
    if (!instance) return;

    await instance.player.stop();
    instance.player.dispose?.();
    instance.canvas.remove();
    delete instances[id];

    if (window.__sessionStreamBridge) {
        window.__sessionStreamBridge.unregisterSessionStreamHandle(id);
    }

    if (window.sessionAPI) {
        await window.sessionAPI.close(id);
    }

    // Liste globale (Type A + B) — ne pas se limiter à la map locale Type A.
    let remaining = [];
    try {
        const listed = await window.sessionAPI?.list?.();
        remaining = (Array.isArray(listed) ? listed : [])
            .filter((session) => session?.sessionId && session.sessionId !== id);
    } catch (_err) {
        remaining = [];
    }

    if (remaining.length > 0) {
        const nextId = remaining[remaining.length - 1].sessionId;
        if (typeof activateSessionTab === "function") {
            await activateSessionTab(nextId);
        } else if (nextId.startsWith("instance-") && instances[nextId]) {
            await activateInstance(nextId);
        } else if (typeof activateNewInstanceSession === "function" && nextId.startsWith("new-instance-")) {
            activateNewInstanceSession(nextId);
        }
    } else {
        activeInstanceId = null;
        // Même chemin que Type B : Accueil propre (flag + chrome + suppressView).
        if (typeof window.goToLaunchHome === "function") {
            await window.goToLaunchHome();
        } else {
            window.__hubShowingHome = true;
            showPage("page-new");
            document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
            document.querySelector(".content")?.classList.remove(
                "content--session-view",
                "content--session-focused"
            );
            if (window.sessionAPI?.suppressView) {
                await window.sessionAPI.suppressView();
            }
        }
    }

    if (typeof renderSidebar === "function") renderSidebar();
}

/**
 * Retourne la liste des instances actives pour un appareil donné.
 */
function getInstancesForDevice(deviceId) {
    return Object.values(instances).filter(inst => inst.deviceId === deviceId);
}

function getAllInstances() {
    return Object.values(instances);
}

window.getAllInstances = getAllInstances;