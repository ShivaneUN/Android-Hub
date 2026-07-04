(function initHubModalWindow() {
    const PANELS = {
        "new-session": "panel-new-session",
        control: "panel-control",
        help: "panel-help"
    };

    function showPanel(panelId) {
        Object.values(PANELS).forEach((id) => {
            document.getElementById(id)?.classList.remove("active");
        });
        const el = document.getElementById(PANELS[panelId]);
        if (el) el.classList.add("active");
    }

    function bindCloseButtons() {
        document.querySelectorAll("[data-hub-modal-close]").forEach((btn) => {
            btn.addEventListener("click", () => {
                window.hubModalWindowAPI?.close?.();
            });
        });
    }

    async function onOpen(payload = {}) {
        const panel = payload.panel;
        if (!panel || !PANELS[panel]) return;

        showPanel(panel);

        if (panel === "new-session" && typeof openNewSessionPanel === "function") {
            await openNewSessionPanel({ inChildWindow: true });
        } else if (panel === "control" && typeof openControlPanel === "function") {
            await openControlPanel({ inChildWindow: true });
        } else if (panel === "help" && typeof openHelpPanel === "function") {
            openHelpPanel(payload.tab || "shortcuts");
        }
    }

    bindCloseButtons();

    if (window.hubModalWindowAPI?.onOpen) {
        window.hubModalWindowAPI.onOpen(onOpen);
    }

    window.__hubModalWindowReady = true;
    window.dispatchEvent(new Event("hub-modal-window-ready"));
})();
