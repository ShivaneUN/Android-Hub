let currentDevices = [];
let pollingInterval = null;
const activePlayers = {}; // { tabId: player }

async function refreshDevices() {
    try {
        const response = await window.electronAPI.getDevices();
        const devices = Array.isArray(response)
            ? response
            : Array.isArray(response?.devices)
                ? response.devices
                : [];

        currentDevices = devices;
        renderDeviceList(devices);
        window.dispatchEvent(new CustomEvent('devices-refreshed', { detail: devices }));
    } catch (e) {
        console.error("Erreur récupération appareils:", e);
        const container = document.getElementById("devices-list");
        if (container) {
            container.innerHTML = `
                <p class="side-panel-empty">Erreur de récupération des appareils</p>
                <span class="side-panel-link">Vérifiez la connexion ADB puis réessayez.</span>
            `;
        }
    }
}

function renderDeviceList(devices) {
    const container = document.getElementById("devices-list");
    if (!container) return;

    const normalized = (Array.isArray(devices) ? devices : []).map((d) => ({
        serial: d?.serial || "unknown",
        status: d?.status || "orange",
        name: d?.name || d?.serial || "Unknown",
        connected: d?.connected !== false
    }));

    const connectedOnly = normalized.filter((d) => d.connected);

    if (connectedOnly.length === 0) {
        container.innerHTML = `
            <p class="side-panel-empty">Aucun device connecté</p>
            <span class="side-panel-link">Problème pour détecter votre appareil ?</span>
        `;
        return;
    }

    container.innerHTML = `
        <div class="side-panel-hint">Devices détectés: ${connectedOnly.length}</div>
    ` + connectedOnly.map(d => `
        <div class="device-card" data-serial="${d.serial}">
            <div class="device-header">
                <span class="status-dot status-${d.status}"></span>
                <span class="device-name">${d.name}</span>
                <span class="device-serial">${d.serial}</span>
            </div>
            <div class="device-actions">
                <button class="btn-device-action" data-action="apps" data-serial="${d.serial}">
                    Voir les apps
                </button>
                <button class="btn-device-action" data-action="launch" data-serial="${d.serial}">
                    Lancer scrcpy
                </button>
            </div>
            <div class="device-apps-panel" id="apps-panel-${d.serial}" style="display:none;"></div>
        </div>
    `).join("");

    container.querySelectorAll(".btn-device-action").forEach(btn => {
        btn.addEventListener("click", handleDeviceAction);
    });
}

async function handleDeviceAction(e) {
    const action = e.target.dataset.action;
    const serial = e.target.dataset.serial;

    if (action === "apps") {
        await toggleAppsPanel(serial);
    } else if (action === "launch") {
        const device = currentDevices.find(d => d.serial === serial);
        const deviceName = device ? device.name : serial;
        await createInstance(serial, deviceName, null);
    }
}

async function toggleAppsPanel(serial) {
    const panel = document.getElementById(`apps-panel-${serial}`);
    if (!panel) return;

    const isVisible = panel.style.display === "block";
    if (isVisible) {
        panel.style.display = "none";
        return;
    }

    document.querySelectorAll(".device-apps-panel").forEach(p => {
        if (p !== panel) p.style.display = "none";
    });

    panel.style.display = "block";
    panel.innerHTML = `<p class="apps-loading">Chargement des apps...</p>`;

    const apps = await window.electronAPI.getApps(serial);

    if (apps.length === 0) {
        panel.innerHTML = `<p class="apps-loading">Aucune app trouvée.</p>`;
        return;
    }

    panel.innerHTML = `
        <input type="text" class="apps-filter" placeholder="Filtrer les applications..." data-serial="${serial}">
        <div class="apps-list" id="apps-list-${serial}">
            ${apps.map(pkg => `
                <div class="app-item" data-package="${pkg}">
                    <span class="app-name">${pkg}</span>
                    <button class="btn-app-launch" data-serial="${serial}" data-package="${pkg}">Lancer</button>
                </div>
            `).join("")}
        </div>
    `;

    const filterInput = panel.querySelector(".apps-filter");
    filterInput.addEventListener("input", () => {
        const query = filterInput.value.toLowerCase();
        panel.querySelectorAll(".app-item").forEach(item => {
            const name = item.querySelector(".app-name").textContent.toLowerCase();
            item.style.display = name.includes(query) ? "flex" : "none";
        });
    });

    panel.querySelectorAll(".btn-app-launch").forEach(btn => {
    btn.addEventListener("click", async () => {
        const s = btn.dataset.serial;
        const pkg = btn.dataset.package;
        const device = currentDevices.find(d => d.serial === s);
        const deviceName = device ? device.name : s;
        await createInstance(s, deviceName, pkg);
    });
});

}

function startDevicePolling() {
    if (pollingInterval) return;
    refreshDevices();
    pollingInterval = setInterval(refreshDevices, 3000);
}

function initDevicesPanel() {
    if (document.getElementById("devices-list")) {
        startDevicePolling();

        const navDevices = document.getElementById("nav-devices");
        if (navDevices) {
            navDevices.addEventListener("click", () => {
                refreshDevices();
            });
        }
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDevicesPanel);
} else {
    initDevicesPanel();
}