(function initAppearanceSection() {
    const THEME_KEY = "androidHub.uiTheme";
    let bound = false;

    function normalizeTheme(theme) {
        return theme === "tablet" ? "tablet" : "classic";
    }

    function readLocalTheme() {
        try {
            return normalizeTheme(localStorage.getItem(THEME_KEY));
        } catch (_err) {
            return "classic";
        }
    }

    function syncThemeButtons(theme) {
        const root = document.getElementById("settings-pane-appearance");
        if (!root) return;
        root.querySelectorAll("[data-settings-theme]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.settingsTheme === theme);
        });
    }

    function syncAccentButtons(accent) {
        const next = window.HubAccent?.normalizeAccent?.(accent) || accent || "5";
        document.querySelectorAll("[data-hub-accent]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.hubAccent === next);
        });
        window.applyUiAccent?.(next);
    }

    function syncSurfaceButtons(surface) {
        const next = window.HubSurface?.normalizeSurface?.(surface) || surface || "midnight";
        document.querySelectorAll("[data-hub-surface]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.hubSurface === next);
        });
        window.applyUiSurface?.(next);
    }

    async function applyThemeFromSettings(theme) {
        const next = normalizeTheme(theme);
        syncThemeButtons(next);

        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("setUiTheme", [next]);
            if (response?.success && response.result?.theme) {
                syncThemeButtons(normalizeTheme(response.result.theme));
                return;
            }
        }

        try {
            localStorage.setItem(THEME_KEY, next);
        } catch (_err) {
            /* ignore */
        }
        window.applyUiTheme?.(next);
    }

    async function applyAccentFromSettings(accent) {
        const next = window.HubAccent?.normalizeAccent?.(accent) || "5";
        syncAccentButtons(next);

        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("setUiAccent", [next]);
            if (response?.success && response.result?.accent) {
                syncAccentButtons(response.result.accent);
                return;
            }
        }

        window.setUiAccent?.(next);
    }

    async function applySurfaceFromSettings(surface) {
        const next = window.HubSurface?.normalizeSurface?.(surface) || "midnight";
        syncSurfaceButtons(next);

        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("setUiSurface", [next]);
            if (response?.success && response.result?.surface) {
                syncSurfaceButtons(response.result.surface);
                return;
            }
        }

        window.setUiSurface?.(next);
    }

    async function pickWallpaper() {
        try {
            const result = await window.uiPreferencesAPI?.pickHubWallpaper?.();
            if (result?.success) {
                window.HubSurface?.applyWallpaper?.(result);
            }
        } catch (_err) {
            /* ignore */
        }
    }

    async function clearWallpaper() {
        try {
            const result = await window.uiPreferencesAPI?.clearHubWallpaper?.();
            if (result?.success !== false) {
                window.HubSurface?.applyWallpaper?.(result);
            }
        } catch (_err) {
            /* ignore */
        }
    }

    async function applyBrightnessFromSettings(brightness) {
        const next = window.HubBrightness?.normalizeBrightness?.(brightness)
            ?? Math.min(100, Math.max(40, Math.round(Number(brightness) || 100)));
        window.HubBrightness?.syncBrightnessUi?.(next);

        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("setUiBrightness", [next]);
            if (response?.success && response.result?.brightness != null) {
                window.setUiBrightness?.(response.result.brightness);
                return;
            }
        }

        window.setUiBrightness?.(next);
    }

    async function syncFromMain() {
        if (window.hubModalWindowAPI?.invokeMain) {
            try {
                const themeRes = await window.hubModalWindowAPI.invokeMain("getUiTheme", []);
                if (themeRes?.success && themeRes.result) {
                    syncThemeButtons(normalizeTheme(themeRes.result));
                } else {
                    syncThemeButtons(readLocalTheme());
                }
            } catch (_err) {
                syncThemeButtons(readLocalTheme());
            }

            try {
                const accentRes = await window.hubModalWindowAPI.invokeMain("getUiAccent", []);
                if (accentRes?.success && accentRes.result) {
                    syncAccentButtons(accentRes.result);
                } else {
                    syncAccentButtons(window.getUiAccent?.() || "5");
                }
            } catch (_err) {
                syncAccentButtons(window.getUiAccent?.() || "5");
            }

            try {
                const surfaceRes = await window.hubModalWindowAPI.invokeMain("getUiSurface", []);
                if (surfaceRes?.success && surfaceRes.result) {
                    syncSurfaceButtons(surfaceRes.result);
                } else {
                    syncSurfaceButtons(window.getUiSurface?.() || "midnight");
                }
            } catch (_err) {
                syncSurfaceButtons(window.getUiSurface?.() || "midnight");
            }

            try {
                const brightnessRes = await window.hubModalWindowAPI.invokeMain("getUiBrightness", []);
                if (brightnessRes?.success && brightnessRes.result != null) {
                    window.applyUiBrightness?.(brightnessRes.result);
                } else {
                    window.applyUiBrightness?.(window.getUiBrightness?.() ?? 100);
                }
            } catch (_err) {
                window.applyUiBrightness?.(window.getUiBrightness?.() ?? 100);
            }
        } else {
            syncThemeButtons(readLocalTheme());
            syncAccentButtons(window.getUiAccent?.() || "5");
            syncSurfaceButtons(window.getUiSurface?.() || "midnight");
            window.applyUiBrightness?.(window.getUiBrightness?.() ?? 100);
        }

        await window.HubSurface?.refreshWallpaperFromMain?.();
        window.HubSurface?.syncWallpaperUi?.();
    }

    function bindAppearanceSection() {
        const root = document.getElementById("settings-pane-appearance");
        if (!root) return;

        if (!bound) {
            bound = true;
            root.querySelectorAll("[data-settings-theme]").forEach((btn) => {
                btn.addEventListener("click", () => {
                    void applyThemeFromSettings(btn.dataset.settingsTheme);
                });
            });
            root.addEventListener("click", (event) => {
                const accentBtn = event.target.closest?.("[data-hub-accent]");
                if (accentBtn && root.contains(accentBtn)) {
                    void applyAccentFromSettings(accentBtn.dataset.hubAccent);
                    return;
                }
                const surfaceBtn = event.target.closest?.("[data-hub-surface]");
                if (surfaceBtn && root.contains(surfaceBtn)) {
                    void applySurfaceFromSettings(surfaceBtn.dataset.hubSurface);
                    return;
                }
                if (event.target.closest?.("#settings-wallpaper-pick")) {
                    void pickWallpaper();
                    return;
                }
                if (event.target.closest?.("#settings-wallpaper-clear")) {
                    void clearWallpaper();
                }
            });

            const brightnessSlider = root.querySelector("#settings-hub-brightness");
            if (brightnessSlider) {
                const onBrightnessInput = () => {
                    const next = window.HubBrightness?.normalizeBrightness?.(brightnessSlider.value)
                        ?? Number(brightnessSlider.value);
                    window.setUiBrightness?.(next);
                    brightnessSlider.setAttribute("aria-valuenow", String(next));
                };
                brightnessSlider.addEventListener("input", onBrightnessInput);
                brightnessSlider.addEventListener("change", onBrightnessInput);
            }
        }

        window.HubAccent?.renderSwatches?.(root);
        window.HubSurface?.renderSwatches?.(root);
        void syncFromMain();
    }

    window.bindAppearanceSection = bindAppearanceSection;
})();
