/**
 * Hook de gestion de l'aperçu vidéo au survol.
 * Gère délai, positionnement, polling des frames et nettoyage.
 */
(function initUseVideoPreview() {
    const HOVER_DELAY_MS = 250;
    const FRAME_INTERVAL_MS = 200;
    const UNAVAILABLE_THRESHOLD = 3;
    const POSITION_MARGIN = 8;

    /** @type {ReturnType<typeof createVideoPreviewController> | null} */
    let sharedController = null;

    /**
     * @param {DOMRect} targetRect
     * @param {{ width: number, height: number }} size
     */
    function computePosition(targetRect, size) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const { width: w, height: h } = size;

        const candidates = [
            () => ({
                x: targetRect.left + (targetRect.width - w) / 2,
                y: targetRect.bottom + POSITION_MARGIN
            }),
            () => ({
                x: targetRect.left + (targetRect.width - w) / 2,
                y: targetRect.top - h - POSITION_MARGIN
            }),
            () => ({
                x: targetRect.left - w - POSITION_MARGIN,
                y: targetRect.top + (targetRect.height - h) / 2
            }),
            () => ({
                x: targetRect.right + POSITION_MARGIN,
                y: targetRect.top + (targetRect.height - h) / 2
            })
        ];

        for (const build of candidates) {
            const pos = build();
            const fitsX = pos.x >= POSITION_MARGIN && pos.x + w <= vw - POSITION_MARGIN;
            const fitsY = pos.y >= POSITION_MARGIN && pos.y + h <= vh - POSITION_MARGIN;
            if (fitsX && fitsY) {
                return {
                    x: Math.max(POSITION_MARGIN, Math.min(pos.x, vw - w - POSITION_MARGIN)),
                    y: Math.max(POSITION_MARGIN, Math.min(pos.y, vh - h - POSITION_MARGIN))
                };
            }
        }

        const fallback = candidates[0]();
        return {
            x: Math.max(POSITION_MARGIN, Math.min(fallback.x, vw - w - POSITION_MARGIN)),
            y: Math.max(POSITION_MARGIN, Math.min(fallback.y, vh - h - POSITION_MARGIN))
        };
    }

    function createVideoPreviewController() {
        /** @type {HTMLElement | null} */
        let activeTarget = null;
        /** @type {string | null} */
        let activeSessionId = null;
        /** @type {number | null} */
        let hoverTimer = null;
        /** @type {number | null} */
        let frameTimer = null;
        /** @type {(() => void) | null} */
        let onWindowChange = null;
        let failCount = 0;
        let fetching = false;

        const tooltip = window.VideoPreviewTooltip;

        function reposition() {
            if (!activeTarget || tooltip.getState() === "hidden") return;
            const rect = activeTarget.getBoundingClientRect();
            const pos = computePosition(rect, tooltip.getSize());
            tooltip.setPosition(pos.x, pos.y);
        }

        function stopFrameLoop() {
            if (frameTimer !== null) {
                clearInterval(frameTimer);
                frameTimer = null;
            }
            fetching = false;
            failCount = 0;
        }

        function detachWindowListeners() {
            if (onWindowChange) {
                window.removeEventListener("resize", onWindowChange);
                window.removeEventListener("scroll", onWindowChange, true);
                onWindowChange = null;
            }
        }

        function attachWindowListeners() {
            if (onWindowChange) return;
            onWindowChange = () => reposition();
            window.addEventListener("resize", onWindowChange);
            window.addEventListener("scroll", onWindowChange, true);
        }

        async function fetchFrame() {
            if (!activeSessionId || fetching || tooltip.getState() === "hidden") return;
            if (!window.sessionAPI?.getPreviewFrame) return;

            fetching = true;
            try {
                const result = await window.sessionAPI.getPreviewFrame(activeSessionId);
                if (activeSessionId === null || tooltip.getState() === "hidden") return;

                if (result?.available && result.dataUrl) {
                    failCount = 0;
                    tooltip.updateFrame(result.dataUrl);
                } else {
                    failCount += 1;
                    if (failCount >= UNAVAILABLE_THRESHOLD) {
                        tooltip.showUnavailable();
                    }
                }
            } catch (_err) {
                failCount += 1;
                if (failCount >= UNAVAILABLE_THRESHOLD) {
                    tooltip.showUnavailable();
                }
            } finally {
                fetching = false;
            }
        }

        function startFrameLoop() {
            stopFrameLoop();
            void fetchFrame();
            frameTimer = window.setInterval(() => {
                void fetchFrame();
            }, FRAME_INTERVAL_MS);
        }

        function hidePreview() {
            if (hoverTimer !== null) {
                clearTimeout(hoverTimer);
                hoverTimer = null;
            }
            stopFrameLoop();
            detachWindowListeners();
            activeTarget = null;
            activeSessionId = null;
            tooltip.hide();
        }

        /**
         * @param {HTMLElement} target
         * @param {string} sessionId
         */
        function showPreview(target, sessionId) {
            if (activeTarget === target && activeSessionId === sessionId && tooltip.getState() !== "hidden") {
                reposition();
                return;
            }

            hidePreview();
            activeTarget = target;
            activeSessionId = sessionId;

            const rect = target.getBoundingClientRect();
            const pos = computePosition(rect, tooltip.getSize());
            tooltip.setPosition(pos.x, pos.y);
            tooltip.showLoading();
            attachWindowListeners();
            startFrameLoop();
        }

        /**
         * @param {HTMLElement} element
         * @param {string} sessionId
         * @returns {() => void}
         */
        function attach(element, sessionId) {
            const onEnter = () => {
                if (window.HubPerformance && !window.HubPerformance.isEnabled("hoverPreview")) {
                    return;
                }
                if (hoverTimer !== null) clearTimeout(hoverTimer);
                hoverTimer = window.setTimeout(() => {
                    hoverTimer = null;
                    showPreview(element, sessionId);
                }, HOVER_DELAY_MS);
            };

            const onLeave = () => {
                if (hoverTimer !== null) {
                    clearTimeout(hoverTimer);
                    hoverTimer = null;
                }
                if (activeTarget === element) {
                    hidePreview();
                }
            };

            const onMove = () => {
                if (activeTarget === element && tooltip.getState() !== "hidden") {
                    reposition();
                }
            };

            element.addEventListener("mouseenter", onEnter);
            element.addEventListener("mouseleave", onLeave);
            element.addEventListener("mousemove", onMove);

            return () => {
                element.removeEventListener("mouseenter", onEnter);
                element.removeEventListener("mouseleave", onLeave);
                element.removeEventListener("mousemove", onMove);
                if (activeTarget === element) {
                    hidePreview();
                }
            };
        }

        function destroy() {
            hidePreview();
        }

        return { attach, hide: hidePreview, destroy };
    }

    /**
     * @returns {ReturnType<typeof createVideoPreviewController>}
     */
    function useVideoPreview() {
        if (!sharedController) {
            sharedController = createVideoPreviewController();
        }
        return sharedController;
    }

    window.useVideoPreview = useVideoPreview;
    window.videoPreviewHook = useVideoPreview();
})();
