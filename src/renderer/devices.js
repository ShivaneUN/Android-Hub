/**
 * Service de polling ADB partagé — source de vérité renderer pour la liste devices.
 */
let currentDevices = [];
let pollingInterval = null;
let lastRefreshAt = 0;
let refreshInFlight = null;
const DEVICE_REFRESH_MIN_MS = 2500;

function normalizeDevices(devices) {
    if (!Array.isArray(devices)) return [];
    return devices.filter((device) => device && (device.deviceId || device.serial));
}

function dispatchDevicesRefreshed(devices) {
    window.dispatchEvent(new CustomEvent("devices-refreshed", { detail: devices.slice() }));
}

async function pollDeviceList({ force = false } = {}) {
    const cacheIsFresh = lastRefreshAt > 0 && (Date.now() - lastRefreshAt < DEVICE_REFRESH_MIN_MS);
    const hasDevices = currentDevices.length > 0;

    if (!force && cacheIsFresh && hasDevices) {
        return currentDevices.slice();
    }

    if (refreshInFlight) {
        return refreshInFlight;
    }

    refreshInFlight = (async () => {
        try {
            const response = await window.electronAPI.getDevices();
            const devices = Array.isArray(response)
                ? response
                : Array.isArray(response?.devices)
                    ? response.devices
                    : [];

            currentDevices = normalizeDevices(devices);
            lastRefreshAt = Date.now();
            dispatchDevicesRefreshed(currentDevices);
        } catch (e) {
            console.error("Erreur recuperation appareils:", e);
        } finally {
            refreshInFlight = null;
        }

        return currentDevices.slice();
    })();

    return refreshInFlight;
}

async function refreshDevicesIfStale() {
    return pollDeviceList({ force: false });
}

async function refreshDevicesForce() {
    return pollDeviceList({ force: true });
}

function startDevicePolling() {
    if (pollingInterval) return;
    void pollDeviceList({ force: true }).then((devices) => {
        if (!devices.length) {
            setTimeout(() => void pollDeviceList({ force: true }), 600);
        }
    });
    pollingInterval = setInterval(() => {
        void pollDeviceList({ force: true });
    }, 8000);
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
window.refreshDevices = refreshDevicesForce;
window.refreshDevicesIfStale = refreshDevicesIfStale;
window.refreshDevicesForce = refreshDevicesForce;

if (window.electronAPI?.onDevicesRefreshRequest) {
    window.electronAPI.onDevicesRefreshRequest(() => {
        void refreshDevicesForce();
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDevicePolling);
} else {
    startDevicePolling();
}
