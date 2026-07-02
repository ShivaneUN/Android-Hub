const inputControllers = new Map();

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

function normalizePointerPosition(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    const localX = typeof event.offsetX === "number" ? event.offsetX : event.clientX - rect.left;
    const localY = typeof event.offsetY === "number" ? event.offsetY : event.clientY - rect.top;

    const renderedWidth = rect.width;
    const renderedHeight = rect.height;
    const normalizedX = localX / renderedWidth;
    const normalizedY = localY / renderedHeight;
    const streamX = Math.round(localX * (canvas.width / renderedWidth));
    const streamY = Math.round(localY * (canvas.height / renderedHeight));

    return {
        x: Math.min(Math.max(normalizedX, 0), 1),
        y: Math.min(Math.max(normalizedY, 0), 1),
        streamX: Math.min(Math.max(streamX, 0), canvas.width - 1),
        streamY: Math.min(Math.max(streamY, 0), canvas.height - 1),
        offsetX: localX,
        offsetY: localY,
        renderedWidth,
        renderedHeight,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height
    };
}

async function sendTouchAction(canvas, tabId, deviceId, event, orientation, action) {
    const coords = normalizePointerPosition(canvas, event);
    console.log(`[Input] sendTouchAction action=${action} normalized x=${coords.x.toFixed(3)} y=${coords.y.toFixed(3)} orientation=${orientation} ` +
        `canvas=${coords.canvasWidth}x${coords.canvasHeight} rendered=${coords.renderedWidth}x${coords.renderedHeight}`);
    await window.electronAPI.sendInput({
        tabId,
        deviceId,
        type: "touch",
        action,
        x: coords.streamX,
        y: coords.streamY,
        isStreamPixel: true,
        orientation,
        streamWidth: coords.canvasWidth,
        streamHeight: coords.canvasHeight
    });
}

function installInputHandlers(canvas, tabId, deviceId, orientation = "portrait") {
    if (!canvas || !tabId || !deviceId) return;
    if (inputControllers.has(tabId)) return;

    let isDragging = false;
    let activePointerId = null;
    let lastMoveSentAt = 0;
    let lastSentCoords = null;
    let pendingInput = Promise.resolve();

    function queueTouchAction(event, action) {
        pendingInput = pendingInput
            .catch(() => undefined)
            .then(() => sendTouchAction(canvas, tabId, deviceId, event, orientation, action));
        return pendingInput;
    }

    function clearPointerListeners() {
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
    }

    function onPointerDown(event) {
        if (event.pointerType !== "mouse" && event.pointerType !== "touch" && event.pointerType !== "pen") return;
        if (event.button !== 0) return;
        event.preventDefault();
        isDragging = true;
        activePointerId = event.pointerId;
        lastMoveSentAt = 0;
        lastSentCoords = normalizePointerPosition(canvas, event);
        if (canvas.setPointerCapture) {
            canvas.setPointerCapture(event.pointerId);
        }
        canvas.focus();
        canvas.addEventListener("pointermove", onPointerMove, { passive: false });
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointercancel", onPointerCancel);
        queueTouchAction(event, "down").catch(err => {
            console.error(`[Input ${tabId}] Erreur touch down:`, err);
        });
    }

    async function onPointerUp(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        if (canvas.releasePointerCapture) {
            canvas.releasePointerCapture(event.pointerId);
        }
        clearPointerListeners();
        await queueTouchAction(event, "up");
        lastSentCoords = null;
    }

    function onPointerMove(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        event.preventDefault();

        const now = Date.now();
        const coords = normalizePointerPosition(canvas, event);
        const movedEnough = !lastSentCoords || Math.abs(coords.streamX - lastSentCoords.streamX) >= 2 || Math.abs(coords.streamY - lastSentCoords.streamY) >= 2;
        if (!movedEnough && now - lastMoveSentAt < 16) {
            return;
        }

        lastMoveSentAt = now;
        lastSentCoords = coords;
        queueTouchAction(event, "move").catch(err => {
            console.error(`[Input ${tabId}] Erreur touch move:`, err);
        });
    }

    function onPointerCancel(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        clearPointerListeners();
        lastSentCoords = null;
    }

    async function onKeyDown(event) {
        if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA")) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
        if (key.length === 1 || KEYCODE_MAP[key]) {
            event.preventDefault();
            event.stopPropagation();
            await window.electronAPI.sendInput({
                tabId,
                deviceId,
                type: "key",
                key
            });
        }
    }

    const onClick = () => canvas.focus();

    canvas.tabIndex = 0;
    canvas.style.outline = "none";
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown);

    inputControllers.set(tabId, {
        canvas,
        listeners: { onPointerDown, onPointerUp, onPointerMove, onPointerCancel, onClick, onKeyDown },
        orientation
    });
}

function removeInputHandlers(tabId) {
    const controller = inputControllers.get(tabId);
    if (!controller) return;
    const { canvas, listeners } = controller;
    if (canvas) {
        canvas.removeEventListener("pointerdown", listeners.onPointerDown);
        canvas.removeEventListener("pointermove", listeners.onPointerMove);
        canvas.removeEventListener("pointerup", listeners.onPointerUp);
        canvas.removeEventListener("pointercancel", listeners.onPointerCancel);
        canvas.removeEventListener("click", listeners.onClick);
    }
    if (listeners.onKeyDown) window.removeEventListener("keydown", listeners.onKeyDown);
    inputControllers.delete(tabId);
}

window.installInputHandlers = installInputHandlers;
window.removeInputHandlers = removeInputHandlers;
