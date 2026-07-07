(function initStreamDeckDuoCollapse() {
    const BAR_ID = "stream-deck-bar";
    const POPUP_HEIGHT = 132;

    let duoPopupOpen = false;

    function st(key, vars) {
        return globalThis.HubI18n?.t(key, vars) ?? key;
    }

    function getBar() {
        return document.getElementById(BAR_ID);
    }

    function isPopupApplicable() {
        return window.getStreamDeckMode?.() === true
            && (window.getDisplayLayout?.() || "grid") === "duo";
    }

    function buildPopupLabels() {
        return {
            panelTitle: st("streamDeck.duo.panelTitle"),
            slot1: st("streamDeck.duo.slot1"),
            slot2: st("streamDeck.duo.slot2"),
            pick: st("streamDeck.duo.pick"),
            disconnected: st("streamDeck.duo.disconnected")
        };
    }

    async function buildPopupPayload() {
        const bar = getBar();
        const slots = window.getDuoDeviceIds?.() || [null, null];
        const sessions = window.sessionAPI?.list ? await window.sessionAPI.list() : [];

        let clientX = 0;
        let clientY = 0;
        let width = 240;

        if (bar) {
            const rect = bar.getBoundingClientRect();
            clientX = Math.round(rect.left);
            clientY = Math.round(rect.bottom + 6);
            width = Math.round(rect.width);
        }

        return {
            clientX,
            clientY,
            width,
            height: POPUP_HEIGHT,
            slots,
            sessions: sessions.map((session) => ({
                sessionId: session.sessionId,
                label: session.label || session.sessionId
            })),
            labels: buildPopupLabels()
        };
    }

    async function showOverlayPopup() {
        if (!window.duoPopupAPI?.open) return false;
        const payload = await buildPopupPayload();
        await window.duoPopupAPI.open(payload);
        return true;
    }

    async function refreshOverlayPopup() {
        if (!duoPopupOpen || !window.duoPopupAPI?.update) return;
        await window.duoPopupAPI.update(await buildPopupPayload());
    }

    function hideOverlayPopup() {
        window.duoPopupAPI?.hide?.();
    }

    function applyDuoPopupOpen(open, options = {}) {
        const { syncLayout = false } = options;
        duoPopupOpen = Boolean(open);

        if (duoPopupOpen && isPopupApplicable()) {
            void showOverlayPopup();
        } else {
            duoPopupOpen = false;
            hideOverlayPopup();
        }

        if (syncLayout && typeof window.reportContentBounds === "function") {
            void window.reportContentBounds();
        }
    }

    function toggleDuoPopup(options = {}) {
        if (!isPopupApplicable()) return;
        applyDuoPopupOpen(!duoPopupOpen, options);
    }

    function closeOnOutsideClick(event) {
        if (!duoPopupOpen) return;

        const bar = getBar();
        const target = event.target;
        if (bar?.contains(target)) return;

        applyDuoPopupOpen(false);
    }

    function bindOutsideClick() {
        if (document.body.dataset.streamDeckDuoPopupBound === "1") return;
        document.body.dataset.streamDeckDuoPopupBound = "1";
        document.addEventListener("mousedown", closeOnOutsideClick);
    }

    function bindPopupEvents() {
        window.duoPopupAPI?.onSlotsChanged?.((slots) => {
            if (!Array.isArray(slots)) return;
            window.setDuoDeviceIds?.(slots);
            void refreshOverlayPopup();
            if (typeof window.refreshStreamDeckZone === "function") {
                void window.refreshStreamDeckZone();
            }
        });

        window.duoPopupAPI?.onClosed?.(() => {
            duoPopupOpen = false;
        });
    }

    function bindReposition() {
        if (window.__streamDeckDuoPopupRepositionBound) return;
        window.__streamDeckDuoPopupRepositionBound = true;

        window.addEventListener("resize", () => {
            if (duoPopupOpen) void refreshOverlayPopup();
        });

        const bar = getBar();
        if (bar && typeof ResizeObserver !== "undefined") {
            const observer = new ResizeObserver(() => {
                if (duoPopupOpen) void refreshOverlayPopup();
            });
            observer.observe(bar);
        }
    }

    function init() {
        bindOutsideClick();
        bindPopupEvents();
        bindReposition();
        applyDuoPopupOpen(false, { syncLayout: false });

        window.onDisplayLayoutChange?.(() => {
            if (!isPopupApplicable()) {
                duoPopupOpen = false;
                hideOverlayPopup();
            }
        });
    }

    window.getStreamDeckDuoPanelOpen = () => duoPopupOpen;
    window.setStreamDeckDuoPanelOpen = (open, options = {}) => applyDuoPopupOpen(open, options);
    window.toggleStreamDeckDuoPanel = toggleDuoPopup;
    window.refreshStreamDeckDuoPanelUi = () => {
        if (!isPopupApplicable()) {
            duoPopupOpen = false;
            hideOverlayPopup();
            return;
        }
        if (duoPopupOpen) {
            void refreshOverlayPopup();
        }
    };
    window.refreshStreamDeckDuoPopupContent = refreshOverlayPopup;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
