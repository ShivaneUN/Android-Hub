/**
 * Panneau Appareils — historique USB et configurations WiFi.
 */
(function initDevicesPanel() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    let panelPollTimer = null;
    let panelListenersBound = false;
    let renderInFlight = false;
    let cleanupActionBound = false;
    let cleanupModalBound = false;
    let autoCleanPrefsBound = false;
    let cleanupPreviewCache = null;
    let discoverInFlight = false;

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

    function isDevicesTabActive() {
        if (!window.isSettingsPanelActive?.()) return false;
        return window.getCurrentSettingsTab?.() === "devices";
    }

    function isDevicesPanelActive() {
        return isDevicesTabActive();
    }

    async function syncAfterPanelAction() {
        await window.refreshDevices?.();
        await renderPanel({ silent: true });
    }

    function setDiscoverStatus(message) {
        const status = document.getElementById("devices-discover-status");
        if (status) status.textContent = message || "";
    }

    async function onDiscoverDevices() {
        if (discoverInFlight) return;

        const btn = document.getElementById("devices-discover-btn");
        if (!window.wifiAPI?.discoverDevices) {
            window.showHubToast?.(t("devicesPanel.discoverFailed"), "error");
            return;
        }

        discoverInFlight = true;
        const previousLabel = btn?.textContent || t("devicesPanel.discoverDevices");
        if (btn) {
            btn.disabled = true;
            btn.textContent = t("devicesPanel.discoverSearching");
        }
        setDiscoverStatus(t("devicesPanel.discoverSearching"));

        try {
            const result = await window.wifiAPI.discoverDevices();
            if (!result?.success) {
                throw new Error(result?.error || t("devicesPanel.discoverFailed"));
            }

            await window.refreshDevices?.();
            await renderPanel({ silent: true });

            const connected = Number(result.connectedCount) || 0;
            const newCount = Number(result.newCount) || 0;

            if (newCount > 0) {
                const names = (result.newDevices || [])
                    .map((device) => device.name || device.deviceId)
                    .filter(Boolean)
                    .join(", ");
                const message = names
                    ? t("devicesPanel.discoverFoundNewNamed", { count: newCount, names })
                    : t("devicesPanel.discoverFoundNew", { count: newCount });
                setDiscoverStatus(message);
                window.showHubToast?.(message, "success", 4500);
            } else if (connected > 0) {
                const message = t("devicesPanel.discoverNoNew", { connected });
                setDiscoverStatus(message);
                window.showHubToast?.(message, "info", 3500);
            } else {
                const message = t("devicesPanel.discoverNone");
                setDiscoverStatus(message);
                window.showHubToast?.(message, "info", 4000);
            }
        } catch (err) {
            const message = err.message || t("devicesPanel.discoverFailed");
            setDiscoverStatus(message);
            window.showHubToast?.(message, "error", 4500);
        } finally {
            discoverInFlight = false;
            if (btn) {
                btn.disabled = false;
                btn.textContent = previousLabel;
            }
        }
    }

    function bindDiscoverSection() {
        const btn = document.getElementById("devices-discover-btn");
        if (!btn || btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", () => void onDiscoverDevices());
    }

    function bindRowActions(container) {
        container.querySelectorAll("[data-action]").forEach((btn) => {
            btn.addEventListener("click", () => void handlePanelAction(btn));
        });
    }

    function getCleanupModalElements() {
        return {
            overlay: document.getElementById("cleanup-modal-overlay"),
            cacheCheckbox: document.getElementById("cleanup-category-cache"),
            historyCheckbox: document.getElementById("cleanup-category-history"),
            cacheDetail: document.getElementById("cleanup-category-cache-detail"),
            historyDetail: document.getElementById("cleanup-category-history-detail"),
            selectAllBtn: document.getElementById("cleanup-select-all-btn"),
            deselectAllBtn: document.getElementById("cleanup-deselect-all-btn"),
            cancelBtn: document.getElementById("cleanup-modal-cancel-btn"),
            runBtn: document.getElementById("cleanup-modal-run-btn")
        };
    }

    function getSelectedCleanupCategories() {
        const cacheCheckbox = document.getElementById("devices-manual-clean-cache")
            || document.getElementById("cleanup-category-cache");
        const historyCheckbox = document.getElementById("devices-manual-clean-history")
            || document.getElementById("cleanup-category-history");
        return {
            cache: Boolean(cacheCheckbox?.checked),
            history: Boolean(historyCheckbox?.checked)
        };
    }

    function setCleanupCategoryChecks(checked) {
        const targets = [
            document.getElementById("devices-manual-clean-cache"),
            document.getElementById("devices-manual-clean-history"),
            document.getElementById("cleanup-category-cache"),
            document.getElementById("cleanup-category-history")
        ];
        targets.forEach((el) => {
            if (el) el.checked = checked;
        });
    }

    function updateCleanupModalDetails(preview) {
        const els = getCleanupModalElements();
        const categoryPreview = preview?.summary?.categoryPreview || {};

        if (els.cacheDetail) {
            els.cacheDetail.textContent = categoryPreview.cache?.detail || "—";
        }
        if (els.historyDetail) {
            els.historyDetail.textContent = categoryPreview.history?.detail || "—";
        }

        const maintCache = document.getElementById("settings-maint-cache-detail");
        const maintHistory = document.getElementById("settings-maint-history-detail");
        const manualCache = document.getElementById("devices-manual-clean-cache-detail");
        const manualHistory = document.getElementById("devices-manual-clean-history-detail");
        if (maintCache) maintCache.textContent = categoryPreview.cache?.detail || "—";
        if (maintHistory) maintHistory.textContent = categoryPreview.history?.detail || "—";
        if (manualCache) manualCache.textContent = categoryPreview.cache?.detail || "—";
        if (manualHistory) manualHistory.textContent = categoryPreview.history?.detail || "—";
    }

    function hasCleanupSelection(categories) {
        return Boolean(categories.cache || categories.history);
    }

    function hasCleanupWork(preview, categories) {
        const categoryResults = preview?.categoryResults || {};
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
            categories: { cache: true, history: true }
        });
        if (preview?.success) {
            cleanupPreviewCache = preview;
            updateCleanupModalDetails(preview);
        }
        return preview;
    }

    async function onClearHistoryNow() {
        if (!window.maintenanceAPI?.previewCleanup || !window.maintenanceAPI?.runCleanup) {
            window.showHubToast?.(t("devicesPanel.maintenanceUnavailable"), "error");
            return;
        }

        const preview = await window.maintenanceAPI.previewCleanup({
            categories: { cache: false, history: true }
        });
        if (!preview?.success) {
            window.showHubToast?.(preview?.error || t("devicesPanel.previewFailed"), "error");
            return;
        }

        const eligible = preview.categoryResults?.history?.entriesEligible || 0;
        if (eligible <= 0) {
            window.showHubToast?.(t("devicesPanel.nothingToClean"), "info");
            await refreshCleanupPreview();
            return;
        }

        const result = await window.maintenanceAPI.runCleanup({
            reason: "manual-clear-history",
            categories: { cache: false, history: true }
        });
        if (!result?.success) {
            window.showHubToast?.(result?.error || t("devicesPanel.cleanupFailed"), "error");
            return;
        }

        window.showHubToast?.(result.summary?.message || t("devicesPanel.cleanupDone"), "success");
        await refreshCleanupPreview();
    }

    async function onCleanupNow() {
        if (!window.maintenanceAPI?.previewCleanup || !window.maintenanceAPI?.runCleanup) {
            window.showHubToast?.(t("devicesPanel.maintenanceUnavailable"), "error");
            return;
        }

        const categories = getSelectedCleanupCategories();
        if (!hasCleanupSelection(categories)) {
            window.showHubToast?.(t("devicesPanel.selectCategory"), "info");
            return;
        }

        const preview = await refreshCleanupPreview();
        if (!preview?.success) {
            window.showHubToast?.(preview?.error || t("devicesPanel.previewFailed"), "error");
            return;
        }

        if (!hasCleanupWork(preview, categories)) {
            window.showHubToast?.(t("devicesPanel.nothingToClean"), "info");
            return;
        }

        const cleanupBtn = document.getElementById("devices-cleanup-now-btn");
        if (cleanupBtn) cleanupBtn.disabled = true;
        const result = await window.maintenanceAPI.runCleanup({
            reason: "manual-panel-devices",
            categories
        });
        if (cleanupBtn) cleanupBtn.disabled = false;

        if (!result?.success) {
            window.showHubToast?.(result?.error || t("devicesPanel.cleanupFailed"), "error");
            await refreshCleanupPreview();
            return;
        }

        window.showHubToast?.(result.summary?.message || t("devicesPanel.cleanupDone"), "success");
        await refreshCleanupPreview();
    }

    async function onCleanupModalRun() {
        const els = getCleanupModalElements();
        const categories = getSelectedCleanupCategories();
        if (!hasCleanupSelection(categories)) {
            window.showHubToast?.(t("devicesPanel.selectCategory"), "info");
            return;
        }

        const preview = cleanupPreviewCache?.success
            ? cleanupPreviewCache
            : await refreshCleanupPreview();
        if (!preview?.success) {
            window.showHubToast?.(preview?.error || t("devicesPanel.previewFailed"), "error");
            return;
        }

        if (!hasCleanupWork(preview, categories)) {
            window.showHubToast?.(t("devicesPanel.nothingToClean"), "info");
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
            window.showHubToast?.(result?.error || t("devicesPanel.cleanupFailed"), "error");
            await refreshCleanupPreview();
            return;
        }

        const summary = result.summary?.message || t("devicesPanel.cleanupDone");
        window.showHubToast?.(summary, "success");
        await refreshCleanupPreview();
    }

    function bindCleanupModal() {
        if (cleanupModalBound) return;
        cleanupModalBound = true;

        const els = getCleanupModalElements();
        if (!els.overlay) return;

        const onCategoryChange = () => {
            // Les détails par catégorie restent affichés pour toutes les cases.
        };

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

    function syncAutoCleanCategoryControls(enabled) {
        const cacheToggle = document.getElementById("devices-auto-clean-cache");
        const historyToggle = document.getElementById("devices-auto-clean-history");
        const cacheLabel = document.getElementById("devices-auto-clean-cache-label");
        const historyLabel = document.getElementById("devices-auto-clean-history-label");

        if (cacheToggle) cacheToggle.disabled = !enabled;
        if (historyToggle) historyToggle.disabled = !enabled;
        cacheLabel?.classList.toggle("is-disabled", !enabled);
        historyLabel?.classList.toggle("is-disabled", !enabled);
    }

    async function loadAutoCleanPreferences() {
        if (!window.maintenanceAPI?.getPreferences) return;

        const response = await window.maintenanceAPI.getPreferences();
        if (!response?.success) return;

        const autoClean = response.preferences?.autoClean || {};
        const enabledToggle = document.getElementById("devices-auto-clean-enabled");
        const cacheToggle = document.getElementById("devices-auto-clean-cache");
        const historyToggle = document.getElementById("devices-auto-clean-history");
        const enabled = autoClean.enabled !== false;

        if (enabledToggle) enabledToggle.checked = enabled;
        if (cacheToggle) cacheToggle.checked = autoClean.cache !== false;
        if (historyToggle) historyToggle.checked = autoClean.history !== false;
        syncAutoCleanCategoryControls(enabled);
    }

    async function persistAutoCleanPreferences() {
        if (!window.maintenanceAPI?.setPreferences) return;

        const enabledToggle = document.getElementById("devices-auto-clean-enabled");
        const cacheToggle = document.getElementById("devices-auto-clean-cache");
        const historyToggle = document.getElementById("devices-auto-clean-history");
        const enabled = Boolean(enabledToggle?.checked);

        syncAutoCleanCategoryControls(enabled);

        await window.maintenanceAPI.setPreferences({
            preferences: {
                autoClean: {
                    enabled,
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
            document.getElementById("devices-auto-clean-enabled"),
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

    function applyMaintenanceHintLabels() {
        const days = 7;
        const hint = document.querySelector(".devices-maintenance-hint");
        if (hint) hint.textContent = t("devicesPanel.maintenanceHint", { days });
        const modalHint = document.querySelector(".cleanup-modal-hint");
        if (modalHint) modalHint.textContent = t("maintenance.hint", { days });
        const enabledLabel = document.querySelector("#devices-auto-clean-enabled + span");
        if (enabledLabel) {
            enabledLabel.textContent = t("devicesPanel.autoCleanupEnabled", { days });
        }
        const footerHint = document.querySelector(".maint-footer-hint");
        if (footerHint) footerHint.textContent = t("settingsPanel.maintKeepHint", { days });
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
        applyMaintenanceHintLabels();
        void loadAutoCleanPreferences();
        void refreshCleanupPreview();

        const optionsToggle = document.getElementById("devices-maint-options-toggle");
        const autoPanel = document.getElementById("devices-maintenance-auto-panel");
        if (optionsToggle && autoPanel && !optionsToggle.dataset.bound) {
            optionsToggle.dataset.bound = "1";
            optionsToggle.addEventListener("click", () => {
                const open = !autoPanel.classList.contains("is-open");
                autoPanel.classList.toggle("is-open", open);
                if (open) autoPanel.removeAttribute("hidden");
                else autoPanel.setAttribute("hidden", "");
            });
        }

        const historyHintBtn = document.getElementById("devices-cleanup-history-hint");
        if (historyHintBtn && !historyHintBtn.dataset.bound) {
            historyHintBtn.dataset.bound = "1";
            historyHintBtn.disabled = false;
            historyHintBtn.addEventListener("click", () => {
                void onClearHistoryNow();
            });
        }
    }

    function renderDeviceRow(entry, { section, subLine }) {
        const deviceId = entry.deviceId || entry.serial;
        const reconnectBtn = section === "wifi"
            ? `<button type="button" class="devices-panel-btn" data-action="reconnect" data-device-id="${escapeHtml(deviceId)}" title="${t("devicesPanel.reconnect")}">${t("devicesPanel.reconnect")}</button><span class="devices-panel-action-sep" aria-hidden="true"></span>`
            : "";

        const isOnline = section === "wifi"
            ? entry.adbState === "connected"
            : Boolean(entry.connected);
        const statusClass = isOnline ? "online" : "offline";
        const statusBadge = isOnline ? t("devicesPanel.connectedBadge") : t("devicesPanel.offlineBadge");
        const liveLabel = isOnline ? t("devicesPanel.online") : t("devicesPanel.offline");
        const transport = section === "wifi" ? t("devicesPanel.wifi") : t("devicesPanel.usb");
        const icon = section === "wifi"
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12.5a9 9 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 7h6M9 17h6"/></svg>`;

        return `
            <div class="devices-panel-row ${statusClass}" data-device-id="${escapeHtml(deviceId)}" data-section="${section}">
                <div class="devices-panel-icon" aria-hidden="true">${icon}</div>
                <div class="devices-panel-main">
                    <div class="devices-panel-name">${escapeHtml(entry.name)}</div>
                    <div class="devices-panel-sub">${escapeHtml(subLine)} • ${escapeHtml(transport)}</div>
                    <div class="devices-panel-live"><span class="devices-panel-dot"></span>${escapeHtml(liveLabel)}</div>
                </div>
                <div class="devices-panel-side">
                    <span class="devices-panel-status ${statusClass}">${escapeHtml(statusBadge)}</span>
                    <div class="devices-panel-actions">
                        <button type="button" class="devices-panel-btn" data-action="rename" data-device-id="${escapeHtml(deviceId)}" data-original-name="${escapeHtml(entry.originalName || entry.name)}" title="${t("devicesPanel.rename")}">${t("devicesPanel.rename")}</button>
                        <span class="devices-panel-action-sep" aria-hidden="true"></span>
                        ${reconnectBtn}
                        <button type="button" class="devices-panel-btn danger" data-action="remove" data-device-id="${escapeHtml(deviceId)}" data-section="${section}" title="${t("devicesPanel.remove")}">${t("devicesPanel.remove")}</button>
                    </div>
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
                usbList.innerHTML = `<p class="apps-loading">${t("devicesPanel.loading")}</p>`;
                wifiList.innerHTML = `<p class="apps-loading">${t("devicesPanel.loading")}</p>`;
            }

            const response = await window.wifiAPI?.getPanelData?.();
            if (!response?.success) {
                if (!silent) {
                    usbList.innerHTML = `<p class="apps-loading">${t("devicesPanel.loadError")}</p>`;
                    wifiList.innerHTML = `<p class="apps-loading">${t("devicesPanel.loadError")}</p>`;
                }
                return;
            }

            const usb = Array.isArray(response.usb) ? response.usb : [];
            const wifi = Array.isArray(response.wifi) ? response.wifi : [];

            if (!usb.length) {
                usbList.innerHTML = `<p class="apps-loading">${t("devicesPanel.noUsb")}</p>`;
            } else {
                usbList.innerHTML = usb.map((entry) => renderDeviceRow(entry, {
                    section: "usb",
                    subLine: entry.serial || entry.usbSerial || entry.deviceId
                })).join("");
                bindRowActions(usbList);
            }

            if (!wifi.length) {
                wifiList.innerHTML = `<p class="apps-loading">${t("devicesPanel.noWifi")}</p>`;
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
                window.showHubToast?.(result.message || t("devicesPanel.toastReconnected"), "success");
            } else {
                window.showHubToast?.(result?.error || t("devicesPanel.toastReconnectFailed"), "error");
            }
            await syncAfterPanelAction();
            return;
        }

        if (action === "remove") {
            const section = btn.dataset.section || "wifi";
            const message = section === "wifi"
                ? t("devicesPanel.confirmRemoveWifi")
                : t("devicesPanel.confirmRemoveUsb");
            if (!window.confirm(message)) return;

            const result = await window.wifiAPI.removeFromPanel({ deviceId });
            if (result?.success) {
                window.showHubToast?.(
                    section === "wifi" ? t("devicesPanel.toastWifiRemoved") : t("devicesPanel.toastUsbRemoved"),
                    "success"
                );
                await syncAfterPanelAction();
            } else {
                window.showHubToast?.(result?.error || t("devicesPanel.toastRemoveFailed"), "error");
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
    }

    function stopDevicesPanelLiveRefresh() {
        if (panelPollTimer) {
            clearInterval(panelPollTimer);
            panelPollTimer = null;
        }
    }

    async function openDevicesPanel(options = {}) {
        if (!options.inChildWindow && !/hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"))) {
            if (window.openSettingsPanel) {
                await window.openSettingsPanel({ tab: "devices" });
            } else if (window.hubModalAPI) {
                await window.hubModalAPI.open({ panel: "settings", tab: "devices" });
            }
            return;
        }

        await renderPanel();
        bindDiscoverSection();
        startDevicesPanelLiveRefresh();
    }

    function bindMaintenanceSection() {
        bindCleanupAction();
    }

    window.bindMaintenanceSection = bindMaintenanceSection;

    window.openDevicesPanel = openDevicesPanel;
    window.stopDevicesPanelLiveRefresh = stopDevicesPanelLiveRefresh;
    window.refreshDevicesPanel = (options) => renderPanel(options || { silent: true });
    window.bindDiscoverSection = bindDiscoverSection;

    globalThis.HubI18n?.onChange?.(() => {
        globalThis.HubI18n?.applyDomI18n?.(document.getElementById("panel-settings") || document);
        globalThis.HubI18n?.applyDomI18n?.(document.getElementById("cleanup-modal-overlay") || document);
        applyMaintenanceHintLabels();
        if (isDevicesPanelActive()) {
            void renderPanel({ silent: true });
        }
    });
})();
