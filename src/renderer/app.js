const HUB_PANEL_MAP = {
    "page-new-session": "new-session",
    "page-settings-panel": "settings",
    "page-devices-panel": "settings",
    "page-control-panel": "settings"
};

const HUB_PANEL_TAB_MAP = {
    "page-settings-panel": "devices",
    "page-devices-panel": "devices",
    "page-control-panel": "control"
};

function showPage(pageId) {
    if (HUB_PANEL_MAP[pageId]) {
        void openHubModal(pageId);
        return;
    }

    document.querySelectorAll(".content > .page").forEach((page) => {
        page.classList.add("hidden");
    });

    const page = document.getElementById(pageId);
    if (page) page.classList.remove("hidden");

    if (typeof reportContentBounds === "function") {
        void reportContentBounds();
    }
}

async function openHubModal(pageId, options = {}) {
    const panel = HUB_PANEL_MAP[pageId] || options.panel || pageId;
    const tab = options.tab || HUB_PANEL_TAB_MAP[pageId];
    if (!window.hubModalAPI?.open) return;
    await window.hubModalAPI.open({ panel, tab, ...options });
}

async function closeHubModal() {
    if (window.hubModalAPI?.close) {
        await window.hubModalAPI.close();
    }
}

async function isHubModalOpen(pageId) {
    if (!window.hubModalAPI?.isOpen) return false;
    const state = await window.hubModalAPI.isOpen();
    if (!state?.open) return false;
    if (!pageId) return true;
    const panel = HUB_PANEL_MAP[pageId] || pageId;
    return state.panel === panel;
}

window.openHelpPanel = (tab) => {
    void openHubModal("help", { panel: "help", tab: tab || "shortcuts" });
};

window.openSettingsPanelFromMain = (tab = "devices") => {
    void openHubModal("page-settings-panel", { panel: "settings", tab });
};

window.openNewSessionPanelFromMain = async () => {
    await openHubModal("page-new-session", { panel: "new-session" });
};

window.closeHelpPanel = () => {
    void closeHubModal();
};

window.openHubModal = openHubModal;
window.closeHubModal = closeHubModal;
window.isHubModalOpen = isHubModalOpen;
window.showPage = showPage;

if (window.hubModalAPI?.onClosed) {
    window.hubModalAPI.onClosed(() => {
        document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
    });
}
