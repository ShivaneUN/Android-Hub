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

    const label = options.tabLabel || (packageName
        ? `${deviceName} - ${packageName.split(".").pop()}`
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

    createTab(id, label);
    activateInstance(id);

    const result = await player.start(deviceId, packageName, options);

    instance.status = result.success ? "active" : "error";
    if (result.success) {
        if (typeof installInputHandlers === "function") {
            installInputHandlers(canvas, id, deviceId, options.orientation);
        }
    }

    if (!result.success) {
        console.error(`[InstanceManager] Échec démarrage instance ${id}:`, result.error);
    }

    return id;
}

/**
 * Active une instance : affiche son canvas, cache les autres,
 * cache les pages classiques (accueil, panneaux).
 */
function activateInstance(id) {
    const instance = instances[id];
    if (!instance) return;

    const stage = document.getElementById("video-stage");
    stage.classList.add("active");

    Object.values(instances).forEach(inst => {
        inst.canvas.style.display = (inst.id === id) ? "block" : "none";
    });

    document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));

    setActiveTab(id);
    activeInstanceId = id;

    // Mettre à jour le Focus
    if (window.electronAPI.focusSet) {
        window.electronAPI.focusSet(id).catch(err => {
            console.error(`[InstanceManager] Erreur focus:`, err);
        });
    }
}

/**
 * Ferme une instance : arrête le flux, retire le canvas et l'onglet.
 * Active automatiquement la dernière instance restante, ou revient
 * à la page d'accueil s'il n'y en a plus.
 */
async function closeInstance(id) {
    const instance = instances[id];
    if (!instance) return;

    if (typeof removeInputHandlers === "function") {
        removeInputHandlers(id);
    }

    await instance.player.stop();
    instance.canvas.remove();
    delete instances[id];

    removeTab(id);

    const remainingIds = Object.keys(instances);
    const stage = document.getElementById("video-stage");

    if (remainingIds.length === 0) {
        stage.classList.remove("active");
        activeInstanceId = null;
        showPage("page-new");
        document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
    } else {
        activateInstance(remainingIds[remainingIds.length - 1]);
    }
}

/**
 * Retourne la liste des instances actives pour un appareil donné.
 */
function getInstancesForDevice(deviceId) {
    return Object.values(instances).filter(inst => inst.deviceId === deviceId);
}

/**
 * Retourne l'instance actuellement active, ou null.
 */
function getActiveInstance() {
    return activeInstanceId ? instances[activeInstanceId] : null;
}