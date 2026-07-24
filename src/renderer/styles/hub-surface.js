(function initHubSurface() {
    const STORAGE_KEY = "androidHub.uiSurface";
    const DEFAULT_ID = "midnight";

    const PRESETS = Object.freeze({
        midnight: {
            key: "midnight",
            bgApp: "#0a0e14",
            bgSidebar: "#11151c",
            bgPanel: "#141820",
            border: "#1d232d",
            preview: "#0a0e14"
        },
        graphite: {
            key: "graphite",
            bgApp: "#08090c",
            bgSidebar: "#101218",
            bgPanel: "#12151c",
            border: "#1a1e26",
            preview: "#08090c"
        },
        slate: {
            key: "slate",
            bgApp: "#0c1018",
            bgSidebar: "#141a24",
            bgPanel: "#161c28",
            border: "#222936",
            preview: "#0c1018"
        },
        forest: {
            key: "forest",
            bgApp: "#0a100e",
            bgSidebar: "#111a16",
            bgPanel: "#141f1a",
            border: "#1c2820",
            preview: "#0a100e"
        },
        ocean: {
            key: "ocean",
            bgApp: "#071018",
            bgSidebar: "#0e1822",
            bgPanel: "#121e2a",
            border: "#1a2a38",
            preview: "#071018"
        },
        dusk: {
            key: "dusk",
            bgApp: "#100c16",
            bgSidebar: "#18141f",
            bgPanel: "#1c1826",
            border: "#2a2436",
            preview: "#100c16"
        },
        wine: {
            key: "wine",
            bgApp: "#140a0e",
            bgSidebar: "#1c1216",
            bgPanel: "#22161a",
            border: "#302024",
            preview: "#140a0e"
        },
        cocoa: {
            key: "cocoa",
            bgApp: "#120e0a",
            bgSidebar: "#1a1510",
            bgPanel: "#201a14",
            border: "#2c241c",
            preview: "#120e0a"
        }
    });

    let wallpaperState = { active: false, fileName: null, url: null };

    function normalizeSurface(id) {
        return PRESETS[id] ? id : DEFAULT_ID;
    }

    function getUiSurface() {
        try {
            return normalizeSurface(localStorage.getItem(STORAGE_KEY));
        } catch (_err) {
            return DEFAULT_ID;
        }
    }

    function surfaceLabel(preset) {
        if (!preset?.key) return "";
        return globalThis.HubI18n?.t?.(`settingsPanel.surface.${preset.key}`) || preset.key;
    }

    function t(key, fallback) {
        return globalThis.HubI18n?.t?.(key) || fallback;
    }

    function renderSwatches(root = document) {
        const host = root.querySelector?.("#settings-surface-swatches")
            || document.getElementById("settings-surface-swatches");
        if (!host) return;
        const current = getUiSurface();
        host.innerHTML = Object.entries(PRESETS).map(([id, preset]) => {
            const label = surfaceLabel(preset);
            const active = id === current ? " active" : "";
            return `<button type="button" class="settings-surface-swatch${active}" data-hub-surface="${id}" style="background:${preset.preview}" title="${label}" aria-label="${label}"></button>`;
        }).join("");
    }

    function syncWallpaperUi(root = document) {
        const scope = root.querySelector?.("#settings-pane-appearance")
            || document.getElementById("settings-pane-appearance")
            || root;
        const nameEl = scope.querySelector?.("#settings-wallpaper-name")
            || document.getElementById("settings-wallpaper-name");
        const clearBtn = scope.querySelector?.("#settings-wallpaper-clear")
            || document.getElementById("settings-wallpaper-clear");
        const pickBtn = scope.querySelector?.("#settings-wallpaper-pick")
            || document.getElementById("settings-wallpaper-pick");

        if (pickBtn) {
            pickBtn.textContent = t("settingsPanel.wallpaperPick", "Choisir une image…");
        }
        if (nameEl) {
            if (wallpaperState.active && wallpaperState.fileName) {
                nameEl.textContent = wallpaperState.fileName;
                nameEl.hidden = false;
            } else {
                nameEl.textContent = t("settingsPanel.wallpaperNone", "Aucune image");
                nameEl.hidden = false;
            }
        }
        if (clearBtn) {
            clearBtn.hidden = !wallpaperState.active;
            clearBtn.textContent = t("settingsPanel.wallpaperClear", "Retirer");
        }
    }

    function isHubModalShell() {
        return Boolean(document.querySelector(".hub-modal-panel")) && !document.querySelector(".app");
    }

    function applyWallpaper(state) {
        wallpaperState = {
            active: Boolean(state?.active && state?.url),
            fileName: state?.fileName || null,
            url: state?.url || null
        };
        const root = document.documentElement;
        // La fenêtre modale (Paramètres / Aide) reste opaque : pas d’image de fond.
        if (wallpaperState.active && !isHubModalShell()) {
            root.style.setProperty("--bg-app-image", `url("${wallpaperState.url}")`);
            root.dataset.hubWallpaper = "1";
        } else {
            root.style.removeProperty("--bg-app-image");
            delete root.dataset.hubWallpaper;
        }
        syncWallpaperUi();
        return wallpaperState;
    }

    function getWallpaperState() {
        return { ...wallpaperState };
    }

    async function refreshWallpaperFromMain() {
        try {
            const state = await window.uiPreferencesAPI?.getHubWallpaper?.();
            if (state) applyWallpaper(state);
        } catch (_err) {
            applyWallpaper({ active: false });
        }
    }

    function applyUiSurface(id) {
        const next = normalizeSurface(id);
        const preset = PRESETS[next];
        const root = document.documentElement;
        root.style.setProperty("--bg-app", preset.bgApp);
        root.style.setProperty("--bg-sidebar", preset.bgSidebar);
        root.style.setProperty("--bg-panel", preset.bgPanel);
        root.style.setProperty("--border-subtle", preset.border);
        root.dataset.hubSurface = next;
        document.querySelectorAll("[data-hub-surface]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.hubSurface === next);
        });
        return next;
    }

    function setUiSurface(id) {
        const next = normalizeSurface(id);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch (_err) {
            /* ignore */
        }
        return applyUiSurface(next);
    }

    function refreshSurfaceLabels() {
        renderSwatches();
        applyUiSurface(getUiSurface());
        syncWallpaperUi();
    }

    applyUiSurface(getUiSurface());
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            renderSwatches();
            syncWallpaperUi();
            void refreshWallpaperFromMain();
        }, { once: true });
    } else {
        renderSwatches();
        syncWallpaperUi();
        void refreshWallpaperFromMain();
    }

    globalThis.HubI18n?.onChange?.(refreshSurfaceLabels);
    window.uiPreferencesAPI?.onWallpaperChanged?.((state) => {
        applyWallpaper(state);
    });

    window.HubSurface = {
        STORAGE_KEY,
        DEFAULT_ID,
        PRESETS,
        normalizeSurface,
        getUiSurface,
        applyUiSurface,
        setUiSurface,
        renderSwatches,
        applyWallpaper,
        getWallpaperState,
        syncWallpaperUi,
        refreshWallpaperFromMain
    };
    window.applyUiSurface = applyUiSurface;
    window.getUiSurface = getUiSurface;
    window.setUiSurface = setUiSurface;
    window.applyHubWallpaper = applyWallpaper;
})();
