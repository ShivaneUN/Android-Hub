/**
 * Panneau Appareils — historique USB et configurations WiFi.
 */
(function initDevicesPanel() {
    const PANEL_POLL_MS = 4000;
    let panelPollTimer = null;
    let panelListenersBound = false;
    let renderInFlight = false;

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function formatDate(iso) {
        if (!iso) return "—";
        try {
            return new Date(iso).toLocaleString("fr-FR", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit"
            });
        } catch (_err) {
            return iso;
        }
    }

    function colorPillMarkup(deviceColor) {
        const style = deviceColor?.hex ? ` style="background:${deviceColor.hex}"` : "";
        return `<span class="devices-panel-color device-color-pill"${style} aria-hidden="true"></span>`;
    }

    function isDevicesPanelActive() {
        const panel = document.getElementById("panel-devices");
        if (!panel) return false;
        return panel.classList.contains("active");
    }

    async function syncAfterPanelAction() {
        await window.refreshDevices?.();
        await renderPanel({ silent: true });
    }

    function bindRowActions(container) {
        container.querySelectorAll("[data-action]").forEach((btn) => {
            btn.addEventListener("click", () => void handlePanelAction(btn));
        });
    }

    function renderDeviceRow(entry, { section, subLine }) {
        const deviceId = entry.deviceId || entry.serial;
        const reconnectBtn = section === "wifi"
            ? `<button type="button" class="devices-panel-btn" data-action="reconnect" data-device-id="${escapeHtml(deviceId)}" title="Reconnecter">Reconnecter</button>`
            : "";

        const statusClass = section === "wifi"
            ? (entry.adbState === "connected" ? "online" : "offline")
            : (entry.connected ? "online" : "offline");

        return `
            <div class="devices-panel-row" data-device-id="${escapeHtml(deviceId)}" data-section="${section}">
                ${colorPillMarkup(entry.deviceColor)}
                <div class="devices-panel-main">
                    <div class="devices-panel-name">${escapeHtml(entry.name)}</div>
                    <div class="devices-panel-sub">${escapeHtml(subLine)} · ${formatDate(entry.lastSeen)}</div>
                </div>
                <span class="devices-panel-status ${statusClass}">${escapeHtml(entry.statusLabel)}</span>
                <div class="devices-panel-actions">
                    <button type="button" class="devices-panel-btn" data-action="rename" data-device-id="${escapeHtml(deviceId)}" data-original-name="${escapeHtml(entry.originalName || entry.name)}" title="Renommer">Renommer</button>
                    ${reconnectBtn}
                    <button type="button" class="devices-panel-btn danger" data-action="remove" data-device-id="${escapeHtml(deviceId)}" data-section="${section}" title="Supprimer">Supprimer</button>
                </div>
            </div>
        `;
    }

    async function renderPanel(options = {}) {
        const { silent = false } = options;
        const usbList = document.getElementById("devices-panel-usb-list");
        const wifiList = document.getElementById("devices-panel-wifi-list");
        if (!usbList || !wifiList) return;
        if (renderInFlight) return;

        renderInFlight = true;
        try {
            if (!silent) {
                usbList.innerHTML = '<p class="apps-loading">Chargement...</p>';
                wifiList.innerHTML = '<p class="apps-loading">Chargement...</p>';
            }

            const response = await window.wifiAPI?.getPanelData?.();
            if (!response?.success) {
                if (!silent) {
                    usbList.innerHTML = '<p class="apps-loading">Erreur de chargement</p>';
                    wifiList.innerHTML = '<p class="apps-loading">Erreur de chargement</p>';
                }
                return;
            }

            const usb = Array.isArray(response.usb) ? response.usb : [];
            const wifi = Array.isArray(response.wifi) ? response.wifi : [];

            if (!usb.length) {
                usbList.innerHTML = '<p class="apps-loading">Aucun appareil USB enregistré</p>';
            } else {
                usbList.innerHTML = usb.map((entry) => renderDeviceRow(entry, {
                    section: "usb",
                    subLine: entry.serial || entry.usbSerial || entry.deviceId
                })).join("");
                bindRowActions(usbList);
            }

            if (!wifi.length) {
                wifiList.innerHTML = '<p class="apps-loading">Aucun appareil WiFi configuré</p>';
            } else {
                wifiList.innerHTML = wifi.map((entry) => renderDeviceRow(entry, {
                    section: "wifi",
                    subLine: entry.adbTarget || `${entry.ip}:${entry.port || 5555}`
                })).join("");
                bindRowActions(wifiList);
            }
        } finally {
            renderInFlight = false;
        }
    }

    function openDeviceRenameDialog(deviceId, currentName, originalName) {
        if (!deviceId || !window.namesAPI?.openRenameDialog) {
            window.showHubToast?.("Renommage indisponible", "error");
            return;
        }

        void window.namesAPI.openRenameDialog({
            kind: "device",
            serial: deviceId,
            currentName: currentName || deviceId,
            originalName: originalName || currentName || deviceId
        });
    }

    async function handlePanelAction(btn) {
        const action = btn.dataset.action;
        const deviceId = btn.dataset.deviceId;
        if (!deviceId || !window.wifiAPI) return;

        if (action === "rename") {
            const currentName = btn.closest(".devices-panel-row")?.querySelector(".devices-panel-name")?.textContent?.trim();
            const originalName = btn.dataset.originalName || currentName;
            openDeviceRenameDialog(deviceId, currentName, originalName);
            return;
        }

        if (action === "reconnect") {
            btn.disabled = true;
            const result = await window.wifiAPI.reconnect({ deviceId });
            btn.disabled = false;
            if (result?.success) {
                window.showHubToast?.(result.message || "Reconnecté en WiFi", "success");
            } else {
                window.showHubToast?.(result?.error || "Reconnexion impossible", "error");
            }
            await syncAfterPanelAction();
            return;
        }

        if (action === "remove") {
            const section = btn.dataset.section || "wifi";
            const message = section === "wifi"
                ? "Supprimer définitivement la configuration WiFi de cet appareil ?"
                : "Retirer cet appareil de l'historique USB ? La configuration WiFi associée sera aussi supprimée.";
            if (!window.confirm(message)) return;

            const result = await window.wifiAPI.removeFromPanel({ deviceId });
            if (result?.success) {
                window.showHubToast?.(
                    section === "wifi" ? "Configuration WiFi supprimée" : "Appareil retiré de l'historique",
                    "success"
                );
                await syncAfterPanelAction();
            } else {
                window.showHubToast?.(result?.error || "Suppression impossible", "error");
            }
        }
    }

    function onPanelRefreshEvent() {
        if (!isDevicesPanelActive()) return;
        void renderPanel({ silent: true });
    }

    function bindPanelRefreshListeners() {
        if (panelListenersBound) return;
        panelListenersBound = true;

        window.addEventListener("devices-refreshed", onPanelRefreshEvent);

        if (window.electronAPI?.onDevicesRefreshRequest) {
            window.electronAPI.onDevicesRefreshRequest(onPanelRefreshEvent);
        }

        if (window.namesAPI?.onUpdated) {
            window.namesAPI.onUpdated(() => {
                void syncAfterPanelAction();
            });
        }

        if (window.deviceColorsAPI?.onUpdated) {
            window.deviceColorsAPI.onUpdated(() => {
                if (isDevicesPanelActive()) {
                    void renderPanel({ silent: true });
                }
            });
        }
    }

    function startDevicesPanelLiveRefresh() {
        stopDevicesPanelLiveRefresh();
        bindPanelRefreshListeners();
        panelPollTimer = setInterval(() => {
            if (isDevicesPanelActive()) {
                void renderPanel({ silent: true });
            }
        }, PANEL_POLL_MS);
    }

    function stopDevicesPanelLiveRefresh() {
        if (panelPollTimer) {
            clearInterval(panelPollTimer);
            panelPollTimer = null;
        }
    }

    async function openDevicesPanel(options = {}) {
        if (!options.inChildWindow && !/hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"))) {
            if (window.hubModalAPI) {
                await window.hubModalAPI.open({ panel: "devices" });
            }
            document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
            document.getElementById("nav-devices")?.classList.add("active");
            return;
        }

        await renderPanel();
        startDevicesPanelLiveRefresh();
    }

    window.openDevicesPanel = openDevicesPanel;
    window.stopDevicesPanelLiveRefresh = stopDevicesPanelLiveRefresh;
    window.refreshDevicesPanel = (options) => renderPanel(options || { silent: true });
})();
