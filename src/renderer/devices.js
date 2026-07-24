/**
 * Service de polling ADB partagé — source de vérité renderer pour la liste devices.
 */
let currentDevices = [];
let pollingTimer = null;
let pollingStarted = false;
let lastRefreshAt = 0;
let refreshInFlight = null;
let lastWifiWatchActive = false;
const DEVICE_REFRESH_MIN_MS = 2500;
const DEVICE_POLL_INTERVAL_MS = 12000;
/** Poll rapide si WiFi armé / actif — détecte le rebranchement USB sans attendre 12s. */
const DEVICE_POLL_INTERVAL_WIFI_MS = 1500;
const DEVICE_FULL_STATUS_EVERY_N_POLLS = 4;
let lightweightPollCount = 0;

function normalizeDevices(devices) {
    if (!Array.isArray(devices)) return [];
    return devices.filter((device) => device && (device.deviceId || device.serial));
}

function deviceSnapshotKey(device) {
    return device?.deviceId || device?.serial || "";
}

function isWifiTransportWatchActive(devices = currentDevices) {
    return (devices || []).some((device) =>
        Boolean(device?.wifiEnabled || device?.wifiActive || device?.transport === "wifi")
    );
}

function resolvePollIntervalMs(devices = currentDevices) {
    return isWifiTransportWatchActive(devices)
        ? DEVICE_POLL_INTERVAL_WIFI_MS
        : DEVICE_POLL_INTERVAL_MS;
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

function clearDevicePollingTimer() {
    if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
    }
}

function scheduleNextDevicePoll() {
    if (!pollingStarted) return;
    clearDevicePollingTimer();
    pollingTimer = setTimeout(() => {
        void runScheduledDevicePoll();
    }, resolvePollIntervalMs());
}

async function pollDeviceList({ force = false, lightweight = false, forceFresh = false } = {}) {
    const cacheIsFresh = lastRefreshAt > 0 && (Date.now() - lastRefreshAt < DEVICE_REFRESH_MIN_MS);
    const hasDevices = currentDevices.length > 0;

    if (!force && !forceFresh && cacheIsFresh && hasDevices) {
        return currentDevices.slice();
    }

    if (refreshInFlight) {
        return refreshInFlight;
    }

    refreshInFlight = (async () => {
        try {
            const response = await window.electronAPI.getDevices({
                ...(lightweight ? { lightweight: true } : {}),
                ...(forceFresh ? { forceFresh: true } : {})
            });
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

            const wifiWatch = isWifiTransportWatchActive();
            if (wifiWatch !== lastWifiWatchActive) {
                lastWifiWatchActive = wifiWatch;
                scheduleNextDevicePoll();
            }
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
    return pollDeviceList({ force: true, forceFresh: true });
}

async function runScheduledDevicePoll() {
    lightweightPollCount += 1;
    const wifiWatch = isWifiTransportWatchActive();
    if (lightweightPollCount >= DEVICE_FULL_STATUS_EVERY_N_POLLS) {
        lightweightPollCount = 0;
        await pollDeviceList({ force: true, lightweight: false, forceFresh: wifiWatch });
    } else {
        await pollDeviceList({
            force: wifiWatch,
            lightweight: true,
            forceFresh: wifiWatch
        });
    }
    scheduleNextDevicePoll();
}

function startDevicePolling() {
    if (pollingStarted) return;
    pollingStarted = true;
    void pollDeviceList({ force: true, forceFresh: true }).then((devices) => {
        if (!devices.length) {
            setTimeout(() => void pollDeviceList({ force: true, forceFresh: true }), 600);
        }
        lastWifiWatchActive = isWifiTransportWatchActive();
        scheduleNextDevicePoll();
    });
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
