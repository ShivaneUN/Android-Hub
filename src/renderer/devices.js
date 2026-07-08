/**
 * Service de polling ADB partagé — source de vérité renderer pour la liste devices.
 */
let currentDevices = [];
let pollingInterval = null;
let lastRefreshAt = 0;
let refreshInFlight = null;
const DEVICE_REFRESH_MIN_MS = 2500;
const DEVICE_POLL_INTERVAL_MS = 12000;
const DEVICE_FULL_STATUS_EVERY_N_POLLS = 4;
let lightweightPollCount = 0;

function normalizeDevices(devices) {
    if (!Array.isArray(devices)) return [];
    return devices.filter((device) => device && (device.deviceId || device.serial));
}

function deviceSnapshotKey(device) {
    return device?.deviceId || device?.serial || "";
}

function mergeLightweightDevices(previous, incoming) {
    if (!Array.isArray(previous) || !previous.length) return incoming;

    const prevByKey = new Map();
    for (const device of previous) {
        const key = deviceSnapshotKey(device);
        if (key) prevByKey.set(key, device);
    }

    return incoming.map((device) => {
        const key = deviceSnapshotKey(device);
        const prev = key ? prevByKey.get(key) : null;
        if (!prev) return device;

        return {
            ...prev,
            ...device,
            battery: Number.isFinite(device.battery) ? device.battery : (prev.battery ?? null),
            wifiStatus: device.wifiStatus || prev.wifiStatus || "Inconnu"
        };
    });
}

function dispatchDevicesRefreshed(devices) {
    window.dispatchEvent(new CustomEvent("devices-refreshed", { detail: devices.slice() }));
}

async function pollDeviceList({ force = false, lightweight = false } = {}) {
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
            const response = await window.electronAPI.getDevices(
                lightweight ? { lightweight: true } : {}
            );
            const devices = Array.isArray(response)
                ? response
                : Array.isArray(response?.devices)
                    ? response.devices
                    : [];

            const incoming = normalizeDevices(devices);
            currentDevices = lightweight && currentDevices.length
                ? mergeLightweightDevices(currentDevices, incoming)
                : incoming;
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
        lightweightPollCount += 1;
        if (lightweightPollCount >= DEVICE_FULL_STATUS_EVERY_N_POLLS) {
            lightweightPollCount = 0;
            void pollDeviceList({ force: true, lightweight: false });
            return;
        }
        void pollDeviceList({ force: false, lightweight: true });
    }, DEVICE_POLL_INTERVAL_MS);
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
