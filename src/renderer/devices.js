/**
 * Service de polling ADB partagé (backend pour "Nouvelle instance").
 * N'affiche aucune UI — émet devices-refreshed et expose getCurrentDevices / refreshDevices.
 */
let currentDevices = [];
let pollingInterval = null;

function dedupeDevices(devices) {
    const byKey = new Map();

    for (const device of devices) {
        const key = device?.serial || device?.name;
        if (!key) continue;

        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, device);
            continue;
        }

        if (device.connected && !existing.connected) {
            byKey.set(key, device);
        }
    }

    return Array.from(byKey.values());
}

async function refreshDevices() {
    try {
        const response = await window.electronAPI.getDevices();
        const devices = Array.isArray(response)
            ? response
            : Array.isArray(response?.devices)
                ? response.devices
                : [];

        currentDevices = dedupeDevices(devices);
        window.dispatchEvent(new CustomEvent("devices-refreshed", { detail: currentDevices }));
    } catch (e) {
        console.error("Erreur recuperation appareils:", e);
    }
}

function startDevicePolling() {
    if (pollingInterval) return;
    refreshDevices();
    pollingInterval = setInterval(refreshDevices, 8000);
}

function getCurrentDevices() {
    return currentDevices.slice();
}

window.getCurrentDevices = getCurrentDevices;
window.refreshDevices = refreshDevices;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDevicePolling);
} else {
    startDevicePolling();
}
