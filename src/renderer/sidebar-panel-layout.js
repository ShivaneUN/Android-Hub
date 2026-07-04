/**
 * Positionnement dynamique des panneaux contextuels ancrés à la sidebar.
 * Recalcule left / top / width / height pour rester dans le viewport.
 */

const SIDE_PANEL_MARGIN = 8;
const MIN_PANEL_WIDTH = 240;
const DEFAULT_PANEL_WIDTH = 330;
const CONTROL_PANEL_WIDTH = 360;

const PANEL_PREFERRED_WIDTHS = {
    "page-new-session": DEFAULT_PANEL_WIDTH,
    "page-control-panel": CONTROL_PANEL_WIDTH
};

function measureChromeTop() {
    const titlebar = document.querySelector(".titlebar");
    const tabsBar = document.querySelector(".tabs-bar");
    let top = 0;

    if (titlebar) top += titlebar.getBoundingClientRect().height;
    if (tabsBar) top += tabsBar.getBoundingClientRect().height;

    return Math.round(top);
}

function measureSidebarRect() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) {
        return { left: 0, right: 208, width: 208 };
    }

    const rect = sidebar.getBoundingClientRect();
    return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width)
    };
}

function getPreferredPanelWidth(pageId) {
    if (pageId && PANEL_PREFERRED_WIDTHS[pageId]) {
        return PANEL_PREFERRED_WIDTHS[pageId];
    }
    return DEFAULT_PANEL_WIDTH;
}

function computeSidePanelLayout(preferredWidth = DEFAULT_PANEL_WIDTH) {
    const sidebar = measureSidebarRect();
    const top = measureChromeTop();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const margin = SIDE_PANEL_MARGIN;

    const anchorLeft = sidebar.right;
    const maxRight = viewportW - margin;
    const maxBottom = viewportH - margin;

    let availableWidth = Math.max(0, maxRight - anchorLeft);
    let width = Math.min(preferredWidth, availableWidth);

    if (availableWidth > 0) {
        width = Math.max(Math.min(MIN_PANEL_WIDTH, availableWidth), width);
    } else {
        width = Math.max(160, availableWidth);
    }

    let left = anchorLeft;

    if (left + width > maxRight) {
        left = maxRight - width;
    }

    left = Math.max(anchorLeft, left);

    if (left + width > maxRight) {
        width = Math.max(160, maxRight - left);
    }

    const height = Math.max(0, maxBottom - top);

    return {
        left,
        top,
        width,
        height,
        sidebarWidth: sidebar.width
    };
}

function applyLayoutCssVars(layout) {
    const root = document.documentElement;
    root.style.setProperty("--sidebar-width", `${layout.sidebarWidth}px`);
    root.style.setProperty("--chrome-top-height", `${layout.top}px`);
    root.style.setProperty("--side-panel-left", `${layout.left}px`);
    root.style.setProperty("--side-panel-width", `${layout.width}px`);
    root.style.setProperty("--side-panel-height", `${layout.height}px`);
    root.style.setProperty("--side-panel-margin", `${SIDE_PANEL_MARGIN}px`);
}

function applyLayoutToPanel(panel, layout) {
    if (!panel) return;

    panel.style.left = `${layout.left}px`;
    panel.style.top = `${layout.top}px`;
    panel.style.width = `${layout.width}px`;
    panel.style.height = `${layout.height}px`;
    panel.style.maxWidth = `${layout.width}px`;
    panel.style.maxHeight = `${layout.height}px`;
}

function layoutSidebarPanels(activePageId = null) {
    const visiblePanel = activePageId
        ? document.getElementById(activePageId)
        : document.querySelector(".side-panel:not(.hidden)");

    const preferredWidth = visiblePanel?.id
        ? getPreferredPanelWidth(visiblePanel.id)
        : DEFAULT_PANEL_WIDTH;

    const layout = computeSidePanelLayout(preferredWidth);
    applyLayoutCssVars(layout);

    document.querySelectorAll(".side-panel").forEach((panel) => {
        if (panel.classList.contains("hidden")) return;

        const panelLayout = computeSidePanelLayout(getPreferredPanelWidth(panel.id));
        applyLayoutToPanel(panel, panelLayout);
    });

    if (typeof reportContentBounds === "function") {
        reportContentBounds();
    }

    return layout;
}

function initSidebarPanelLayout() {
    layoutSidebarPanels();

    window.addEventListener("resize", () => {
        layoutSidebarPanels();
        if (typeof reportContentBounds === "function") reportContentBounds();
    });

    const sidebar = document.getElementById("sidebar");
    if (sidebar && typeof ResizeObserver !== "undefined") {
        const sidebarObserver = new ResizeObserver(() => {
            layoutSidebarPanels();
            if (typeof reportContentBounds === "function") reportContentBounds();
        });
        sidebarObserver.observe(sidebar);
    }

    const mainLayout = document.querySelector(".main-layout");
    if (mainLayout && typeof ResizeObserver !== "undefined") {
        const panelObserver = new ResizeObserver(() => layoutSidebarPanels());
        panelObserver.observe(mainLayout);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSidebarPanelLayout);
} else {
    initSidebarPanelLayout();
}

window.layoutSidebarPanels = layoutSidebarPanels;
window.computeSidePanelLayout = computeSidePanelLayout;
