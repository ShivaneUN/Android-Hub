/**
 * Zoom molette sur le canvas de session (Type A + Type B).
 * Additif : transform CSS visuelle uniquement, n'altère pas le pipeline input/vidéo.
 */
(function initSessionWheelZoomModule() {
    const MIN_SCALE = 1;
    const MAX_SCALE = 4;
    const ZOOM_STEP = 1.12;

    function ensureZoomViewport(canvasEl) {
        const parent = canvasEl.parentElement;
        if (parent?.dataset?.sessionZoomViewport === "1") {
            return parent;
        }

        const viewport = document.createElement("div");
        viewport.dataset.sessionZoomViewport = "1";
        viewport.className = "session-zoom-viewport";
        viewport.style.cssText = "width:100%;height:100%;overflow:hidden;position:relative;background:#000;";

        const host = canvasEl.parentNode;
        if (host) {
            host.insertBefore(viewport, canvasEl);
            viewport.appendChild(canvasEl);
        }

        canvasEl.style.transformOrigin = "0 0";
        return viewport;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    /**
     * @param {HTMLCanvasElement} canvasEl
     * @param {string} [sessionIdParam]
     */
    function attachCanvasWheelZoom(canvasEl, sessionIdParam) {
        if (!canvasEl || canvasEl.dataset.wheelZoomAttached === "1") {
            return null;
        }

        canvasEl.dataset.wheelZoomAttached = "1";

        const viewport = ensureZoomViewport(canvasEl);
        const state = {
            scale: 1,
            translateX: 0,
            translateY: 0
        };

        function applyTransform() {
            const portraitMode = document.documentElement.dataset.portraitDisplay === "1";
            if (portraitMode && state.scale <= MIN_SCALE) {
                canvasEl.style.transform = "";
                return;
            }
            canvasEl.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
        }

        function clampTranslation() {
            if (state.scale <= MIN_SCALE) {
                state.translateX = 0;
                state.translateY = 0;
                return;
            }

            const vw = viewport.clientWidth;
            const vh = viewport.clientHeight;
            if (vw <= 0 || vh <= 0) return;

            const scaledW = vw * state.scale;
            const scaledH = vh * state.scale;
            const minX = vw - scaledW;
            const minY = vh - scaledH;

            state.translateX = clamp(state.translateX, minX, 0);
            state.translateY = clamp(state.translateY, minY, 0);
        }

        function resetZoom() {
            state.scale = 1;
            state.translateX = 0;
            state.translateY = 0;
            applyTransform();
        }

        function zoomAt(clientX, clientY, zoomIn) {
            const rect = viewport.getBoundingClientRect();
            const pointerX = clientX - rect.left;
            const pointerY = clientY - rect.top;

            const factor = zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP;
            const nextScale = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
            if (nextScale === state.scale) return;

            const ratio = nextScale / state.scale;
            state.translateX = pointerX - ratio * (pointerX - state.translateX);
            state.translateY = pointerY - ratio * (pointerY - state.translateY);
            state.scale = nextScale;

            if (state.scale <= MIN_SCALE) {
                resetZoom();
                return;
            }

            clampTranslation();
            applyTransform();
        }

        canvasEl.addEventListener("wheel", (event) => {
            event.preventDefault();
            event.stopPropagation();
            zoomAt(event.clientX, event.clientY, event.deltaY < 0);
        }, { passive: false });

        const handle = {
            reset: resetZoom,
            getScale: () => state.scale
        };

        if (sessionIdParam) {
            window.__sessionWheelZoom = window.__sessionWheelZoom || {};
            window.__sessionWheelZoom[sessionIdParam] = handle;
        }

        return handle;
    }

    window.attachCanvasWheelZoom = attachCanvasWheelZoom;
})();
