/**
 * Panneau Appareils — historique USB et configurations WiFi.
 */
(function initDevicesPanel() {
    const PANEL_POLL_MS = 4000;
    let panelPollTimer = null;
    let panelListenersBound = false;
    let renderInFlight = false;
    let cleanupActionBound = false;
    let cleanupModalBound = false;
    let autoCleanPrefsBound = false;
    let cleanupPreviewCache = null;

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

    function getCleanupModalElements() {
        return {
            overlay: document.getElementById("cleanup-modal-overlay"),
            logsCheckbox: document.getElementById("cleanup-category-logs"),
            cacheCheckbox: document.getElementById("cleanup-category-cache"),
            historyCheckbox: document.getElementById("cleanup-category-history"),
            logsDetail: document.getElementById("cleanup-category-logs-detail"),
            cacheDetail: document.getElementById("cleanup-category-cache-detail"),
            historyDetail: document.getElementById("cleanup-category-history-detail"),
            selectAllBtn: document.getElementById("cleanup-select-all-btn"),
            deselectAllBtn: document.getElementById("cleanup-deselect-all-btn"),
            cancelBtn: document.getElementById("cleanup-modal-cancel-btn"),
            runBtn: document.getElementById("cleanup-modal-run-btn")
        };
    }

    function getSelectedCleanupCategories() {
        const els = getCleanupModalElements();
        return {
            logs: Boolean(els.logsCheckbox?.checked),
            cache: Boolean(els.cacheCheckbox?.checked),
            history: Boolean(els.historyCheckbox?.checked)
        };
    }

    function setCleanupCategoryChecks(checked) {
        const els = getCleanupModalElements();
        if (els.logsCheckbox) els.logsCheckbox.checked = checked;
        if (els.cacheCheckbox) els.cacheCheckbox.checked = checked;
        if (els.historyCheckbox) els.historyCheckbox.checked = checked;
    }

    function updateCleanupModalDetails(preview) {
        const els = getCleanupModalElements();
        const categoryPreview = preview?.summary?.categoryPreview || {};

        if (els.logsDetail) {
            els.logsDetail.textContent = categoryPreview.logs?.detail || "—";
        }
        if (els.cacheDetail) {
            els.cacheDetail.textContent = categoryPreview.cache?.detail || "—";
        }
        if (els.historyDetail) {
            els.historyDetail.textContent = categoryPreview.history?.detail || "—";
        }
    }

    function hasCleanupSelection(categories) {
        return Boolean(categories.logs || categories.cache || categories.history);
    }

    function hasCleanupWork(preview, categories) {
        const categoryResults = preview?.categoryResults || {};
        if (categories.logs && ((categoryResults.logs?.matchedFiles || 0) > 0 || (categoryResults.logs?.bytesEligible || 0) > 0)) {
            return true;
        }
        if (categories.cache && ((categoryResults.cache?.matchedFiles || 0) > 0 || (categoryResults.cache?.bytesEligible || 0) > 0)) {
            return true;
        }
        if (categories.history && (categoryResults.history?.entriesEligible || 0) > 0) {
            return true;
        }
        return false;
    }

    function openCleanupModal() {
        const els = getCleanupModalElements();
        if (!els.overlay) return;
        els.overlay.classList.remove("hidden");
    }

    function closeCleanupModal() {
        const els = getCleanupModalElements();
        if (!els.overlay) return;
        els.overlay.classList.add("hidden");
    }

    async function refreshCleanupPreview() {
        if (!window.maintenanceAPI?.previewCleanup) return null;
        const preview = await window.maintenanceAPI.previewCleanup({
            categories: { logs: true, cache: true, history: true }
        });
        if (preview?.success) {
            cleanupPreviewCache = preview;
            updateCleanupModalDetails(preview);
        }
        return preview;
    }

    async function onCleanupNow() {
        if (!window.maintenanceAPI?.previewCleanup || !window.maintenanceAPI?.runCleanup) {
            window.showHubToast?.("Maintenance indisponible", "error");
            return;
        }

        setCleanupCategoryChecks(true);
        const preview = await refreshCleanupPreview();
        if (!preview?.success) {
            window.showHubToast?.(preview?.error || "Prévisualisation impossible", "error");
            return;
        }

        openCleanupModal();
    }

    async function onCleanupModalRun() {
        const els = getCleanupModalElements();
        const categories = getSelectedCleanupCategories();
        if (!hasCleanupSelection(categories)) {
            window.showHubToast?.("Sélectionnez au moins une catégorie", "info");
            return;
        }

        const preview = cleanupPreviewCache?.success
            ? cleanupPreviewCache
            : await refreshCleanupPreview();
        if (!preview?.success) {
            window.showHubToast?.(preview?.error || "Prévisualisation impossible", "error");
            return;
        }

        if (!hasCleanupWork(preview, categories)) {
            window.showHubToast?.("Aucun élément à nettoyer pour la sélection", "info");
            return;
        }

        if (els.runBtn) els.runBtn.disabled = true;
        const result = await window.maintenanceAPI.runCleanup({
            reason: "manual-panel-devices",
            categories
        });
        if (els.runBtn) els.runBtn.disabled = false;

        closeCleanupModal();

        if (!result?.success) {
            window.showHubToast?.(result?.error || "Nettoyage impossible", "error");
            return;
        }

        const summary = result.summary?.message || "Nettoyage terminé";
        window.showHubToast?.(summary, "success");
    }

    function bindCleanupModal() {
        if (cleanupModalBound) return;
        cleanupModalBound = true;

        const els = getCleanupModalElements();
        if (!els.overlay) return;

        const onCategoryChange = () => {
            // Les détails par catégorie restent affichés pour toutes les cases.
        };

        els.logsCheckbox?.addEventListener("change", onCategoryChange);
        els.cacheCheckbox?.addEventListener("change", onCategoryChange);
        els.historyCheckbox?.addEventListener("change", onCategoryChange);

        els.selectAllBtn?.addEventListener("click", () => {
            setCleanupCategoryChecks(true);
        });

        els.deselectAllBtn?.addEventListener("click", () => {
            setCleanupCategoryChecks(false);
        });

        els.cancelBtn?.addEventListener("click", () => closeCleanupModal());
        els.runBtn?.addEventListener("click", () => {
            void onCleanupModalRun();
        });

        els.overlay.addEventListener("click", (event) => {
            if (event.target === els.overlay) {
                closeCleanupModal();
            }
        });
    }

    async function loadAutoCleanPreferences() {
        if (!window.maintenanceAPI?.getPreferences) return;

        const response = await window.maintenanceAPI.getPreferences();
        if (!response?.success) return;

        const autoClean = response.preferences?.autoClean || {};
        const logsToggle = document.getElementById("devices-auto-clean-logs");
        const cacheToggle = document.getElementById("devices-auto-clean-cache");
        const historyToggle = document.getElementById("devices-auto-clean-history");

        if (logsToggle) logsToggle.checked = autoClean.logs !== false;
        if (cacheToggle) cacheToggle.checked = autoClean.cache !== false;
        if (historyToggle) historyToggle.checked = autoClean.history !== false;
    }

    async function persistAutoCleanPreferences() {
        if (!window.maintenanceAPI?.setPreferences) return;

        const logsToggle = document.getElementById("devices-auto-clean-logs");
        const cacheToggle = document.getElementById("devices-auto-clean-cache");
        const historyToggle = document.getElementById("devices-auto-clean-history");

        await window.maintenanceAPI.setPreferences({
            preferences: {
                autoClean: {
                    logs: Boolean(logsToggle?.checked),
                    cache: Boolean(cacheToggle?.checked),
                    history: Boolean(historyToggle?.checked)
                }
            }
        });
    }

    function bindAutoCleanPreferences() {
        if (autoCleanPrefsBound) return;
        autoCleanPrefsBound = true;

        const toggles = [
            document.getElementById("devices-auto-clean-logs"),
            document.getElementById("devices-auto-clean-cache"),
            document.getElementById("devices-auto-clean-history")
        ];

        toggles.forEach((toggle) => {
            if (!toggle) return;
            toggle.addEventListener("change", () => {
                void persistAutoCleanPreferences();
            });
        });
    }

    function bindCleanupAction() {
        if (cleanupActionBound) return;
        cleanupActionBound = true;

        const cleanupBtn = document.getElementById("devices-cleanup-now-btn");
        if (!cleanupBtn) return;
        cleanupBtn.addEventListener("click", () => {
            void onCleanupNow();
        });

        bindCleanupModal();
        bindAutoCleanPreferences();
        void loadAutoCleanPreferences();
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
        bindCleanupAction();
        startDevicesPanelLiveRefresh();
    }

    window.openDevicesPanel = openDevicesPanel;
    window.stopDevicesPanelLiveRefresh = stopDevicesPanelLiveRefresh;
    window.refreshDevicesPanel = (options) => renderPanel(options || { silent: true });
})();
