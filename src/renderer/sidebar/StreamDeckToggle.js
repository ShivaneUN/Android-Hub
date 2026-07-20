(function initStreamDeckToggle() {
    const TOGGLE_ID = "nav-toggle-stream-deck";
    const SIDEBAR_ID = "sidebar";

    function st(key, vars) {
        return globalThis.HubI18n?.t(key, vars) ?? key;
    }

    function getButton() {
        return document.getElementById(TOGGLE_ID);
    }

    function updateToggleUi() {
        const btn = getButton();
        if (!btn) return;

        const active = window.getStreamDeckMode?.() === true;
        btn.classList.toggle("stream-deck-toggle-on", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        if (!active) btn.classList.remove("active");
        btn.title = st("streamDeck.toggleTitle");
        btn.setAttribute("data-i18n-title", "streamDeck.toggleTitle");
    }

    function onToggleClick(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        if (typeof window.toggleStreamDeckMode !== "function") {
            console.error("[StreamDeckToggle] toggleStreamDeckMode unavailable");
            return;
        }

        document.querySelectorAll(".sidebar-item").forEach((el) => {
            if (el.id !== TOGGLE_ID) el.classList.remove("active");
        });

        const willEnable = window.getStreamDeckMode?.() !== true;
        if (willEnable) {
            getButton()?.classList.add("active");
        } else {
            getButton()?.classList.remove("active");
        }

        window.toggleStreamDeckMode();

        updateToggleUi();

        if (typeof window.reportContentBounds === "function") {
            void window.reportContentBounds();
        }

        if (typeof window.refreshStreamDeckBar === "function") {
            window.refreshStreamDeckBar();
        }
    }

    function bindToggleButton() {
        const sidebar = document.getElementById(SIDEBAR_ID);
        if (!sidebar || sidebar.dataset.streamDeckToggleBound === "1") return;
        sidebar.dataset.streamDeckToggleBound = "1";

        document.addEventListener("click", (event) => {
            const btn = event.target.closest(`#${TOGGLE_ID}`);
            if (!btn) return;
            onToggleClick(event);
        });
    }

    function init() {
        bindToggleButton();
        updateToggleUi();

        window.onDisplayLayoutChange?.(() => {
            updateToggleUi();
        });

        globalThis.HubI18n?.onChange?.(() => updateToggleUi());
    }

    window.updateStreamDeckToggle = updateToggleUi;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
