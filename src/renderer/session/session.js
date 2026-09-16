const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId");
const type = params.get("type");
const deviceId = params.get("deviceId") || "";
const canvas = document.getElementById("video-canvas");
/** "A" | "B" — une BrowserView = un type fixe (URL query). */
const sessionViewType = type ? String(type).toUpperCase() : "A";

function hubDiag(level, message, scope = "yume") {
    try {
        window.videoAPI?.appendHubLog?.({
            level,
            scope,
            message,
            sessionId
        });
    } catch (_err) {
        /* noop */
    }
}

window.addEventListener("storage", (event) => {
    if (event.key !== "androidHub.uiTheme") return;
    document.documentElement.dataset.videoFit = "contain";
});

function isOrientationManagedSession() {
    return sessionViewType === "A";
}

/** ~1s de buffer à 60 fps — privilégie la latence sur la tolérance aux stalls. */
const MAX_VIDEO_PACKET_QUEUE = 60;

/** Rotation canvas portrait (toggle UI) : +90° fixe — indépendant du verrou scrcpy serveur. */
const PORTRAIT_DISPLAY_ROTATION = Math.PI / 2;

const portraitDisplayBySession = new Map();
/** true = flux paysage affiché via rotation canvas → remap input requis */
const portraitInputRemapBySession = new Map();
/** @type {Map<string, boolean>} verrou remap pendant un drag (évite drift portrait) */
const portraitRemapLockedBySession = new Map();

/** @type {Map<string, number>} frames portrait consécutives (hystérésis remap) */
const portraitStreamStableFrames = new Map();
/** @type {Map<string, boolean>} flux portrait (h>w) → rotation canvas paysage Type B */
const typeBPortraitStreamCorrection = new Map();

function setPortraitDisplay(sessionIdParam, portrait) {
    if (!sessionIdParam) return;
    portraitDisplayBySession.set(sessionIdParam, Boolean(portrait));
    if (!portrait) {
        portraitInputRemapBySession.set(sessionIdParam, false);
        portraitStreamStableFrames.delete(sessionIdParam);
        portraitRemapLockedBySession.delete(sessionIdParam);
    }
}

function setPortraitInputRemap(sessionIdParam, needsRemap) {
    if (!sessionIdParam) return;
    portraitInputRemapBySession.set(sessionIdParam, Boolean(needsRemap));
}

function needsPortraitInputRemap(sessionIdParam) {
    return isPortraitDisplay(sessionIdParam) && portraitInputRemapBySession.get(sessionIdParam) === true;
}

function isPortraitDisplay(sessionIdParam) {
    return portraitDisplayBySession.get(sessionIdParam) === true;
}

/** @type {Map<string, { portrait: boolean, interim: boolean, canvasW: number, canvasH: number }>} */
const portraitLayoutSnapshotBySession = new Map();

function needsTypeBPortraitStreamCorrection(sessionIdParam) {
    return sessionViewType === "B" && typeBPortraitStreamCorrection.get(sessionIdParam) === true;
}

function initSessionDisplayOrientation(sessionIdParam, initialOrientation) {
    if (!isOrientationManagedSession()) {
        setPortraitDisplay(sessionIdParam, false);
        return;
    }
    setPortraitDisplay(sessionIdParam, initialOrientation === "portrait");
    syncPortraitLayout(sessionIdParam, { resetZoom: true });
    window.videoAPI?.onOrientationChanged?.((data) => {
        if (data?.sessionId !== sessionIdParam) return;
        setPortraitDisplay(sessionIdParam, data.orientation === "portrait");
        syncPortraitLayout(sessionIdParam, { resetZoom: true });
    });
}

/**
 * Évite d'alterner remap à chaque frame quand le flux oscille paysage/portrait.
 */
function updatePortraitInputRemapForFrame(sessionIdParam, portraitDisplay, landscapeFrame) {
    if (!sessionIdParam || !portraitDisplay) {
        portraitStreamStableFrames.delete(sessionIdParam);
        if (!portraitRemapLockedBySession.get(sessionIdParam)) {
            setPortraitInputRemap(sessionIdParam, false);
        }
        return;
    }
    if (portraitRemapLockedBySession.get(sessionIdParam)) {
        return;
    }
    if (!landscapeFrame) {
        portraitStreamStableFrames.delete(sessionIdParam);
        if (!portraitRemapLockedBySession.get(sessionIdParam)) {
            setPortraitInputRemap(sessionIdParam, false);
        }
        return;
    }
    portraitStreamStableFrames.set(sessionIdParam, 0);
    setPortraitInputRemap(sessionIdParam, true);
}

function syncPortraitLayout(sessionIdParam, { resetZoom = false } = {}) {
    if (!isOrientationManagedSession()) {
        document.documentElement.dataset.portraitDisplay = "0";
        return;
    }
    const portrait = isPortraitDisplay(sessionIdParam);
    if (!canvas) {
        document.documentElement.dataset.portraitDisplay = portrait ? "1" : "0";
        return;
    }

    const interim = portrait && canvas.width > canvas.height;
    const snap = portraitLayoutSnapshotBySession.get(sessionIdParam);
    const changed = !snap
        || snap.portrait !== portrait
        || snap.interim !== interim
        || snap.canvasW !== canvas.width
        || snap.canvasH !== canvas.height;

    if (!changed && !resetZoom) return;

    portraitLayoutSnapshotBySession.set(sessionIdParam, {
        portrait,
        interim,
        canvasW: canvas.width,
        canvasH: canvas.height
    });

    document.documentElement.dataset.portraitDisplay = portrait ? "1" : "0";
    canvas.classList.toggle("portrait-interim", interim);
    document.getElementById("session-video-element")?.classList.toggle("portrait-interim", interim);

    const viewport = canvas.closest(".session-zoom-viewport");
    if (viewport) {
        viewport.classList.toggle("portrait-centered", portrait);
    }

    if (portrait) {
        canvas.style.transformOrigin = "center center";
        canvas.style.margin = "auto";
    } else {
        canvas.style.transformOrigin = "0 0";
        canvas.style.margin = "";
    }

    if (resetZoom) {
        window.__sessionWheelZoom?.[sessionIdParam]?.reset?.();
    }
    window.__yumeVideoSink?.syncLayout?.();
}

function layoutCanvasForFrame(canvasEl, frame, sessionIdParam) {
    const frameW = frame.displayWidth;
    const frameH = frame.displayHeight;
    const prevCanvasW = canvasEl.width;
    const prevCanvasH = canvasEl.height;
    let rotated = false;

    if (!isOrientationManagedSession()) {
        const portraitStream = frameH > frameW;
        typeBPortraitStreamCorrection.set(sessionIdParam, portraitStream);
        if (portraitStream) {
            rotated = true;
            syncCanvasSizeForInput(canvasEl, frameH, frameW);
        } else {
            syncCanvasSizeForInput(canvasEl, frameW, frameH);
        }
        return { rotated, frameW, frameH };
    }

    const landscapeFrame = frameW > frameH;
    const portraitDisplay = isPortraitDisplay(sessionIdParam);
    if (portraitDisplay && landscapeFrame) {
        rotated = true;
        updatePortraitInputRemapForFrame(sessionIdParam, true, true);
        syncCanvasSizeForInput(canvasEl, frameH, frameW);
    } else {
        updatePortraitInputRemapForFrame(sessionIdParam, portraitDisplay, landscapeFrame);
        syncCanvasSizeForInput(canvasEl, frameW, frameH);
    }
    if (canvasEl.width !== prevCanvasW || canvasEl.height !== prevCanvasH) {
        syncPortraitLayout(sessionIdParam);
    }
    return { rotated, frameW, frameH };
}

function drawVideoFrame(ctx, canvasEl, frame, sessionIdParam) {
    const { rotated, frameW, frameH } = layoutCanvasForFrame(canvasEl, frame, sessionIdParam);

    if (rotated) {
        const cw = canvasEl.width;
        const ch = canvasEl.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.save();
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate(PORTRAIT_DISPLAY_ROTATION);
        ctx.drawImage(frame, -frameW / 2, -frameH / 2, frameW, frameH);
        ctx.restore();
    } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(frame, 0, 0, frameW, frameH);
    }
    frame.close();
}

function frameNeedsCanvasRotation(frame, sessionIdParam) {
    const frameW = frame.displayWidth;
    const frameH = frame.displayHeight;
    if (!isOrientationManagedSession()) {
        return frameH > frameW;
    }
    return isPortraitDisplay(sessionIdParam) && frameW > frameH;
}

function syncCanvasSizeForInput(canvasEl, width, height) {
    if (canvasEl.width !== width || canvasEl.height !== height) {
        canvasEl.width = width;
        canvasEl.height = height;
        return true;
    }
    return false;
}

function isYumeRendererSupported() {
    return typeof MediaStreamTrackGenerator === "function";
}

function createYumeVideoSink(canvasEl) {
    let enabled = false;
    let generator = null;
    let writer = null;
    let videoEl = null;
    let firstPresentLogged = false;
    let lastRotated = false;
    let portraitLogged = false;
    let layoutObserver = null;
    let layoutRaf = null;

    function ensureVideo() {
        if (!canvasEl) return null;
        const viewport = canvasEl.closest(".session-zoom-viewport") || canvasEl.parentElement;
        if (!viewport) return null;
        videoEl = document.getElementById("session-video-element");
        if (!videoEl) {
            videoEl = document.createElement("video");
            videoEl.id = "session-video-element";
            videoEl.muted = true;
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.setAttribute("playsinline", "");
            videoEl.disablePictureInPicture = true;
            if ("disableRemotePlayback" in videoEl) {
                videoEl.disableRemotePlayback = true;
            }
            viewport.insertBefore(videoEl, canvasEl);
        } else if (videoEl.parentElement !== viewport) {
            viewport.insertBefore(videoEl, canvasEl);
        }
        return videoEl;
    }

    function observeLayout() {
        if (layoutObserver || typeof ResizeObserver !== "function") return;
        const viewport = canvasEl?.closest(".session-zoom-viewport") || canvasEl?.parentElement;
        layoutObserver = new ResizeObserver(() => scheduleLayoutSync());
        if (viewport) layoutObserver.observe(viewport);
        if (canvasEl) layoutObserver.observe(canvasEl);
        window.addEventListener("resize", scheduleLayoutSync);
    }

    function scheduleLayoutSync() {
        if (layoutRaf !== null) return;
        layoutRaf = requestAnimationFrame(() => {
            layoutRaf = null;
            syncLayout();
        });
    }

    function syncLayout() {
        const video = videoEl || document.getElementById("session-video-element");
        if (!video || !canvasEl || document.documentElement.dataset.yumeRenderer !== "1") return;
        const viewport = video.parentElement;
        if (!viewport) return;

        const canvasRect = canvasEl.getBoundingClientRect();
        const viewRect = viewport.getBoundingClientRect();
        if (canvasRect.width < 2 || canvasRect.height < 2) return;

        video.style.position = "absolute";
        video.style.pointerEvents = "none";
        video.style.transformOrigin = "center center";

        if (!lastRotated) {
            video.style.left = `${canvasRect.left - viewRect.left}px`;
            video.style.top = `${canvasRect.top - viewRect.top}px`;
            video.style.width = `${canvasRect.width}px`;
            video.style.height = `${canvasRect.height}px`;
            video.style.transform = "";
            video.style.objectFit = "contain";
            return;
        }

        const boxW = canvasRect.height;
        const boxH = canvasRect.width;
        video.style.left = `${canvasRect.left - viewRect.left + (canvasRect.width - boxW) / 2}px`;
        video.style.top = `${canvasRect.top - viewRect.top + (canvasRect.height - boxH) / 2}px`;
        video.style.width = `${boxW}px`;
        video.style.height = `${boxH}px`;
        video.style.transform = "rotate(90deg)";
        video.style.objectFit = "fill";
    }

    function setPresenting(active) {
        document.documentElement.dataset.yumeRenderer = active ? "1" : "0";
    }

    function startTrack() {
        if (!isYumeRendererSupported()) {
            hubDiag("error", "MediaStreamTrackGenerator indisponible");
            return false;
        }
        const video = ensureVideo();
        if (!video) {
            hubDiag("error", "Élément <video> introuvable (viewport)");
            return false;
        }
        if (writer) return true;
        generator = new MediaStreamTrackGenerator({ kind: "video" });
        writer = generator.writable.getWriter();
        video.srcObject = new MediaStream([generator]);
        video.play().catch((err) => {
            hubDiag("warn", `video.play() : ${err?.message || err}`);
        });
        hubDiag("info", "Piste <video> démarrée (taille après 1re frame)");
        observeLayout();
        return true;
    }

    function stopTrack() {
        const wasLive = Boolean(writer);
        setPresenting(false);
        try {
            writer?.releaseLock?.();
        } catch (_err) {
            /* noop */
        }
        writer = null;
        generator = null;
        firstPresentLogged = false;
        portraitLogged = false;
        lastRotated = false;
        if (videoEl) {
            videoEl.srcObject = null;
            videoEl.style.transform = "";
        }
        if (wasLive) {
            hubDiag("info", "Piste <video> arrêtée → retour canvas");
        }
    }

    function setEnabled(next) {
        const want = next === true;
        const supported = isYumeRendererSupported();
        const nextEnabled = want && supported;
        if (want && !supported) {
            hubDiag("error", "Yume demandé mais MediaStreamTrackGenerator absent");
        }
        if (nextEnabled !== enabled) {
            hubDiag("info", nextEnabled
                ? "Yume ON — frames via <video> (paysage et portrait)"
                : "Yume OFF — canvas 2D");
        }
        enabled = nextEnabled;
        if (!enabled) {
            stopTrack();
        }
        return enabled;
    }

    function canPresent(frame) {
        return enabled && Boolean(frame);
    }

    function present(frame, { rotated = false } = {}) {
        lastRotated = Boolean(rotated);
        if (!startTrack() || !writer) {
            try { frame.close(); } catch (_err) { /* noop */ }
            hubDiag("error", "present() sans piste <video>");
            return;
        }
        setPresenting(true);
        if (!firstPresentLogged) {
            firstPresentLogged = true;
            hubDiag("info", `Première frame Yume ${frame.displayWidth}x${frame.displayHeight}${rotated ? " portrait" : ""}`);
        } else if (rotated && !portraitLogged) {
            portraitLogged = true;
            hubDiag("info", "Yume portrait — CSS rotate(90), input canvas inchangé");
        } else if (!rotated) {
            portraitLogged = false;
        }
        writer.write(frame).catch((err) => {
            hubDiag("error", `writer.write : ${err?.message || err}`);
            try { frame.close(); } catch (_err) { /* noop */ }
        });
        scheduleLayoutSync();
    }

    function captureJpeg(quality = 0.55) {
        if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth < 2) return null;
        try {
            const vw = videoEl.videoWidth;
            const vh = videoEl.videoHeight;
            const snap = document.createElement("canvas");
            const snapCtx = snap.getContext("2d");
            if (lastRotated) {
                snap.width = vh;
                snap.height = vw;
                snapCtx.translate(vh / 2, vw / 2);
                snapCtx.rotate(Math.PI / 2);
                snapCtx.drawImage(videoEl, -vw / 2, -vh / 2, vw, vh);
            } else {
                snap.width = vw;
                snap.height = vh;
                snapCtx.drawImage(videoEl, 0, 0);
            }
            return snap.toDataURL("image/jpeg", quality);
        } catch (_err) {
            return null;
        }
    }

    return {
        setEnabled,
        isEnabled: () => enabled,
        canPresent,
        present,
        attach: ensureVideo,
        captureJpeg,
        stop: stopTrack,
        syncLayout,
        markCanvasFallback(reason) {
            setPresenting(false);
            hubDiag("warn", reason || "Fallback canvas");
        }
    };
}

function captureSessionPreviewJpeg(canvasElement, quality = 0.55) {
    const fromYume = window.__yumeVideoSink?.captureJpeg?.(quality);
    if (fromYume) return fromYume;
    if (!canvasElement || canvasElement.width === 0 || canvasElement.height === 0) {
        return null;
    }
    try {
        return canvasElement.toDataURL("image/jpeg", quality);
    } catch (_err) {
        return null;
    }
}

function createVideoFramePresenter(ctx, canvasEl, sessionIdParam) {
    let pendingFrame = null;
    let rafId = null;
    let firstFrameReported = false;

    function reportFirstFrameIfNeeded() {
        if (firstFrameReported || !sessionIdParam) return;
        firstFrameReported = true;
        window.videoAPI?.reportLaunchLatencyFirstFrame?.(sessionIdParam, Date.now());
    }

    function cancel() {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        if (pendingFrame) {
            pendingFrame.close();
            pendingFrame = null;
        }
    }

    function schedule(frame) {
        if (pendingFrame) {
            pendingFrame.close();
        }
        pendingFrame = frame;
        if (rafId !== null) return;

        rafId = requestAnimationFrame(() => {
            rafId = null;
            const frameToDraw = pendingFrame;
            pendingFrame = null;
            if (!frameToDraw) return;
            const yume = window.__yumeVideoSink;
            if (yume?.isEnabled?.()) {
                const layout = layoutCanvasForFrame(canvasEl, frameToDraw, sessionIdParam);
                yume.present(frameToDraw, { rotated: layout.rotated });
            } else {
                drawVideoFrame(ctx, canvasEl, frameToDraw, sessionIdParam);
            }
            reportFirstFrameIfNeeded();
        });
    }

    return { schedule, cancel };
}

function needsDisplayCoordRemap(sessionIdParam) {
    return isOrientationManagedSession() && needsPortraitInputRemap(sessionIdParam);
}

/** Remappe les coords canvas après rotation client +90° (Type A portrait interim uniquement). */
function mapDisplayCoordsToStream(sessionIdParam, coords) {
    if (!coords || !needsDisplayCoordRemap(sessionIdParam)) {
        return coords;
    }

    const { streamX, streamY, canvasWidth, canvasHeight } = coords;
    const streamW = canvasHeight;
    const streamH = canvasWidth;

    return {
        ...coords,
        streamX: Math.min(Math.max(streamY, 0), streamW - 1),
        streamY: Math.min(Math.max(canvasWidth - 1 - streamX, 0), streamH - 1),
        canvasWidth: streamW,
        canvasHeight: streamH
    };
}

function resolveTouchOrientationForSession(sessionIdParam, captureOrientation) {
    if (!isOrientationManagedSession() || !isPortraitDisplay(sessionIdParam)) {
        return captureOrientation;
    }
    return needsPortraitInputRemap(sessionIdParam) ? "landscape" : "portrait";
}

function isSyntheticLayoutPointerMove(event) {
    return event.pointerType === "mouse"
        && event.movementX === 0
        && event.movementY === 0;
}

function touchCoordsMovedEnough(lastCoords, nextCoords, minDelta = 2) {
    if (!lastCoords || !nextCoords) return true;
    return Math.abs(nextCoords.streamX - lastCoords.streamX) >= minDelta
        || Math.abs(nextCoords.streamY - lastCoords.streamY) >= minDelta;
}

function createTouchMoveQueue(sendTouchAction) {
    let pendingInput = Promise.resolve();
    let pendingMoveCoords = null;
    let moveFlushActive = false;

    async function flushMoves() {
        while (pendingMoveCoords) {
            const coordsToSend = pendingMoveCoords;
            pendingMoveCoords = null;
            await sendTouchAction(null, "move", coordsToSend);
        }
        moveFlushActive = false;
    }

    function queue(action, event, coordsOverride = null) {
        if (action === "move") {
            pendingMoveCoords = coordsOverride;
            if (moveFlushActive) return pendingInput;
            moveFlushActive = true;
            pendingInput = pendingInput
                .catch(() => {})
                .then(() => flushMoves());
            return pendingInput;
        }

        pendingMoveCoords = null;
        pendingInput = pendingInput
            .catch(() => {})
            .then(() => sendTouchAction(event, action, coordsOverride));
        return pendingInput;
    }

    function cancelMoves() {
        pendingMoveCoords = null;
    }

    return { queue, cancelMoves };
}

const KEYCODE_MAP = {
    Enter: true,
    Backspace: true,
    Escape: true,
    Tab: true,
    ArrowUp: true,
    ArrowDown: true,
    ArrowLeft: true,
    ArrowRight: true,
    Home: true,
    Back: true,
    Menu: true,
    Delete: true,
    VolumeUp: true,
    VolumeDown: true,
    Power: true
};

function isAltGraphKeyboardEvent(event) {
    return typeof event.getModifierState === "function" && event.getModifierState("AltGraph");
}

/** AZERTY / QWERTY : autorise caractères imprimables, Alt Gr (Ctrl+Alt), Shift+chiffres. */
function resolveSessionKeyFromEvent(event) {
    if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA")) {
        return null;
    }

    const key = event.key;
    if (!key || key === "Dead" || key === "Unidentified") {
        return null;
    }

    const isSpecial = Boolean(KEYCODE_MAP[key]);
    const isPrintable = key.length === 1;
    if (!isPrintable && !isSpecial) {
        return null;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab : cycle onglets (géré côté Main).
    if ((event.ctrlKey || event.metaKey) && key === "Tab") {
        return null;
    }

    const altGraph = isAltGraphKeyboardEvent(event);

    if (event.metaKey && !altGraph) {
        return null;
    }

    // Alt Gr sous Windows = ctrlKey + altKey : ne pas bloquer les caractères (@, #, {, …).
    if ((event.ctrlKey || event.metaKey) && !altGraph) {
        return null;
    }

    if (event.altKey && !altGraph && !isPrintable && !isSpecial) {
        return null;
    }

    return key;
}

function attachSessionInputActivation(canvasEl, sessionIdParam, onActivate) {
    if (!canvasEl || !sessionIdParam) return;

    let inputActive = true;

    function focusCanvas() {
        try {
            canvasEl.focus({ preventScroll: true });
        } catch (_err) {
            canvasEl.focus();
        }
    }

    window.videoAPI?.onSessionInputActive?.((data) => {
        inputActive = Boolean(data?.active);
        if (inputActive) {
            if (typeof onActivate === "function") {
                onActivate();
            }
            focusCanvas();
        }
    });

    window.__sessionInputReady = true;
    window.__sessionInputActive = () => inputActive;
    window.__sessionFocusCanvas = focusCanvas;

    return {
        isActive: () => inputActive,
        focusCanvas
    };
}

function attachRightClickBackHandler(canvasEl, sendBackKey) {
    if (!canvasEl || typeof sendBackKey !== "function") return;

    canvasEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void sendBackKey();
    });
}

/**
 * Handlers pointer partagés Type A / Type B.
 * Type A : remap si portrait interim. Type B : coords canvas directes (display virtuel).
 */
function createCanvasPointerHandlers(canvasEl, sessionIdParam, dispatchTouch, onActivate, { remapCoords = true } = {}) {
    let isDragging = false;
    let activePointerId = null;
    let lastMoveSentAt = 0;
    let lastSentCoords = null;
    let touchSequenceStarted = false;

    const inputActivation = attachSessionInputActivation(canvasEl, sessionIdParam, onActivate);

    function applyCoordRemap(coords) {
        return remapCoords ? mapDisplayCoordsToStream(sessionIdParam, coords) : coords;
    }

    async function sendTouchAction(event, action, coordsOverride = null) {
        const rawCoords = coordsOverride || normalizePointerPosition(canvasEl, event);
        const mapped = applyCoordRemap(rawCoords);
        try {
            await dispatchTouch(action, mapped);
        } catch (err) {
            console.warn(`[SessionView ${sessionIdParam}] touch ${action}:`, err?.message || err);
        }
    }

    const touchQueue = createTouchMoveQueue(sendTouchAction);

    function queueTouchAction(event, action, coordsOverride = null) {
        return touchQueue.queue(action, event, coordsOverride);
    }

    function clearPointerListeners() {
        canvasEl.removeEventListener("pointermove", onPointerMove);
        canvasEl.removeEventListener("pointerup", onPointerUp);
        canvasEl.removeEventListener("pointercancel", onPointerCancel);
    }

    function onPointerDown(event) {
        if (event.pointerType !== "mouse" && event.pointerType !== "touch" && event.pointerType !== "pen") return;
        if (event.button !== 0) return;
        const downCoords = normalizePointerPosition(canvasEl, event);
        if (downCoords.outOfBounds) return;
        event.preventDefault();
        if (inputActivation && !inputActivation.isActive()) {
            if (window.videoAPI?.activateSession) {
                void window.videoAPI.activateSession(sessionIdParam);
            }
            inputActivation.focusCanvas?.();
        }
        isDragging = true;
        activePointerId = event.pointerId;
        lastMoveSentAt = 0;
        if (remapCoords) {
            portraitRemapLockedBySession.set(sessionIdParam, true);
        }
        lastSentCoords = applyCoordRemap(downCoords);
        touchSequenceStarted = true;
        queueTouchAction(event, "down", downCoords);
        if (canvasEl.setPointerCapture) canvasEl.setPointerCapture(event.pointerId);
        canvasEl.focus();
        canvasEl.addEventListener("pointermove", onPointerMove, { passive: false });
        canvasEl.addEventListener("pointerup", onPointerUp);
        canvasEl.addEventListener("pointercancel", onPointerCancel);
    }

    async function onPointerUp(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        touchQueue.cancelMoves();
        if (canvasEl.releasePointerCapture) {
            try {
                canvasEl.releasePointerCapture(event.pointerId);
            } catch (_err) {
                // noop
            }
        }
        clearPointerListeners();
        const coords = normalizePointerPosition(canvasEl, event);
        if (touchSequenceStarted) {
            await queueTouchAction(event, "up", coords);
        }
        touchSequenceStarted = false;
        if (remapCoords) {
            portraitRemapLockedBySession.delete(sessionIdParam);
        }
        lastSentCoords = null;
    }

    function onPointerMove(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        if (isSyntheticLayoutPointerMove(event)) return;
        event.preventDefault();
        const now = Date.now();
        const rawCoords = normalizePointerPosition(canvasEl, event);
        const mappedCoords = applyCoordRemap(rawCoords);
        if (!touchCoordsMovedEnough(lastSentCoords, mappedCoords) && now - lastMoveSentAt < 16) return;
        lastMoveSentAt = now;
        lastSentCoords = mappedCoords;
        queueTouchAction(event, "move", rawCoords);
    }

    function onPointerCancel(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        touchQueue.cancelMoves();
        clearPointerListeners();
        const coords = normalizePointerPosition(canvasEl, event);
        if (touchSequenceStarted) {
            queueTouchAction(event, "up", coords);
        }
        touchSequenceStarted = false;
        if (remapCoords) {
            portraitRemapLockedBySession.delete(sessionIdParam);
        }
        lastSentCoords = null;
    }

    canvasEl.tabIndex = 0;
    canvasEl.style.outline = "none";
    canvasEl.style.touchAction = "none";
    canvasEl.style.userSelect = "none";
    canvasEl.addEventListener("pointerdown", onPointerDown);

    return {
        inputActivation,
        onKeyDownTarget: canvasEl
    };
}

function getCanvasContentRect(canvasEl) {
    const rect = canvasEl.getBoundingClientRect();
    const contentWidth = Math.max(canvasEl.width || 1, 1);
    const contentHeight = Math.max(canvasEl.height || 1, 1);
    const contentAspect = contentWidth / contentHeight;
    const containerAspect = rect.width / Math.max(rect.height, 1);

    if (Math.abs(contentAspect - containerAspect) < 0.02) {
        return {
            rect,
            offsetX: 0,
            offsetY: 0,
            displayWidth: rect.width,
            displayHeight: rect.height,
            contentWidth,
            contentHeight
        };
    }

    let displayWidth;
    let displayHeight;
    let offsetX;
    let offsetY;

    if (contentAspect > containerAspect) {
        displayWidth = rect.width;
        displayHeight = rect.width / contentAspect;
        offsetX = 0;
        offsetY = (rect.height - displayHeight) / 2;
    } else {
        displayHeight = rect.height;
        displayWidth = rect.height * contentAspect;
        offsetX = (rect.width - displayWidth) / 2;
        offsetY = 0;
    }

    return {
        rect,
        offsetX,
        offsetY,
        displayWidth,
        displayHeight,
        contentWidth,
        contentHeight
    };
}

function normalizePointerPosition(canvasEl, event) {
    const layout = getCanvasContentRect(canvasEl);
    const {
        rect,
        offsetX,
        offsetY,
        displayWidth,
        displayHeight,
        contentWidth,
        contentHeight
    } = layout;

    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const localX = pointerX - offsetX;
    const localY = pointerY - offsetY;

    const streamX = displayWidth > 0
        ? Math.round((localX / displayWidth) * (contentWidth - 1))
        : 0;
    const streamY = displayHeight > 0
        ? Math.round((localY / displayHeight) * (contentHeight - 1))
        : 0;

    return {
        streamX: Math.min(Math.max(streamX, 0), contentWidth - 1),
        streamY: Math.min(Math.max(streamY, 0), contentHeight - 1),
        canvasWidth: contentWidth,
        canvasHeight: contentHeight,
        outOfBounds: localX < 0 || localY < 0 || localX > displayWidth || localY > displayHeight
    };
}

function initTypeAVideoPlayer(tabId, canvasElement) {
    const ctx = canvasElement.getContext("2d");
    const framePresenter = createVideoFramePresenter(ctx, canvasElement, tabId);
    const MAX_PACKET_QUEUE = MAX_VIDEO_PACKET_QUEUE;
    const SYNTHETIC_FRAME_US = 16667;

    const state = {
        frameCount: 0,
        decoder: null,
        decoderReady: false,
        decoderInitializing: false,
        codecMeta: null,
        pendingConfigData: null,
        packetQueue: [],
        streamFormat: "annexb",
        configuredStreamFormat: null,
        firstPts: null,
        lastTimestampUs: -1,
        syntheticTimestampUs: 0
    };

    function ensureCanvasSize(width, height) {
        if (canvasElement.width === width && canvasElement.height === height) {
            state.softCutHolding = false;
            return;
        }
        // Resize = clear canvas — inévitable si résolution change après soft-cut.
        canvasElement.width = width;
        canvasElement.height = height;
        state.softCutHolding = false;
    }

    function getCodecCandidates(codecId) {
        if (codecId === "h264") return ["avc1.640034", "avc1.4D4028", "avc1.42E01E"];
        if (codecId === "h265" || codecId === "hevc") return ["hev1.1.6.L93.B0", "hvc1.1.6.L93.B0"];
        return ["avc1.640034", "avc1.42E01E"];
    }

    function detectH264StreamFormat(configData) {
        if (!configData || configData.length < 4) return "annexb";
        const b0 = configData[0];
        const b1 = configData[1];
        const b2 = configData[2];
        const b3 = configData[3];
        if ((b0 === 0x00 && b1 === 0x00 && b2 === 0x01) || (b0 === 0x00 && b1 === 0x00 && b2 === 0x00 && b3 === 0x01)) {
            return "annexb";
        }
        if (b0 === 0x01) return "avc";
        return "annexb";
    }

    async function selectDecoderConfig(meta, h264Format = "annexb", avcDescription = null) {
        const candidates = getCodecCandidates(meta.codecId);
        const base = { codedWidth: meta.width, codedHeight: meta.height, optimizeForLatency: true };

        for (const codec of candidates) {
            const config = { ...base, codec };
            if (meta.codecId === "h264") {
                config.avc = { format: h264Format };
                if (h264Format === "avc" && avcDescription && avcDescription.length > 0) {
                    config.description = avcDescription;
                }
            }
            try {
                if (typeof VideoDecoder.isConfigSupported === "function") {
                    const support = await VideoDecoder.isConfigSupported(config);
                    if (!support?.supported) continue;
                }
                return config;
            } catch (_err) {
                // Try next candidate.
            }
        }

        const fallback = { ...base, codec: candidates[0] };
        if (meta.codecId === "h264") {
            fallback.avc = { format: h264Format };
            if (h264Format === "avc" && avcDescription && avcDescription.length > 0) {
                fallback.description = avcDescription;
            }
        }
        return fallback;
    }

    function normalizeBinary(data) {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
        return null;
    }

    function nextSyntheticTimestamp() {
        state.syntheticTimestampUs += SYNTHETIC_FRAME_US;
        if (state.syntheticTimestampUs <= state.lastTimestampUs) {
            state.syntheticTimestampUs = state.lastTimestampUs + SYNTHETIC_FRAME_US;
        }
        state.lastTimestampUs = state.syntheticTimestampUs;
        return state.syntheticTimestampUs;
    }

    function toTimestampUs(rawPts) {
        if (rawPts === undefined || rawPts === null) return nextSyntheticTimestamp();
        try {
            const pts = BigInt(rawPts);
            if (state.firstPts === null) state.firstPts = pts;
            let delta = pts - state.firstPts;
            if (delta < 0n) delta = 0n;
            const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
            if (delta > maxSafe) return nextSyntheticTimestamp();
            let ts = Number(delta);
            if (!Number.isFinite(ts)) return nextSyntheticTimestamp();
            if (ts <= state.lastTimestampUs) ts = state.lastTimestampUs + 1;
            state.lastTimestampUs = ts;
            state.syntheticTimestampUs = ts;
            return ts;
        } catch (_err) {
            return nextSyntheticTimestamp();
        }
    }

    function enqueuePacket(packet) {
        state.packetQueue.push(packet);
        if (state.packetQueue.length > MAX_PACKET_QUEUE) state.packetQueue.shift();
    }

    async function configureDecoder(meta, format = "annexb", avcDescription = null) {
        const decoderConfig = await selectDecoderConfig(meta, format, avcDescription);
        state.decoder = new VideoDecoder({
            output: (frame) => {
                framePresenter.schedule(frame);
                state.frameCount += 1;
            },
            error: (err) => {
                console.error(`[SessionView ${tabId}] Erreur decodeur:`, err);
            }
        });
        state.decoder.configure(decoderConfig);
        state.decoderReady = true;
        state.configuredStreamFormat = format;
    }

    async function reconfigureForStreamFormatIfNeeded() {
        if (!state.codecMeta) return;
        if (state.streamFormat === state.configuredStreamFormat) return;
        if (state.decoderInitializing) return;
        state.decoderInitializing = true;
        try {
            const avcDescription = state.streamFormat === "avc" ? state.pendingConfigData : null;
            framePresenter.cancel();
            if (state.decoder && state.decoder.state !== "closed") state.decoder.close();
            state.decoder = null;
            state.decoderReady = false;
            await configureDecoder(state.codecMeta, state.streamFormat, avcDescription);
            flushQueue();
        } catch (err) {
            console.error(`[SessionView ${tabId}] Echec reconfiguration decodeur:`, err);
        } finally {
            state.decoderInitializing = false;
        }
    }

    function decodePacket(packet) {
        if (!state.decoder || state.decoder.state === "closed" || !state.decoderReady) return;
        try {
            if (packet.isConfig) {
                const configData = normalizeBinary(packet.data);
                if (configData && configData.length > 0) {
                    state.pendingConfigData = configData;
                    const detectedFormat = detectH264StreamFormat(configData);
                    if (detectedFormat !== state.streamFormat) {
                        state.streamFormat = detectedFormat;
                        void reconfigureForStreamFormatIfNeeded();
                    }
                }
                return;
            }
            const payload = normalizeBinary(packet.data);
            if (!payload || payload.length === 0) return;
            let chunkData = payload;
            if (state.streamFormat === "annexb" && packet.isKeyFrame && state.pendingConfigData) {
                const merged = new Uint8Array(state.pendingConfigData.length + payload.length);
                merged.set(state.pendingConfigData, 0);
                merged.set(payload, state.pendingConfigData.length);
                chunkData = merged;
                state.pendingConfigData = null;
            }
            const chunk = new EncodedVideoChunk({
                type: packet.isKeyFrame ? "key" : "delta",
                timestamp: toTimestampUs(packet.pts),
                data: chunkData
            });
            state.decoder.decode(chunk);
        } catch (err) {
            console.error(`[SessionView ${tabId}] Erreur decode chunk:`, err);
        }
    }

    function flushQueue() {
        if (!state.decoder || state.decoder.state === "closed" || !state.decoderReady) return;
        while (state.packetQueue.length > 0) {
            decodePacket(state.packetQueue.shift());
            if (!state.decoder || state.decoder.state === "closed") break;
        }
    }

    async function initDecoder(meta) {
        if (state.decoder || state.decoderInitializing) return;
        state.decoderInitializing = true;
        state.codecMeta = meta;
        ensureCanvasSize(meta.width, meta.height);
        try {
            await configureDecoder(meta, state.streamFormat, null);
            hubDiag("info", `Codec Type A ${meta.codecId || "h264"} ${meta.width}x${meta.height}`, "video");
            flushQueue();
        } catch (err) {
            hubDiag("error", `Init décodeur Type A : ${err?.message || err}`, "video");
            console.error(`[SessionView ${tabId}] Echec init decodeur:`, err);
        } finally {
            state.decoderInitializing = false;
        }
    }

    window.videoAPI.onVideoCodecMeta((eventData) => {
        if (eventData.tabId !== tabId) return;
        initDecoder(eventData).catch((err) => {
            console.error(`[SessionView ${tabId}] Erreur init decodeur:`, err);
        });
    });

    window.videoAPI.onVideoPacket((eventData) => {
        if (eventData.tabId !== tabId) return;
        if (!state.decoderReady || !state.decoder || state.decoder.state === "closed" || state.decoderInitializing) {
            enqueuePacket(eventData);
            return;
        }
        decodePacket(eventData);
    });

    window.videoAPI.onVideoError((eventData) => {
        if (eventData.tabId !== tabId) return;
        if (eventData.codecFallback) return;
        console.error(`[SessionView ${tabId}] Erreur stream:`, eventData.error);
    });

    function resetDecoderState({ softCut = false } = {}) {
        framePresenter.cancel();
        if (state.decoder && state.decoder.state !== "closed") {
            state.decoder.close();
        }
        state.decoder = null;
        state.decoderReady = false;
        state.decoderInitializing = false;
        state.codecMeta = null;
        state.pendingConfigData = null;
        state.packetQueue.length = 0;
        state.streamFormat = "annexb";
        state.configuredStreamFormat = null;
        state.firstPts = null;
        state.lastTimestampUs = -1;
        state.syntheticTimestampUs = 0;
        // Soft cut USB↔WiFi : garder frameCount + pixels canvas (pas de trou noir).
        if (!softCut) {
            state.frameCount = 0;
        }
        state.softCutHolding = Boolean(softCut);
    }

    if (window.videoAPI.onStreamRestarting) {
        window.videoAPI.onStreamRestarting((data) => {
            if (data?.sessionId !== tabId) return;
            const generation = Number(data?.generation);
            if (Number.isFinite(generation) && generation === state._restartGeneration) {
                return;
            }
            if (Number.isFinite(generation)
                && Number.isFinite(state._restartGeneration)
                && generation < state._restartGeneration) {
                return;
            }
            // Soft cut : ferme le décodeur mais fige la dernière image sur le canvas.
            resetDecoderState({ softCut: true });
            if (Number.isFinite(generation)) {
                state._restartGeneration = generation;
            }
            console.log(`[SessionView ${tabId}] soft-cut hold (stream-restarting)`);
        });
    }

    return {
        getFrameCount() {
            return state.frameCount;
        },
        capturePreviewFrame(quality = 0.55) {
            if (state.frameCount === 0) return null;
            return captureSessionPreviewJpeg(canvasElement, quality);
        }
    };
}

function initTypeBVideoPipeline(sessionIdParam, canvasElement) {
    const ctx = canvasElement.getContext("2d");
    const framePresenter = createVideoFramePresenter(ctx, canvasElement, sessionIdParam);
    const state = {
        started: false,
        decoder: null,
        decoderReady: false,
        pendingConfig: null,
        frameCount: 0,
        queue: [],
        firstPts: null,
        lastTs: -1,
        format: "annexb"
    };

    function normalizeBinary(data) {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
        return null;
    }

    function detectH264Format(configData) {
        if (!configData || configData.length < 4) return "annexb";
        if (configData[0] === 0x01) return "avc";
        return "annexb";
    }

    function toTs(rawPts) {
        if (rawPts === undefined || rawPts === null) {
            state.lastTs = state.lastTs + 16667;
            return state.lastTs;
        }
        try {
            const pts = BigInt(rawPts);
            if (state.firstPts === null) state.firstPts = pts;
            let delta = pts - state.firstPts;
            if (delta < 0n) delta = 0n;
            const ts = Number(delta);
            if (!Number.isFinite(ts) || ts <= state.lastTs) {
                state.lastTs = state.lastTs + 1;
                return state.lastTs;
            }
            state.lastTs = ts;
            return ts;
        } catch (_err) {
            state.lastTs = state.lastTs + 16667;
            return state.lastTs;
        }
    }

    async function initDecoder(meta) {
        if (state.decoderReady || state.decoder) return;
        // Soft cut : ne pas réassigner width/height si identiques (sinon clear canvas).
        if (canvasElement.width !== meta.width || canvasElement.height !== meta.height) {
            canvasElement.width = meta.width;
            canvasElement.height = meta.height;
        }
        state.softCutHolding = false;
        const decoderConfig = {
            codec: meta.codecId === "h265" || meta.codecId === "hevc" ? "hev1.1.6.L93.B0" : "avc1.640034",
            codedWidth: meta.width,
            codedHeight: meta.height,
            optimizeForLatency: true
        };
        if (meta.codecId === "h264") {
            decoderConfig.avc = { format: state.format };
            if (state.format === "avc" && state.pendingConfig) {
                decoderConfig.description = state.pendingConfig;
            }
        }
        state.decoder = new VideoDecoder({
            output: (frame) => {
                framePresenter.schedule(frame);
                state.frameCount += 1;
            },
            error: (err) => {
                console.error(`[SessionView ${sessionIdParam}] Erreur decodeur:`, err);
            }
        });
        state.decoder.configure(decoderConfig);
        state.decoderReady = true;
        hubDiag("info", `Codec Type B ${meta.codecId || "h264"} ${meta.width}x${meta.height}`, "video");
        flushQueue();
    }

    function decodePacket(packet) {
        if (!state.decoder || !state.decoderReady || state.decoder.state === "closed") return;
        try {
            if (packet.isConfig) {
                const cfg = normalizeBinary(packet.data);
                if (cfg && cfg.length > 0) {
                    state.pendingConfig = cfg;
                    const detectedFormat = detectH264Format(cfg);
                    if (detectedFormat !== state.format) {
                        state.format = detectedFormat;
                        framePresenter.cancel();
                        if (state.decoder && state.decoder.state !== "closed") state.decoder.close();
                        state.decoder = null;
                        state.decoderReady = false;
                    }
                }
                return;
            }
            const payload = normalizeBinary(packet.data);
            if (!payload || payload.length === 0) return;
            let chunkData = payload;
            if (state.format === "annexb" && packet.isKeyFrame && state.pendingConfig) {
                const merged = new Uint8Array(state.pendingConfig.length + payload.length);
                merged.set(state.pendingConfig, 0);
                merged.set(payload, state.pendingConfig.length);
                chunkData = merged;
                state.pendingConfig = null;
            }
            const chunk = new EncodedVideoChunk({
                type: packet.isKeyFrame ? "key" : "delta",
                timestamp: toTs(packet.pts),
                data: chunkData
            });
            state.decoder.decode(chunk);
        } catch (err) {
            console.error(`[SessionView ${sessionIdParam}] Erreur decode packet:`, err);
        }
    }

    function flushQueue() {
        while (state.queue.length > 0 && state.decoderReady && state.decoder && state.decoder.state !== "closed") {
            decodePacket(state.queue.shift());
        }
    }

    window.videoAPI.onNewInstanceVideoCodecMeta((data) => {
        if (!data || data.sessionId !== sessionIdParam) return;
        initDecoder(data).catch((err) => {
            console.error(`[SessionView ${sessionIdParam}] Erreur init decodeur:`, err);
        });
    });

    window.videoAPI.onNewInstanceVideoPacket((data) => {
        if (!data || data.sessionId !== sessionIdParam) return;
        if (!state.decoderReady || !state.decoder || state.decoder.state === "closed") {
            state.queue.push(data);
            if (state.queue.length > MAX_VIDEO_PACKET_QUEUE) state.queue.shift();
            return;
        }
        decodePacket(data);
    });

    window.videoAPI.onNewInstanceVideoError((data) => {
        if (!data || data.sessionId !== sessionIdParam) return;
        if (data.codecFallback) return;
        console.error(`[SessionView ${sessionIdParam}] Erreur stream:`, data.error);
    });

    function resetDecoderState({ softCut = false } = {}) {
        framePresenter.cancel();
        if (state.decoder && state.decoder.state !== "closed") {
            state.decoder.close();
        }
        state.decoder = null;
        state.decoderReady = false;
        state.pendingConfig = null;
        state.queue.length = 0;
        state.firstPts = null;
        state.lastTs = -1;
        state.format = "annexb";
        state.started = false;
        // Soft cut : ne pas reset transforms / frameCount — dernière image reste visible.
        if (!softCut) {
            state.frameCount = 0;
            typeBPortraitStreamCorrection.set(sessionIdParam, false);
            try {
                const ctx = canvasElement.getContext("2d");
                ctx?.setTransform?.(1, 0, 0, 1, 0, 0);
                canvasElement.style.transform = "";
                canvasElement.style.margin = "";
                canvasElement.classList.remove("portrait-interim");
            } catch (_err) {
                // noop
            }
        }
        state.softCutHolding = Boolean(softCut);
    }

    if (window.videoAPI.onStreamRestarting) {
        window.videoAPI.onStreamRestarting((data) => {
            if (data?.sessionId !== sessionIdParam) return;
            const generation = Number(data?.generation);
            // Doublon / IPC en retard de la MÊME bascule — ne pas re-reset après replay.
            if (Number.isFinite(generation) && generation === state._restartGeneration) {
                console.warn(`[SessionView ${sessionIdParam}] stream-restarting doublon ignoré gen=${generation}`);
                return;
            }
            // Message périmé d'une bascule antérieure.
            if (Number.isFinite(generation)
                && Number.isFinite(state._restartGeneration)
                && generation < state._restartGeneration) {
                console.warn(`[SessionView ${sessionIdParam}] stream-restarting périmé ignoré gen=${generation}`);
                return;
            }
            resetDecoderState({ softCut: true });
            if (Number.isFinite(generation)) {
                state._restartGeneration = generation;
            }
            console.log(`[SessionView ${sessionIdParam}] soft-cut hold (stream-restarting)`);
        });
    }

    return {
        getFrameCount() {
            return state.frameCount;
        },
        capturePreviewFrame(quality = 0.55) {
            if (state.frameCount === 0) return null;
            return captureSessionPreviewJpeg(canvasElement, quality);
        }
    };
}

function initTypeAInputHandlers(canvasEl, tabId, serial, orientation = "landscape") {
    if (!canvasEl || !tabId) {
        console.warn(`[SessionView ${tabId}] input Type A ignoré — canvas ou tabId manquant`);
        return;
    }

    let captureOrientation = orientation === "landscape" ? "landscape" : "portrait";

    window.videoAPI?.onOrientationChanged?.((data) => {
        if (data?.sessionId !== tabId) return;
        captureOrientation = data.orientation === "landscape" ? "landscape" : "portrait";
    });

    let resolvedSerial = serial || "";

    async function ensureDeviceId() {
        if (resolvedSerial) return resolvedSerial;
        if (!window.videoAPI?.getInputContext) return "";
        try {
            const ctx = await window.videoAPI.getInputContext(tabId);
            if (ctx?.success && ctx.deviceId) {
                resolvedSerial = ctx.deviceId;
            }
        } catch (err) {
            console.warn(`[SessionView ${tabId}] deviceId:`, err?.message || err);
        }
        return resolvedSerial;
    }

    const { inputActivation } = createCanvasPointerHandlers(
        canvasEl,
        tabId,
        async (action, coords) => {
            const deviceId = await ensureDeviceId();
            if (!deviceId) {
                console.warn(`[SessionView ${tabId}] touch ignoré — deviceId manquant`);
                return;
            }
            try {
                const result = await window.videoAPI.sendInput({
                    tabId,
                    sessionId: tabId,
                    deviceId,
                    type: "touch",
                    action,
                    x: coords.streamX,
                    y: coords.streamY,
                    isStreamPixel: true,
                    orientation: resolveTouchOrientationForSession(tabId, captureOrientation),
                    streamWidth: coords.canvasWidth,
                    streamHeight: coords.canvasHeight
                });
                if (result && result.success === false) {
                    throw new Error(result.error || "Echec envoi touch");
                }
            } catch (err) {
                console.warn(`[SessionView ${tabId}] touch:`, err?.message || err);
            }
        },
        () => { void ensureDeviceId(); }
    );

    async function onKeyDown(event) {
        const key = resolveSessionKeyFromEvent(event);
        if (!key) return;
        event.preventDefault();
        event.stopPropagation();
        const deviceId = await ensureDeviceId();
        if (!deviceId) return;
        try {
            await window.videoAPI.sendInput({ tabId, sessionId: tabId, deviceId, type: "key", key });
        } catch (err) {
            console.warn(`[SessionView ${tabId}] key:`, err?.message || err);
        }
    }

    canvasEl.addEventListener("keydown", onKeyDown);
    canvasEl.addEventListener("click", () => inputActivation?.focusCanvas?.() ?? canvasEl.focus());
    attachRightClickBackHandler(canvasEl, async () => {
        if (window.videoAPI?.activateSession) {
            void window.videoAPI.activateSession(tabId);
        }
        const deviceId = await ensureDeviceId();
        if (!deviceId) return;
        return window.videoAPI.sendInput({ tabId, sessionId: tabId, deviceId, type: "key", key: "Back" });
    });
    inputActivation?.focusCanvas?.();
}

function initTypeBInputHandlers(canvasEl, sessionIdParam) {
    if (!canvasEl || !sessionIdParam) return;

    let resolvedDeviceId = deviceId || "";

    async function ensureDeviceId() {
        if (resolvedDeviceId) return resolvedDeviceId;
        if (!window.videoAPI?.getInputContext) return "";
        try {
            const ctx = await window.videoAPI.getInputContext(sessionIdParam);
            if (ctx?.success && ctx.deviceId) {
                resolvedDeviceId = ctx.deviceId;
            }
        } catch (err) {
            console.warn(`[SessionView ${sessionIdParam}] deviceId:`, err?.message || err);
        }
        return resolvedDeviceId;
    }

    const { inputActivation } = createCanvasPointerHandlers(
        canvasEl,
        sessionIdParam,
        async (action, coords) => {
            const devId = await ensureDeviceId();
            const result = await window.videoAPI.sendInput({
                sessionId: sessionIdParam,
                tabId: sessionIdParam,
                deviceId: devId || undefined,
                type: "touch",
                action,
                x: coords.streamX,
                y: coords.streamY,
                isStreamPixel: true,
                streamWidth: coords.canvasWidth,
                streamHeight: coords.canvasHeight
            });
            if (result && result.success === false) {
                throw new Error(result.error || "Echec envoi touch");
            }
        },
        () => { void ensureDeviceId(); },
        { remapCoords: false }
    );

    async function onKeyDown(event) {
        const key = resolveSessionKeyFromEvent(event);
        if (!key) return;
        event.preventDefault();
        event.stopPropagation();
        const devId = await ensureDeviceId();
        try {
            const result = await window.videoAPI.sendInput({
                sessionId: sessionIdParam,
                tabId: sessionIdParam,
                deviceId: devId || undefined,
                type: "key",
                key
            });
            if (result && result.success === false) {
                console.warn(`[SessionView ${sessionIdParam}] Erreur input key:`, result.error);
            }
        } catch (err) {
            console.warn(`[SessionView ${sessionIdParam}] Erreur input key:`, err?.message || err);
        }
    }

    canvasEl.addEventListener("keydown", onKeyDown);
    canvasEl.addEventListener("click", () => inputActivation?.focusCanvas?.() ?? canvasEl.focus());
    attachRightClickBackHandler(canvasEl, async () => {
        if (window.videoAPI?.activateSession) {
            void window.videoAPI.activateSession(sessionIdParam);
        }
        const devId = await ensureDeviceId();
        try {
            const result = await window.videoAPI.sendInput({
                sessionId: sessionIdParam,
                tabId: sessionIdParam,
                deviceId: devId || undefined,
                type: "key",
                key: "Back"
            });
            if (result && result.success === false) {
                console.warn(`[SessionView ${sessionIdParam}] Erreur input Back (clic droit):`, result.error);
            }
        } catch (err) {
            console.warn(`[SessionView ${sessionIdParam}] Erreur input Back (clic droit):`, err?.message || err);
        }
    });
    inputActivation?.focusCanvas?.();
}

async function resolveSessionDeviceId(fallbackDeviceId) {
    if (fallbackDeviceId) return fallbackDeviceId;
    if (!sessionId || !window.videoAPI?.getInputContext) return "";

    try {
        const ctx = await window.videoAPI.getInputContext(sessionId);
        if (ctx?.success && ctx.deviceId) {
            return ctx.deviceId;
        }
    } catch (err) {
        console.warn(`[SessionView ${sessionId}] lecture deviceId:`, err?.message || err);
    }
    return "";
}

function bindYumeRendererPref() {
    if (!canvas || window.__yumeVideoSink) return;
    window.__yumeVideoSink = createYumeVideoSink(canvas);
    hubDiag(
        "info",
        `Session ${sessionViewType} — MediaStreamTrackGenerator=${isYumeRendererSupported() ? "oui" : "non"}`
    );
    const apply = (prefs) => {
        window.__yumeVideoSink.setEnabled(prefs?.experimentalYumeRenderer === true);
    };
    if (window.videoAPI?.getPerformancePrefs) {
        window.videoAPI.getPerformancePrefs().then(apply).catch(() => apply({}));
    }
    window.videoAPI?.onPerformanceChanged?.((payload) => apply(payload?.performance));
}

async function bootstrapSessionView() {
    const sessionType = type ? String(type).toUpperCase() : "";

    if (!sessionId || !sessionType) {
        console.error("[SessionView] sessionId ou type manquant dans query string");
        return;
    }

    bindYumeRendererPref();

    if (sessionType === "B") {
        setPortraitDisplay(sessionId, false);
        document.documentElement.dataset.portraitDisplay = "0";
        window.__sessionVideoHandle = initTypeBVideoPipeline(sessionId, canvas);
        initTypeBInputHandlers(canvas, sessionId);
        if (typeof attachCanvasWheelZoom === "function") {
            attachCanvasWheelZoom(canvas, sessionId);
        }
        window.__yumeVideoSink?.attach?.();
        if (canvas) canvas.focus();
        if (!window.__sessionInputReady) {
            window.__sessionInputReady = true;
        }
        return;
    }

    const resolvedDeviceId = await resolveSessionDeviceId(deviceId);
    const initialOrientation = params.get("orientation") || "landscape";
    initSessionDisplayOrientation(sessionId, initialOrientation);
    window.__sessionVideoHandle = initTypeAVideoPlayer(sessionId, canvas);
    initTypeAInputHandlers(canvas, sessionId, resolvedDeviceId, initialOrientation);
    if (typeof attachCanvasWheelZoom === "function") {
        attachCanvasWheelZoom(canvas, sessionId);
    }
    window.__yumeVideoSink?.attach?.();
    if (canvas) canvas.focus();

    if (!window.__sessionInputReady) {
        window.__sessionInputReady = true;
    }
}

bootstrapSessionView();
