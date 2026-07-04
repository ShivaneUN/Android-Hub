/**
 * Panneau sidebar : liste des appareils connectés (nom, batterie, WiFi).
 * Données dédupliquées par serial, mises à jour via devices-refreshed.
 */

function dedupeConnectedDevices(devices) {
    const bySerial = new Map();

    for (const device of devices) {
        if (!device?.connected) continue;

        const key = device.serial || device.name;
        if (!key) continue;

        const existing = bySerial.get(key);
        if (!existing || (device.status === "green" && existing.status !== "green")) {
            bySerial.set(key, device);
        }
    }

    return Array.from(bySerial.values());
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

function wifiClass(wifiStatus) {
    if (!wifiStatus) return "unknown";
    const normalized = wifiStatus.toLowerCase();
    if (normalized.includes("connect")) return "connected";
    if (normalized.includes("activ")) return "enabled";
    if (normalized.includes("désactiv") || normalized.includes("desactiv")) return "disabled";
    return "unknown";
}

function renderDevicePanel(devices) {
    const container = document.getElementById("sidebar-devices-panel");
    if (!container) return;

    const connected = dedupeConnectedDevices(devices);

    if (connected.length === 0) {
        container.innerHTML = `
            <div class="sidebar-devices-empty">Aucun appareil connecté</div>
        `;
        return;
    }

    container.innerHTML = connected.map((device) => {
        const name = device.name || device.serial || "Appareil";
        const originalName = device.originalName || name;
        const battery = formatBattery(device.battery);
        const wifi = device.wifiStatus || "Inconnu";
        const statusDot = device.status === "green" ? "online" : "offline";
        const colorStyle = device.deviceColor?.hex ? ` style="background:${device.deviceColor.hex}"` : "";

        return `
            <div class="sidebar-device-card" data-serial="${device.serial || ""}" data-original-name="${originalName}" data-has-custom="${device.hasCustomName ? "1" : "0"}" title="${name}">
                <div class="sidebar-device-header">
                    <span class="sidebar-device-color device-color-pill"${colorStyle} aria-hidden="true"></span>
                    <span class="sidebar-device-status ${statusDot}"></span>
                    <span class="sidebar-device-name">${name}</span>
                </div>
                <div class="sidebar-device-meta">
                    <span class="sidebar-device-stat battery-${batteryClass(device.battery)}" title="Batterie">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="7" width="18" height="10" rx="2"/><rect x="20" y="10" width="2" height="4" rx="0.5"/></svg>
                        ${battery}
                    </span>
                    <span class="sidebar-device-stat wifi-${wifiClass(wifi)}" title="WiFi">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5 12.5a11 11 0 0 1 14 0"/><path d="M8.5 16a6 6 0 0 1 7 0"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/></svg>
                        ${wifi}
                    </span>
                </div>
            </div>
        `;
    }).join("");

    container.querySelectorAll(".sidebar-device-card").forEach((card) => {
        const serial = card.dataset.serial;
        if (!serial) return;

        const deviceName = card.querySelector(".sidebar-device-name")?.textContent?.trim() || serial;

        if (window.renameActions?.attachDeviceContextMenu) {
            window.renameActions.attachDeviceContextMenu(card, {
                serial,
                name: deviceName,
                originalName: card.dataset.originalName || serial,
                hasCustomName: card.dataset.hasCustom === "1",
                connected: true
            });
        }

        card.addEventListener("dblclick", () => {
            const actions = window.__hubModalMainActions;
            if (!actions?.setSelectedDeviceForMirror || !actions?.onMirrorButtonClick) return;
            actions.setSelectedDeviceForMirror(serial, deviceName);
            actions.onMirrorButtonClick();
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
    refresh();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDevicePanel);
} else {
    initDevicePanel();
}

window.renderDevicePanel = renderDevicePanel;
