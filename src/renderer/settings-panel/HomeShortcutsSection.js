(function initHomeShortcutsSection() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;
    let bound = false;

    function getChips() {
        return document.querySelectorAll("#home-shortcut-fab-toggles [data-home-shortcut-fab]");
    }

    function getPreviewItems() {
        return document.querySelectorAll("#home-shortcut-fab-preview [data-home-shortcut-preview]");
    }

    async function readPrefs() {
        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("getHomeShortcutFabPrefs", []);
            if (response?.success && response.result) return response.result;
        }
        if (typeof window.getHomeShortcutFabPrefs === "function") {
            return window.getHomeShortcutFabPrefs();
        }
        try {
            const raw = localStorage.getItem("android-hub.home-shortcut-fabs.v1");
            return raw ? JSON.parse(raw) : {};
        } catch (_err) {
            return {};
        }
    }

    async function writePref(fabId, enabled) {
        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("setHomeShortcutFabEnabled", [fabId, enabled]);
            if (response?.success) return response.result || {};
            window.showHubToast?.(response?.error || t("settingsPanel.homeShortcutsSaveFailed"), "error");
            return null;
        }
        if (typeof window.setHomeShortcutFabEnabled === "function") {
            return window.setHomeShortcutFabEnabled(fabId, enabled);
        }
        return null;
    }

    function applyPrefsToUi(prefs = {}) {
        let anyOn = false;
        getChips().forEach((chip) => {
            const id = chip.getAttribute("data-home-shortcut-fab");
            const on = Boolean(prefs?.[id]);
            chip.classList.toggle("is-on", on);
            chip.setAttribute("aria-pressed", on ? "true" : "false");
            if (on) anyOn = true;
        });
        getPreviewItems().forEach((item) => {
            const id = item.getAttribute("data-home-shortcut-preview");
            const on = Boolean(prefs?.[id]);
            item.classList.toggle("is-on", on);
            item.hidden = !on;
        });
        const empty = document.getElementById("home-shortcut-preview-empty");
        if (empty) empty.hidden = anyOn;
    }

    async function syncToggleUi() {
        const prefs = await readPrefs();
        applyPrefsToUi(prefs);
    }

    function bindHomeShortcutsSection() {
        if (!bound) {
            bound = true;
            getChips().forEach((chip) => {
                chip.addEventListener("click", () => {
                    const fabId = chip.getAttribute("data-home-shortcut-fab");
                    const next = !chip.classList.contains("is-on");
                    void (async () => {
                        const result = await writePref(fabId, next);
                        if (!result) return;
                        applyPrefsToUi(result);
                    })();
                });
            });
        }
        void syncToggleUi();
    }

    window.bindHomeShortcutsSection = bindHomeShortcutsSection;
})();
