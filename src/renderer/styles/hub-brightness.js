(function initHubBrightness() {
    const STORAGE_KEY = "androidHub.uiBrightness";
    const MIN = 40;
    const MAX = 100;
    const DEFAULT = 100;

    function normalizeBrightness(value) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return DEFAULT;
        return Math.min(MAX, Math.max(MIN, n));
    }

    function getUiBrightness() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw == null || raw === "") return DEFAULT;
            return normalizeBrightness(raw);
        } catch (_err) {
            return DEFAULT;
        }
    }

    function brightnessToFactor(percent) {
        return normalizeBrightness(percent) / 100;
    }

    function setUiBrightness(percent) {
        const next = normalizeBrightness(percent);
        try {
            localStorage.setItem(STORAGE_KEY, String(next));
        } catch (_err) {
            /* ignore */
        }
        applyUiBrightness(next);
        void window.sessionAPI?.setUiBrightness?.(next);
        return next;
    }

    function applyUiBrightness(percent) {
        const next = normalizeBrightness(percent);
        const factor = brightnessToFactor(next);
        const root = document.documentElement;
        root.style.setProperty("--hub-ui-brightness", String(factor));
        document.body?.classList.toggle("hub-brightness-dim", next < MAX);
        syncBrightnessUi(next);
        return next;
    }

    function syncBrightnessUi(percent = getUiBrightness()) {
        const next = normalizeBrightness(percent);
        const slider = document.getElementById("settings-hub-brightness");
        const valueEl = document.getElementById("settings-hub-brightness-value");
        if (slider && String(slider.value) !== String(next)) {
            slider.value = String(next);
        }
        if (valueEl) {
            valueEl.textContent = `${next}%`;
        }
    }

    applyUiBrightness(getUiBrightness());
    // Propager aux flux déjà ouverts (et mémoriser le facteur pour les prochaines vues).
    void window.sessionAPI?.setUiBrightness?.(getUiBrightness());

    window.HubBrightness = {
        MIN,
        MAX,
        DEFAULT,
        normalizeBrightness,
        getUiBrightness,
        setUiBrightness,
        applyUiBrightness,
        syncBrightnessUi
    };
    window.getUiBrightness = getUiBrightness;
    window.setUiBrightness = setUiBrightness;
    window.applyUiBrightness = applyUiBrightness;
})();
