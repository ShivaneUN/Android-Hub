/**
 * Surveillance FPS en temps réel pour chaque fenêtre/session ouverte.
 * Met à jour les badges dans la barre d'onglets sans re-render complet.
 */

const FPS_SAMPLE_INTERVAL_MS = 1000;
const fpsSamples = new Map();
let fpsInterval = null;

function getLocalFrameCounts() {
    const counts = {};

    if (typeof window.getAllInstances === "function") {
        for (const instance of window.getAllInstances()) {
            if (instance?.player?.getFrameCount) {
                counts[instance.id] = instance.player.getFrameCount();
            }
        }
    }

    if (typeof window.getAllNewInstanceSessions === "function") {
        for (const entry of window.getAllNewInstanceSessions()) {
            const sessionId = entry.sessionId;
            if (entry.player?.getFrameCount) {
                counts[sessionId] = entry.player.getFrameCount();
            } else if (entry.pipeline?.getFrameCount) {
                counts[sessionId] = entry.pipeline.getFrameCount();
            }
        }
    }

    return counts;
}

async function collectAllFrameCounts() {
    const counts = getLocalFrameCounts();

    if (window.sessionAPI?.getFrameCounts) {
        try {
            const viewCounts = await window.sessionAPI.getFrameCounts();
            if (viewCounts && typeof viewCounts === "object") {
                Object.assign(counts, viewCounts);
            }
        } catch (err) {
            console.warn("[FpsMonitor] getFrameCounts error:", err.message);
        }
    }

    return counts;
}

function computeFps(sessionId, frameCount, now) {
    const prev = fpsSamples.get(sessionId);
    fpsSamples.set(sessionId, { frameCount, timestamp: now });

    if (!prev) return null;

    const deltaFrames = frameCount - prev.frameCount;
    const deltaMs = now - prev.timestamp;

    if (deltaMs < 200 || deltaFrames < 0) return null;

    return Math.round((deltaFrames * 1000) / deltaMs);
}

function updateFpsBadges(fpsBySession) {
    const tabsBar = document.getElementById("tabs-bar");
    if (!tabsBar) return;

    tabsBar.querySelectorAll(".tab-fps").forEach((badge) => {
        const sessionId = badge.dataset.sessionId;
        const fps = fpsBySession[sessionId];

        if (fps === null || fps === undefined) {
            badge.textContent = "— fps";
            badge.classList.remove("active-stream");
        } else {
            badge.textContent = `${fps} fps`;
            badge.classList.add("active-stream");
        }
    });
}

async function sampleFps() {
    const counts = await collectAllFrameCounts();
    const now = Date.now();
    const fpsBySession = {};
    const activeIds = new Set(Object.keys(counts));

    for (const [sessionId, frameCount] of Object.entries(counts)) {
        fpsBySession[sessionId] = computeFps(sessionId, frameCount, now);
    }

    updateFpsBadges(fpsBySession);

    for (const sessionId of fpsSamples.keys()) {
        if (!activeIds.has(sessionId)) {
            fpsSamples.delete(sessionId);
        }
    }

    window.dispatchEvent(new CustomEvent("fps-updated", { detail: fpsBySession }));
}

function startFpsMonitor() {
    if (fpsInterval) return;

    sampleFps();
    fpsInterval = setInterval(() => {
        sampleFps().catch(console.error);
    }, FPS_SAMPLE_INTERVAL_MS);
}

function stopFpsMonitor() {
    if (fpsInterval) {
        clearInterval(fpsInterval);
        fpsInterval = null;
    }
    fpsSamples.clear();
}

function initFpsMonitor() {
    startFpsMonitor();

    if (window.sessionAPI?.onSessionListChanged) {
        window.sessionAPI.onSessionListChanged(() => {
            sampleFps().catch(console.error);
        });
    }

    window.addEventListener("beforeunload", stopFpsMonitor);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFpsMonitor);
} else {
    initFpsMonitor();
}

window.startFpsMonitor = startFpsMonitor;
window.stopFpsMonitor = stopFpsMonitor;
window.refreshFpsSnapshot = () => sampleFps().catch(console.error);
