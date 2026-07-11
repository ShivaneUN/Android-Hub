/**
 * Panneau sidebar : liste unifiée des appareils (USB / WiFi fusionnés).
 */
const dt = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

const WIFI_ERROR_STEPS = ["tcpip", "ip", "connect"];

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

        return `
            <div class="sidebar-device-card" data-device-id="${device.deviceId || ""}" data-serial="${device.serial || ""}" data-original-name="${originalName}" data-has-custom="${device.hasCustomName ? "1" : "0"}" title="${name}">
                <div class="sidebar-device-header">
                    <span class="sidebar-device-color device-color-pill"${colorStyle} aria-hidden="true"></span>
                    <span class="sidebar-device-status ${statusDot}"></span>
                    <span class="sidebar-device-name">${name}</span>
                    ${canToggleWifi ? `
                    <label class="sidebar-wifi-toggle" title="${dt("sidebar.devicePanel.wifiToggle")}">
                        <input type="checkbox" class="sidebar-wifi-toggle-input" data-device-id="${device.deviceId || ""}" ${wifiChecked ? "checked" : ""}>
                        <span class="sidebar-wifi-toggle-ui"></span>
                    </label>` : ""}
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

    refresh();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDevicePanel);
} else {
    initDevicePanel();
}

window.renderDevicePanel = renderDevicePanel;
