(function initSettingsPanel() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    let currentTab = "devices";
    let tabButtonsBound = false;

    function showTab(tab) {
        currentTab = tab;
        document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.settingsTab === tab);
        });
        document.querySelectorAll(".settings-tab-pane").forEach((pane) => {
            pane.classList.toggle("active", pane.dataset.settingsPane === tab);
        });
    }

    async function activateTab(tab) {
        showTab(tab);

        if (tab === "devices") {
            await window.openDevicesPanel?.({ inChildWindow: true });
            return;
        }

        window.stopDevicesPanelLiveRefresh?.();

        if (tab === "control") {
            await window.openControlPanel?.({ inChildWindow: true });
            return;
        }

        if (tab === "maintenance") {
            window.bindMaintenanceSection?.();
        }
    }

    function bindTabButtons() {
        if (tabButtonsBound) return;
        tabButtonsBound = true;

        document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const tab = btn.dataset.settingsTab;
                if (!tab || tab === currentTab) return;
                void activateTab(tab);
            });
        });
    }

    function setSidebarActive() {
        document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
        document.getElementById("nav-settings")?.classList.add("active");
    }

    async function openSettingsPanel(options = {}) {
        const tab = options.tab || "devices";
        const inChildWindow = options.inChildWindow
            || /hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"));

        if (!inChildWindow) {
            if (window.hubModalAPI?.open) {
                await window.hubModalAPI.open({ panel: "settings", tab });
            }
            setSidebarActive();
            return;
        }

        bindTabButtons();
        await activateTab(tab);
    }

    async function refreshSettingsPanel() {
        if (currentTab === "devices") {
            await window.refreshDevicesPanel?.({ silent: false });
            return;
        }
        if (currentTab === "control") {
            await window.refreshControlPanel?.();
        }
    }

    function isSettingsPanelActive() {
        const panel = document.getElementById("panel-settings");
        return Boolean(panel?.classList.contains("active"));
    }

    function getCurrentSettingsTab() {
        return currentTab;
    }

    window.openSettingsPanel = openSettingsPanel;
    window.refreshSettingsPanel = refreshSettingsPanel;
    window.showSettingsTab = showTab;
    window.isSettingsPanelActive = isSettingsPanelActive;
    window.getCurrentSettingsTab = getCurrentSettingsTab;

    globalThis.HubI18n?.onChange?.(() => {
        globalThis.HubI18n?.applyDomI18n?.(document.getElementById("panel-settings") || document);
    });
})();
