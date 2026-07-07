(function initStreamDeckBar() {
    const RAIL_ID = "stream-deck-tabs-rail";
    const BAR_ID = "stream-deck-bar";
    const LAYOUTS = [
        { id: "grid", icon: "grid", labelKey: "streamDeck.layout.grid" },
        { id: "focus", icon: "focus", labelKey: "streamDeck.layout.focus" },
        { id: "duo", icon: "duo", labelKey: "streamDeck.layout.duo" }
    ];

    function st(key, vars) {
        return globalThis.HubI18n?.t(key, vars) ?? key;
    }

    function isTypingTarget(element) {
        if (!element) return false;
        const tag = element.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        return element.isContentEditable;
    }

    function layoutIconSvg(icon) {
        if (icon === "focus") {
            return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="13" height="16" rx="2"/><rect x="18" y="6" width="3" height="5" rx="1"/><rect x="18" y="13" width="3" height="5" rx="1"/></svg>`;
        }
        if (icon === "duo") {
            return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="8" height="14" rx="2"/><rect x="13" y="5" width="8" height="14" rx="2"/></svg>`;
        }
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>`;
    }

    function getRail() {
        return document.getElementById(RAIL_ID);
    }

    function getBar() {
        return document.getElementById(BAR_ID);
    }

    function updateChromeVisibility() {
        const streamDeckOn = window.getStreamDeckMode?.() === true;
        const rail = getRail();

        if (rail) {
            rail.classList.toggle("hidden", !streamDeckOn);
            rail.setAttribute("aria-hidden", streamDeckOn ? "false" : "true");
        }

        if (typeof window.refreshStreamDeckDuoPanelUi === "function") {
            window.refreshStreamDeckDuoPanelUi();
        }
    }

    function updateActiveButtons() {
        const bar = getBar();
        if (!bar) return;
        const layout = window.getDisplayLayout?.() || "grid";
        bar.querySelectorAll("[data-layout-id]").forEach((btn) => {
            btn.classList.toggle("is-active", btn.dataset.layoutId === layout);
        });
        updateChromeVisibility();
    }

    async function refreshDuoSelectors() {
        const layout = window.getDisplayLayout?.() || "grid";
        if (layout !== "duo" || window.getStreamDeckMode?.() !== true) return;

        if (typeof window.refreshStreamDeckDuoPopupContent === "function") {
            await window.refreshStreamDeckDuoPopupContent();
        }
    }

    function renderBar() {
        const bar = getBar();
        if (!bar || bar.dataset.rendered === "1") return;
        bar.dataset.rendered = "1";

        const buttonsHtml = LAYOUTS.map((layout) => `
            <button type="button"
                    class="stream-deck-layout-btn"
                    data-layout-id="${layout.id}"
                    data-i18n-title="${layout.labelKey}"
                    title="${st(layout.labelKey)}">
                <span class="stream-deck-layout-icon">${layoutIconSvg(layout.icon)}</span>
                <span class="stream-deck-layout-label" data-i18n="${layout.labelKey}">${st(layout.labelKey)}</span>
            </button>
        `).join("");

        bar.innerHTML = `<div class="stream-deck-layout-group">${buttonsHtml}</div>`;

        bar.addEventListener("click", (event) => {
            const btn = event.target.closest("[data-layout-id]");
            if (!btn) return;

            const nextLayout = btn.dataset.layoutId;
            const currentLayout = window.getDisplayLayout?.() || "grid";

            if (nextLayout === "duo" && currentLayout === "duo") {
                window.toggleStreamDeckDuoPanel?.();
                return;
            }

            window.setDisplayLayout?.(nextLayout);
            updateActiveButtons();
            void refreshDuoSelectors();

            if (nextLayout === "duo") {
                window.setStreamDeckDuoPanelOpen?.(true);
            }

            if (typeof window.reportContentBounds === "function") {
                void window.reportContentBounds();
            }
        });
    }

    function bindKeyboardShortcut() {
        if (document.body.dataset.streamDeckKeys === "1") return;
        document.body.dataset.streamDeckKeys = "1";

        document.addEventListener("keydown", (event) => {
            if (!window.getStreamDeckMode?.()) return;
            if (!event.ctrlKey && !event.metaKey) return;
            if (!event.shiftKey) return;
            if (event.key.toLowerCase() !== "l") return;
            if (isTypingTarget(document.activeElement)) return;

            event.preventDefault();
            const prev = window.getDisplayLayout?.() || "grid";
            window.cycleDisplayLayout?.("next");
            const next = window.getDisplayLayout?.() || "grid";
            if (next === "duo" && prev !== "duo") {
                window.setStreamDeckDuoPanelOpen?.(true);
            }
        });
    }

    function bindLocaleRefresh() {
        globalThis.HubI18n?.onChange?.(() => {
            updateActiveButtons();
            void refreshDuoSelectors();
        });
    }

    function init() {
        renderBar();
        bindKeyboardShortcut();
        bindLocaleRefresh();
        updateActiveButtons();

        window.onDisplayLayoutChange?.(() => {
            const layout = window.getDisplayLayout?.() || "grid";
            updateActiveButtons();
            void refreshDuoSelectors();

            if (layout !== "duo") {
                window.setStreamDeckDuoPanelOpen?.(false, { syncLayout: false });
            }

            if (typeof window.reportContentBounds === "function") {
                void window.reportContentBounds();
            }
        });

        if (window.sessionAPI?.onSessionListChanged) {
            window.sessionAPI.onSessionListChanged(() => {
                void refreshDuoSelectors();
            });
        }
    }

    window.refreshStreamDeckBar = () => {
        updateActiveButtons();
        void refreshDuoSelectors();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
