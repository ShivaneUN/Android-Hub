/**
 * Service de polling ADB partagé — source de vérité renderer pour la liste devices.
 */
let currentDevices = [];
let pollingInterval = null;

function normalizeDevices(devices) {
    if (!Array.isArray(devices)) return [];
    return devices.filter((device) => device && (device.deviceId || device.serial));
}

async function refreshDevices() {
    try {
        const response = await window.electronAPI.getDevices();
        const devices = Array.isArray(response)
            ? response
            : Array.isArray(response?.devices)
                ? response.devices
                : [];

        currentDevices = normalizeDevices(devices);
        window.dispatchEvent(new CustomEvent("devices-refreshed", { detail: currentDevices.slice() }));
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

function getConnectedDevices() {
    return currentDevices.filter((device) => device?.connected !== false);
}

function findDeviceById(deviceId) {
    return currentDevices.find((device) => device.deviceId === deviceId || device.serial === deviceId) || null;
}

window.getCurrentDevices = getCurrentDevices;
window.getConnectedDevices = getConnectedDevices;
window.findDeviceById = findDeviceById;
window.refreshDevices = refreshDevices;

if (window.electronAPI?.onDevicesRefreshRequest) {
    window.electronAPI.onDevicesRefreshRequest(() => {
        void refreshDevices();
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDevicePolling);
} else {
    startDevicePolling();
}
