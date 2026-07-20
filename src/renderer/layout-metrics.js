const MIN_VIDEO_BOUNDS = 64;
/** Ratio largeur/hauteur en mode portrait (tablette 16:10 → 10:16). */
const PORTRAIT_WIDTH_RATIO = 10 / 16;

const BOUNDS_SYNC_DEBOUNCE_MS = 48;

let boundsSyncQueue = Promise.resolve();
let portraitLayoutActive = false;
let boundsSyncTimer = null;
let lastSingleBoundsKey = "";

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

function measureAspectFitContentBounds(ratio, { alignBottom = false } = {}) {
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
        y: alignBottom
            ? full.y + (full.height - height)
            : full.y + Math.round((full.height - height) / 2),
        width,
        height
    };
}

function measurePortraitContentBounds(ratio = PORTRAIT_WIDTH_RATIO) {
    return measureAspectFitContentBounds(ratio, { alignBottom: false });
}

function resolveSessionLayoutBounds() {
    if (portraitLayoutActive) return measurePortraitContentBounds();
    return measureContentBounds();
}

function serializeBounds(bounds) {
    if (!bounds) return "";
    return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

function serializeBoundsMap(boundsMap = {}) {
    return Object.keys(boundsMap)
        .sort()
        .map((id) => {
            const b = boundsMap[id];
            return `${id}:${serializeBounds(b)}`;
        })
        .join("|");
}

function boundsMapsEqual(a = {}, b = {}) {
    return serializeBoundsMap(a) === serializeBoundsMap(b);
}

async function syncVideoWithSidebarModals() {
    if (!window.sessionAPI?.setContentBounds) return;

    // Accueil demandé : garder le flux masqué (ne pas restoreView).
    if (window.__hubShowingHome) {
        if (window.sessionAPI.suppressView) {
            await window.sessionAPI.suppressView();
        }
        lastSingleBoundsKey = "";
        return;
    }

    if (window.sessionAPI.restoreView) {
        await window.sessionAPI.restoreView();
    }

    const bounds = resolveSessionLayoutBounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

    const boundsKey = serializeBounds(bounds);
    if (boundsKey === lastSingleBoundsKey) return;
    lastSingleBoundsKey = boundsKey;

    if (window.sessionAPI.setLayoutMode) {
        await window.sessionAPI.setLayoutMode("single");
    }

    await window.sessionAPI.setContentBounds(bounds);
}

async function syncVideoWithSidebarModalsOrStreamDeck() {
    if (window.__hubShowingHome) {
        await syncVideoWithSidebarModals();
        return;
    }

    if (window.getStreamDeckMode?.() === true && typeof window.syncStreamDeckLayout === "function") {
        await window.syncStreamDeckLayout();
        return;
    }

    await syncVideoWithSidebarModals();
}

function flushContentBoundsSync() {
    boundsSyncQueue = boundsSyncQueue
        .then(() => syncVideoWithSidebarModalsOrStreamDeck())
        .catch((err) => console.error("[VideoLayout] sync error:", err));
    return boundsSyncQueue;
}

function reportContentBounds() {
    if (boundsSyncTimer) {
        clearTimeout(boundsSyncTimer);
    }

    boundsSyncTimer = setTimeout(() => {
        boundsSyncTimer = null;
        flushContentBoundsSync();
    }, BOUNDS_SYNC_DEBOUNCE_MS);

    return boundsSyncQueue;
}

function invalidateSingleBoundsCache() {
    lastSingleBoundsKey = "";
}

async function applySessionPortraitLayout(portraitOn) {
    portraitLayoutActive = Boolean(portraitOn);
    const content = document.querySelector(".content");
    if (content) {
        content.classList.toggle("content--portrait-view", portraitLayoutActive);
    }
    invalidateSingleBoundsCache();
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
window.syncVideoLayout = syncVideoWithSidebarModalsOrStreamDeck;
window.restoreSessionView = restoreSessionView;
window.applySessionPortraitLayout = applySessionPortraitLayout;
window.invalidateVideoLayoutBoundsCache = invalidateSingleBoundsCache;
window.boundsMapsEqual = boundsMapsEqual;
window.serializeBoundsMap = serializeBoundsMap;
