(function initHubModalWindow() {
    const PANELS = {
        "new-session": "panel-new-session",
        control: "panel-control",
        devices: "panel-devices",
        help: "panel-help"
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
            case "control":
                await window.refreshControlPanel?.();
                break;
            case "devices":
                await window.refreshDevicesPanel?.({ silent: false });
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
        const panel = payload.panel;
        if (!panel || !PANELS[panel]) return;

        showPanel(panel);
        bindHubPanelRefreshButtons();

        if (panel === "new-session" && typeof openNewSessionPanel === "function") {
            window.stopDevicesPanelLiveRefresh?.();
            await openNewSessionPanel({ inChildWindow: true });
        } else if (panel === "control" && typeof openControlPanel === "function") {
            window.stopDevicesPanelLiveRefresh?.();
            await openControlPanel({ inChildWindow: true });
        } else if (panel === "devices" && typeof openDevicesPanel === "function") {
            await openDevicesPanel({ inChildWindow: true });
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
