(function initSidebarCollapse() {
    const STORAGE_KEY = "androidHub.sidebarOpen";
    const SHELL_ID = "sidebar-shell";
    const TOGGLE_ID = "sidebar-collapse-btn";

    let sidebarOpen = true;

    function st(key, vars) {
        return globalThis.HubI18n?.t(key, vars) ?? key;
    }

    function isTypingTarget(element) {
        if (!element) return false;
        const tag = element.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        return element.isContentEditable;
    }

    function getShell() {
        return document.getElementById(SHELL_ID);
    }

    function getToggleButton() {
        return document.getElementById(TOGGLE_ID);
    }

    function readLocalSidebarOpen() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return true;
        return raw !== "false";
    }

    async function loadPersistedSidebarOpen() {
        if (window.uiPreferencesAPI?.getPreferences) {
            try {
                const prefs = await window.uiPreferencesAPI.getPreferences();
                if (prefs && typeof prefs.sidebarOpen === "boolean") {
                    return prefs.sidebarOpen;
                }
            } catch (err) {
                console.warn("[SidebarCollapse] getPreferences failed:", err);
            }
        }
        return readLocalSidebarOpen();
    }

    async function persistSidebarOpen(open) {
        localStorage.setItem(STORAGE_KEY, open ? "true" : "false");
        if (window.uiPreferencesAPI?.setSidebarOpen) {
            try {
                await window.uiPreferencesAPI.setSidebarOpen(open);
            } catch (err) {
                console.warn("[SidebarCollapse] setSidebarOpen failed:", err);
            }
        }
    }

    function updateToggleUi() {
        const shell = getShell();
        const btn = getToggleButton();
        if (!shell || !btn) return;

        shell.classList.toggle("is-collapsed", !sidebarOpen);
        btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
        btn.title = sidebarOpen ? st("sidebar.collapse") : st("sidebar.expand");
        btn.setAttribute("data-i18n-title", sidebarOpen ? "sidebar.collapse" : "sidebar.expand");
    }

    function syncLayoutAfterSidebarChange() {
        if (typeof window.layoutSidebarPanels === "function") {
            window.layoutSidebarPanels();
        }
        if (typeof window.reportContentBounds === "function") {
            void window.reportContentBounds();
        }
    }

    function applySidebarOpen(open, options = {}) {
        const { persist = false, syncLayout = true } = options;
        sidebarOpen = Boolean(open);
        updateToggleUi();

        if (persist) {
            void persistSidebarOpen(sidebarOpen);
        }

        if (syncLayout) {
            syncLayoutAfterSidebarChange();
        }
    }

    function toggleSidebar(options = {}) {
        applySidebarOpen(!sidebarOpen, { persist: true, syncLayout: false, ...options });
        syncLayoutAfterSidebarChange();
    }

    function bindToggleButton() {
        const btn = getToggleButton();
        if (!btn || btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", () => toggleSidebar());
    }

    function bindKeyboardShortcut() {
        if (document.body.dataset.sidebarCollapseKeys === "1") return;
        document.body.dataset.sidebarCollapseKeys = "1";

        document.addEventListener("keydown", (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            if (event.key.toLowerCase() !== "b") return;
            if (event.altKey) return;
            if (isTypingTarget(document.activeElement)) return;

            event.preventDefault();
            toggleSidebar();
        });
    }

    function bindTransitionEnd() {
        const shell = getShell();
        if (!shell || shell.dataset.transitionBound === "1") return;
        shell.dataset.transitionBound = "1";

        shell.addEventListener("transitionend", (event) => {
            if (event.propertyName !== "width") return;
            syncLayoutAfterSidebarChange();
        });
    }

    function bindLocaleRefresh() {
        globalThis.HubI18n?.onChange?.(() => updateToggleUi());
    }

    async function init() {
        bindToggleButton();
        bindKeyboardShortcut();
        bindTransitionEnd();
        bindLocaleRefresh();

        sidebarOpen = await loadPersistedSidebarOpen();
        document.documentElement.classList.remove("sidebar-initial-collapsed");
        applySidebarOpen(sidebarOpen, { persist: false, syncLayout: true });
    }

    window.getSidebarOpen = () => sidebarOpen;
    window.setSidebarOpen = (open, options = {}) => applySidebarOpen(open, { persist: true, ...options });
    window.toggleSidebar = toggleSidebar;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            void init();
        });
    } else {
        void init();
    }
})();
