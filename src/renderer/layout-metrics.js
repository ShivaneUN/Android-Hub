const MIN_VIDEO_BOUNDS = 64;
/** Ratio largeur/hauteur en mode portrait (tablette 16:10 → 10:16). */
const PORTRAIT_WIDTH_RATIO = 10 / 16;

let boundsSyncQueue = Promise.resolve();
let portraitLayoutActive = false;

function measureContentBounds() {
    const content = document.querySelector(".content");
    if (!content) return null;

    const contentRect = content.getBoundingClientRect();
    const style = window.getComputedStyle(content);
    const padL = parseFloat(style.paddingLeft) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    const padB = parseFloat(style.paddingBottom) || 0;

    return {
        x: Math.round(contentRect.left + padL),
        y: Math.round(contentRect.top + padT),
        width: Math.round(contentRect.width - padL - padR),
        height: Math.round(contentRect.height - padT - padB)
    };
}

function measurePortraitContentBounds(ratio = PORTRAIT_WIDTH_RATIO) {
    const full = measureContentBounds();
    if (!full || full.width <= 0 || full.height <= 0) return full;

    const areaAspect = full.width / full.height;
    let width;
    let height;

    if (areaAspect > ratio) {
        height = full.height;
        width = Math.round(height * ratio);
    } else {
        width = full.width;
        height = Math.round(width / ratio);
    }

    width = Math.max(MIN_VIDEO_BOUNDS, Math.min(width, full.width));
    height = Math.max(MIN_VIDEO_BOUNDS, Math.min(height, full.height));

    return {
        x: full.x + Math.round((full.width - width) / 2),
        y: full.y + Math.round((full.height - height) / 2),
        width,
        height
    };
}

function resolveSessionLayoutBounds() {
    return portraitLayoutActive ? measurePortraitContentBounds() : measureContentBounds();
}

async function syncVideoWithSidebarModals() {
    if (!window.sessionAPI?.setContentBounds) return;

    if (window.sessionAPI.restoreView) {
        await window.sessionAPI.restoreView();
    }

    const bounds = resolveSessionLayoutBounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

    await window.sessionAPI.setContentBounds(bounds);
}

function reportContentBounds() {
    boundsSyncQueue = boundsSyncQueue
        .then(() => syncVideoWithSidebarModals())
        .catch((err) => console.error("[VideoLayout] sync error:", err));
    return boundsSyncQueue;
}

async function applySessionPortraitLayout(portraitOn) {
    portraitLayoutActive = Boolean(portraitOn);
    const content = document.querySelector(".content");
    if (content) {
        content.classList.toggle("content--portrait-view", portraitLayoutActive);
    }
    await reportContentBounds();
}

function restoreSessionView() {
    reportContentBounds();
}

function initLayoutMetrics() {
    reportContentBounds();
    window.addEventListener("resize", reportContentBounds);

    const content = document.querySelector(".content");
    if (content && typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => reportContentBounds()).observe(content);
    }

    const mainLayout = document.querySelector(".main-layout");
    if (mainLayout && typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => reportContentBounds()).observe(mainLayout);
    }

    if (window.sessionAPI?.onOrientationChanged) {
        window.sessionAPI.onOrientationChanged((data) => {
            if (!data?.sessionId) return;
            void applySessionPortraitLayout(data.orientation === "portrait");
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLayoutMetrics);
} else {
    initLayoutMetrics();
}

window.reportContentBounds = reportContentBounds;
window.syncVideoWithSidebarModals = syncVideoWithSidebarModals;
window.restoreSessionView = restoreSessionView;
window.applySessionPortraitLayout = applySessionPortraitLayout;
