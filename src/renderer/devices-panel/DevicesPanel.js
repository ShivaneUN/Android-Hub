/**
 * Panneau Appareils — historique USB et configurations WiFi.
 */
(function initDevicesPanel() {
    const PANEL_ID = "panel-devices";

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

    async function renderPanel() {
        const usbList = document.getElementById("devices-panel-usb-list");
        const wifiList = document.getElementById("devices-panel-wifi-list");
        if (!usbList || !wifiList) return;

        usbList.innerHTML = '<p class="apps-loading">Chargement...</p>';
        wifiList.innerHTML = '<p class="apps-loading">Chargement...</p>';

        const response = await window.wifiAPI?.getPanelData?.();
        if (!response?.success) {
            usbList.innerHTML = '<p class="apps-loading">Erreur de chargement</p>';
            wifiList.innerHTML = '<p class="apps-loading">Erreur de chargement</p>';
            return;
        }

        const usb = Array.isArray(response.usb) ? response.usb : [];
        const wifi = Array.isArray(response.wifi) ? response.wifi : [];

        if (!usb.length) {
            usbList.innerHTML = '<p class="apps-loading">Aucun appareil USB enregistré</p>';
        } else {
            usbList.innerHTML = usb.map((entry) => `
                <div class="devices-panel-row">
                    <div class="devices-panel-main">
                        <div class="devices-panel-name">${escapeHtml(entry.name)}</div>
                        <div class="devices-panel-sub">${escapeHtml(entry.serial)} · ${formatDate(entry.lastSeen)}</div>
                    </div>
                    <span class="devices-panel-status ${entry.connected ? "online" : "offline"}">${escapeHtml(entry.statusLabel)}</span>
                </div>
            `).join("");
        }

        if (!wifi.length) {
            wifiList.innerHTML = '<p class="apps-loading">Aucun appareil WiFi configuré</p>';
        } else {
            wifiList.innerHTML = wifi.map((entry) => `
                <div class="devices-panel-row" data-device-id="${escapeHtml(entry.deviceId)}">
                    <div class="devices-panel-main">
                        <div class="devices-panel-name">${escapeHtml(entry.name)}</div>
                        <div class="devices-panel-sub">${escapeHtml(entry.adbTarget || `${entry.ip}:${entry.port || 5555}`)} · ${formatDate(entry.lastSeen)}</div>
                    </div>
                    <span class="devices-panel-status ${entry.adbState === "connected" ? "online" : "offline"}">${escapeHtml(entry.statusLabel)}</span>
                    <div class="devices-panel-actions">
                        <button type="button" class="devices-panel-btn" data-action="rename" data-device-id="${escapeHtml(entry.deviceId)}" title="Renommer">Renommer</button>
                        <button type="button" class="devices-panel-btn" data-action="reconnect" data-device-id="${escapeHtml(entry.deviceId)}" title="Reconnecter">Reconnecter</button>
                        <button type="button" class="devices-panel-btn danger" data-action="remove" data-device-id="${escapeHtml(entry.deviceId)}" title="Supprimer">Supprimer</button>
                    </div>
                </div>
            `).join("");

            wifiList.querySelectorAll("[data-action]").forEach((btn) => {
                btn.addEventListener("click", () => void handleWifiAction(btn));
            });
        }
    }

    async function handleWifiAction(btn) {
        const action = btn.dataset.action;
        const deviceId = btn.dataset.deviceId;
        if (!deviceId || !window.wifiAPI) return;

        if (action === "rename") {
            const currentName = btn.closest(".devices-panel-row")?.querySelector(".devices-panel-name")?.textContent?.trim();
            const newName = window.prompt("Nom de l'appareil", currentName || "");
            if (!newName?.trim()) return;
            const result = await window.wifiAPI.rename({ deviceId, name: newName.trim() });
            if (result?.success) {
                window.showHubToast?.("Appareil renommé", "success");
                await renderPanel();
                await window.refreshDevices?.();
            } else {
                window.showHubToast?.(result?.error || "Erreur renommage", "error");
            }
            return;
        }

        if (action === "reconnect") {
            btn.disabled = true;
            const result = await window.wifiAPI.reconnect({ deviceId });
            btn.disabled = false;
            if (result?.success) {
                window.showHubToast?.("Reconnecté en WiFi", "success");
            } else {
                window.showHubToast?.(result?.error || "Reconnexion impossible", "error");
            }
            await renderPanel();
            await window.refreshDevices?.();
            return;
        }

        if (action === "remove") {
            const ok = window.confirm("Supprimer définitivement la configuration WiFi de cet appareil ?");
            if (!ok) return;
            const result = await window.wifiAPI.remove({ deviceId });
            if (result?.success) {
                window.showHubToast?.("Configuration WiFi supprimée", "success");
                await renderPanel();
                await window.refreshDevices?.();
            } else {
                window.showHubToast?.(result?.error || "Suppression impossible", "error");
            }
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
    }

    window.openDevicesPanel = openDevicesPanel;
})();
