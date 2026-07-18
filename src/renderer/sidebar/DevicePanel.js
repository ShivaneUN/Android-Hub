/**
 * Panneau sidebar : liste unifiée des appareils (USB / WiFi fusionnés).
 */
const dt = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

const WIFI_ERROR_STEPS = ["tcpip", "ip", "connect"];

/** @type {{ globalMuted: boolean, devices: Record<string, { muted?: boolean }> }} */
let cachedAudioState = { globalMuted: true, devices: {} };

function getConnectedOnly(devices) {
    return (Array.isArray(devices) ? devices : []).filter((device) => device?.connected !== false);
}

function formatBattery(battery) {
    if (battery === null || battery === undefined || Number.isNaN(battery)) {
        return "—";
    }
    return `${Math.round(battery)}%`;
}

function batteryClass(battery) {
    if (battery === null || battery === undefined) return "unknown";
    if (battery <= 20) return "low";
    if (battery <= 50) return "medium";
    return "good";
}

function transportClass(device) {
    if (device.transport === "wifi") return "wifi-connected";
    if (device.transport === "usb") return "usb-connected";
    return "unknown";
}

function wifiErrorMessage(step) {
    if (step && WIFI_ERROR_STEPS.includes(step)) {
        return dt(`devicePanel.errors.${step}`);
    }
    return null;
}

function wifiProgressMessage(step) {
    if (step && WIFI_ERROR_STEPS.includes(step)) {
        return dt(`devicePanel.progress.${step}`);
    }
    return null;
}

function deviceAudioKey(device) {
    return device?.deviceId || device?.serial || "";
}

/** Audio PC effectif pour un appareil (maître OFF ⇒ tout off ; sinon défaut ON). */
function isDeviceAudioOn(device) {
    if (cachedAudioState.globalMuted) return false;
    const keys = [device?.deviceId, device?.serial].filter(Boolean);
    if (keys.length === 0) return false;
    for (const key of keys) {
        if (cachedAudioState.devices?.[key]?.muted === true) return false;
    }
    return true;
}

const AUDIO_ICON_ON = `<svg class="sidebar-device-audio-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
const AUDIO_ICON_OFF = `<svg class="sidebar-device-audio-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v4h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;

const TRANSPORT_SWITCH_POLL_INTERVAL_MS = 600;
const TRANSPORT_SWITCH_TIMEOUT_MS = 18000;

function normalizeDeviceListResponse(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.devices)) return response.devices;
    return [];
}

function findDeviceEntry(devices, deviceId) {
    if (!deviceId) return null;
    return devices.find((entry) => entry?.deviceId === deviceId || entry?.serial === deviceId) || null;
}

function isTransportSwitchConfirmed(entry, enabled) {
    if (!entry) return false;
    if (enabled) {
        return entry.transport === "wifi" && entry.wifiActive === true;
    }
    return entry.transport === "usb";
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTransportSwitch(deviceId, enabled, options = {}) {
    const intervalMs = options.intervalMs ?? TRANSPORT_SWITCH_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? TRANSPORT_SWITCH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (window.electronAPI?.getDevices) {
            try {
                const response = await window.electronAPI.getDevices({ forceFresh: true });
                const devices = normalizeDeviceListResponse(response);
                const entry = findDeviceEntry(devices, deviceId);
                if (isTransportSwitchConfirmed(entry, enabled)) {
                    return { confirmed: true, device: entry };
                }
            } catch (_err) {
                // noop — retry until timeout
            }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(intervalMs, remaining));
    }

    return { confirmed: false, device: null };
}

async function handleWifiToggle(device, enabled, toggleInput) {
    if (!window.wifiAPI?.toggle) return;

    if (toggleInput) toggleInput.disabled = true;

    const switchFailedMessage = dt("devicePanel.switchFailed");
    window.showHubLoadingOverlay?.(dt("devicePanel.switchInProgress"), {
        timeoutMs: 120000,
        timeoutMessage: switchFailedMessage,
        errorAutoCloseMs: 2800
    });

    try {
        const result = await window.wifiAPI.toggle({
            deviceId: device.deviceId,
            enabled,
            usbSerial: device.usbSerial
                || (device.transport === "usb" ? device.serial : null)
                || null,
            name: device.name
        });

        if (Array.isArray(result?.progress)) {
            for (const step of result.progress) {
                const message = wifiProgressMessage(step?.step) || step?.message;
                if (message) window.showHubToast?.(message, "info", 2800);
            }
        }

        if (result?.success) {
            const targetDeviceId = result.deviceId || device.deviceId;
            const transportResult = await waitForTransportSwitch(targetDeviceId, enabled);

            if (transportResult.confirmed) {
                window.hideHubLoadingOverlay?.();
                window.showHubToast?.(
                    result.message || (enabled ? dt("devicePanel.wifiEnabled") : dt("devicePanel.wifiDisconnected")),
                    "success"
                );

                if (result.firstSetup && window.namesAPI?.openRenameDialog) {
                    await window.namesAPI.openRenameDialog({
                        kind: "device",
                        serial: result.deviceId,
                        name: device.name,
                        originalName: device.originalName || device.name
                    });
                }
                await window.refreshDevices?.();
                return;
            }

            window.showHubLoadingOverlayError?.(switchFailedMessage, 2800);
            window.showHubToast?.(switchFailedMessage, "error", 5500);
            if (toggleInput) toggleInput.checked = !enabled;
            await window.refreshDevices?.();
            return;
        }

        const message = wifiErrorMessage(result?.step) || result?.error || dt("devicePanel.wifiFailed");
        window.showHubLoadingOverlayError?.(message || switchFailedMessage, 2800);
        window.showHubToast?.(message, "error", 5500);
        if (toggleInput) toggleInput.checked = false;
        await window.refreshDevices?.();
    } catch (err) {
        window.showHubLoadingOverlayError?.(err.message || dt("devicePanel.wifiError"), 2800);
        window.showHubToast?.(err.message || dt("devicePanel.wifiError"), "error", 5500);
        if (toggleInput) toggleInput.checked = false;
    } finally {
        if (toggleInput) toggleInput.disabled = false;
    }
}

function renderDevicePanel(devices) {
    const container = document.getElementById("sidebar-devices-panel");
    if (!container) return;

    const connected = getConnectedOnly(devices);

    if (connected.length === 0) {
        container.innerHTML = `
            <div class="sidebar-devices-empty">${dt("sidebar.devicePanel.empty")}</div>
        `;
        return;
    }

    container.innerHTML = connected.map((device) => {
        const name = device.name || device.serial || dt("sidebar.devicePanel.deviceFallback");
        const originalName = device.originalName || name;
        const battery = formatBattery(device.battery);
        const transport = device.transportLabel || (
            device.transport === "wifi" ? dt("sidebar.devicePanel.wifiConnected") : dt("sidebar.devicePanel.usb")
        );
        const statusDot = device.status === "green" ? "online" : "offline";
        const colorStyle = device.deviceColor?.hex ? ` style="background:${device.deviceColor.hex}"` : "";
        const canToggleWifi = Boolean(
            device.usbSerial
            || device.wifiConfigured
            || (device.transport === "wifi" && device.connected !== false)
        );
        const wifiChecked = Boolean(
            device.wifiActive
            ?? (device.wifiEnabled && device.transport === "wifi" && device.connected !== false)
        );
        const showUsbBadge = device.usbAvailable && !(wifiChecked && device.transport === "wifi");
        const transportBadge = showUsbBadge && device.transport !== "wifi"
            ? `<span class="sidebar-device-stat transport-usb" title="${dt("sidebar.devicePanel.usb")}">${dt("sidebar.devicePanel.usb")}</span>`
            : `<span class="sidebar-device-stat transport-${transportClass(device)}" title="${dt("sidebar.devicePanel.transportAdb")}">${transport}</span>`;
        const audioOn = isDeviceAudioOn(device);
        const audioKey = deviceAudioKey(device);

        return `
            <div class="sidebar-device-card" data-device-id="${device.deviceId || ""}" data-serial="${device.serial || ""}" data-original-name="${originalName}" data-has-custom="${device.hasCustomName ? "1" : "0"}" title="${name}">
                <div class="sidebar-device-header">
                    <span class="sidebar-device-color device-color-pill"${colorStyle} aria-hidden="true"></span>
                    <span class="sidebar-device-status ${statusDot}"></span>
                    <span class="sidebar-device-name">${name}</span>
                    <div class="sidebar-device-actions">
                        <button type="button" class="sidebar-device-audio-btn ${audioOn ? "audio-on" : "audio-off"}" data-device-key="${audioKey}" title="${dt("sidebar.devicePanel.audioToggle")}" aria-label="${dt("sidebar.devicePanel.audioToggle")}">
                            ${audioOn ? AUDIO_ICON_ON : AUDIO_ICON_OFF}
                        </button>
                        ${canToggleWifi ? `
                        <label class="sidebar-wifi-toggle" title="${dt("sidebar.devicePanel.wifiToggle")}">
                            <input type="checkbox" class="sidebar-wifi-toggle-input" data-device-id="${device.deviceId || ""}" ${wifiChecked ? "checked" : ""}>
                            <span class="sidebar-wifi-toggle-ui"></span>
                        </label>` : ""}
                    </div>
                </div>
                <div class="sidebar-device-meta">
                    <span class="sidebar-device-stat battery-${batteryClass(device.battery)}" title="${dt("sidebar.devicePanel.battery")}">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="7" width="18" height="10" rx="2"/><rect x="20" y="10" width="2" height="4" rx="0.5"/></svg>
                        ${battery}
                    </span>
                    ${transportBadge}
                </div>
            </div>
        `;
    }).join("");

    container.querySelectorAll(".sidebar-device-card").forEach((card) => {
        const deviceId = card.dataset.deviceId;
        const serial = card.dataset.serial;
        if (!serial) return;

        const device = connected.find((d) => d.deviceId === deviceId || d.serial === serial);
        if (!device) return;

        const deviceName = card.querySelector(".sidebar-device-name")?.textContent?.trim() || serial;

        if (window.renameActions?.attachDeviceContextMenu) {
            window.renameActions.attachDeviceContextMenu(card, {
                serial: device.deviceId || serial,
                name: deviceName,
                originalName: card.dataset.originalName || serial,
                hasCustomName: card.dataset.hasCustom === "1",
                connected: true
            });
        }

        const audioBtn = card.querySelector(".sidebar-device-audio-btn");
        if (audioBtn) {
            audioBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                void handleDeviceAudioToggle(device, audioBtn);
            });
            audioBtn.addEventListener("dblclick", (event) => {
                event.stopPropagation();
            });
        }

        const toggleInput = card.querySelector(".sidebar-wifi-toggle-input");
        if (toggleInput) {
            toggleInput.addEventListener("change", () => {
                void handleWifiToggle(device, toggleInput.checked, toggleInput);
            });
        }

        card.addEventListener("dblclick", () => {
            const actions = window.__hubModalMainActions;
            if (!actions?.setSelectedDeviceForMirror || !actions?.onMirrorButtonClick) return;
            void (async () => {
                if (window.LaunchLatency?.markClick) {
                    const started = await window.LaunchLatency.markClick("A");
                    window.__pendingMirrorLatencyTraceId = started.traceId;
                }
                actions.setSelectedDeviceForMirror(serial, deviceName, device.deviceId);
                actions.onMirrorButtonClick();
            })();
        });
    });
}

async function handleDeviceAudioToggle(device, button) {
    const key = deviceAudioKey(device);
    if (!key || !window.audioAPI?.toggleDeviceMuted || button?.classList.contains("pending")) {
        return;
    }

    button.classList.add("pending");
    try {
        const result = await window.audioAPI.toggleDeviceMuted(key);
        if (result?.globalMuted !== undefined || result?.devices) {
            cachedAudioState = {
                globalMuted: Boolean(result.globalMuted),
                devices: result.devices || {}
            };
        }
        const on = isDeviceAudioOn(device);
        button.classList.toggle("audio-on", on);
        button.classList.toggle("audio-off", !on);
        button.innerHTML = on ? AUDIO_ICON_ON : AUDIO_ICON_OFF;
        if (typeof window.refreshGlobalAudioToggle === "function") {
            window.refreshGlobalAudioToggle();
        }
    } catch (err) {
        console.error("[DevicePanel] audio toggle:", err);
    } finally {
        button.classList.remove("pending");
    }
}

async function refreshCachedAudioState() {
    if (!window.audioAPI?.getGlobalState) return;
    try {
        const state = await window.audioAPI.getGlobalState();
        cachedAudioState = {
            globalMuted: Boolean(state?.globalMuted),
            devices: state?.devices || {}
        };
    } catch (err) {
        console.warn("[DevicePanel] audio state:", err);
    }
}

function initDevicePanel() {
    const container = document.getElementById("sidebar-devices-panel");
    if (!container) return;

    const refresh = () => {
        const devices = typeof window.getCurrentDevices === "function"
            ? window.getCurrentDevices()
            : [];
        renderDevicePanel(devices);
    };

    window.addEventListener("devices-refreshed", refresh);

    globalThis.HubI18n?.onChange?.(() => {
        refresh();
    });

    void refreshCachedAudioState().then(refresh);

    if (window.audioAPI?.onGlobalStateChanged) {
        window.audioAPI.onGlobalStateChanged((data) => {
            cachedAudioState = {
                globalMuted: Boolean(data?.globalMuted),
                devices: data?.devices || {}
            };
            refresh();
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDevicePanel);
} else {
    initDevicePanel();
}

window.renderDevicePanel = renderDevicePanel;
