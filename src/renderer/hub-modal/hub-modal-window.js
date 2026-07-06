(function initHubModalWindow() {
    const PANELS = {
        "new-session": "panel-new-session",
        settings: "panel-settings",
        help: "panel-help"
    };

    const LEGACY_PANEL_MAP = {
        devices: "settings",
        control: "settings"
    };

    const LEGACY_TAB_MAP = {
        devices: "devices",
        control: "control"
    };

    function showPanel(panelId) {
        Object.values(PANELS).forEach((id) => {
            document.getElementById(id)?.classList.remove("active");
        });
        const el = document.getElementById(PANELS[panelId]);
        if (el) el.classList.add("active");
    }

    async function handleHubPanelRefresh(panel) {
        switch (panel) {
            case "new-session":
                await window.refreshNewSessionPanel?.();
                break;
            case "settings":
                await window.refreshSettingsPanel?.();
                break;
            case "help":
                window.refreshHelpPanel?.();
                break;
            default:
                break;
        }
    }

    function bindHubPanelRefreshButtons() {
        document.querySelectorAll("[data-hub-panel-refresh]").forEach((btn) => {
            if (btn.dataset.bound === "1") return;
            btn.dataset.bound = "1";
            btn.addEventListener("click", () => {
                void handleHubPanelRefresh(btn.dataset.hubPanelRefresh);
            });
        });
    }

    function bindCloseButtons() {
        document.querySelectorAll("[data-hub-modal-close]").forEach((btn) => {
            btn.addEventListener("click", () => {
                window.stopDevicesPanelLiveRefresh?.();
                window.hubModalWindowAPI?.close?.();
            });
        });
    }

    async function onOpen(payload = {}) {
        let panel = payload.panel;
        let tab = payload.tab;

        if (LEGACY_PANEL_MAP[panel]) {
            tab = tab || LEGACY_TAB_MAP[panel];
            panel = LEGACY_PANEL_MAP[panel];
        }

        if (!panel || !PANELS[panel]) return;

        showPanel(panel);
        bindHubPanelRefreshButtons();

        if (panel === "new-session" && typeof openNewSessionPanel === "function") {
            window.stopDevicesPanelLiveRefresh?.();
            await openNewSessionPanel({ inChildWindow: true });
        } else if (panel === "settings" && typeof openSettingsPanel === "function") {
            await openSettingsPanel({ inChildWindow: true, tab: tab || "devices" });
        } else if (panel === "help" && typeof openHelpPanel === "function") {
            window.stopDevicesPanelLiveRefresh?.();
            openHelpPanel(payload.tab || "shortcuts");
        } else {
            window.stopDevicesPanelLiveRefresh?.();
        }
    }

    bindCloseButtons();
    bindHubPanelRefreshButtons();

    if (window.hubModalWindowAPI?.onOpen) {
        window.hubModalWindowAPI.onOpen(onOpen);
    }

    window.__hubModalWindowReady = true;
    window.dispatchEvent(new Event("hub-modal-window-ready"));
})();
