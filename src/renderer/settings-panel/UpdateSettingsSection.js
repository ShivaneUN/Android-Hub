/**
 * Section Paramètres — mise à jour (GitHub Releases / electron-updater).
 */
(function initUpdateSettingsSection() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;
    const { renderUpdateState } = globalThis.HubUpdateUi || {};
    if (!renderUpdateState) {
        console.warn("[UpdateSettingsSection] HubUpdateUi indisponible");
        return;
    }
    if (!window.electronAPI) return;

    const SETTINGS_BUTTON_KEYS = ["download", "install", "check"];

    let manualCheckPending = false;
    let lastState = null;
    let actionsBound = false;

    function getPaneRoot() {
        return document.getElementById("settings-pane-updates");
    }

    function getTargets() {
        return {
            titleEl: document.getElementById("settings-update-title"),
            detailEl: document.getElementById("settings-update-detail"),
            progressEl: document.getElementById("settings-update-progress"),
            progressBarEl: document.getElementById("settings-update-progress-bar"),
            buttons: {
                check: document.getElementById("settings-update-btn-check"),
                download: document.getElementById("settings-update-btn-download"),
                install: document.getElementById("settings-update-btn-install")
            }
        };
    }

    function renderCurrentVersion(state = {}, root) {
        if (!root) return;
        const currentVersionEl = root.querySelector("#settings-update-current-version");
        if (!currentVersionEl) return;
        currentVersionEl.textContent = t("update.status.currentVersion", {
            version: state.currentVersion || "?"
        });
    }

    function renderState(state = {}) {
        lastState = state;
        const root = getPaneRoot();
        if (!root) return;

        renderCurrentVersion(state, root);
        const result = renderUpdateState(state, getTargets(), {
            t,
            surface: "settings",
            manualCheckPending,
            buttonKeys: SETTINGS_BUTTON_KEYS
        });
        manualCheckPending = result.manualCheckPending;
    }

    function bindActions() {
        if (actionsBound) return;

        const buttons = getTargets().buttons;

        buttons.download?.addEventListener("click", async () => {
            if (!buttons.download || buttons.download.disabled) return;
            buttons.download.disabled = true;
            try {
                const result = await window.electronAPI.updateDownload();
                if (result?.success === false) {
                    console.error("[UpdateSettingsSection]", result.error);
                    buttons.download.disabled = false;
                }
            } catch (err) {
                console.error("[UpdateSettingsSection] Téléchargement:", err);
                buttons.download.disabled = false;
            }
        });

        buttons.install?.addEventListener("click", async () => {
            try {
                await window.electronAPI.updateInstall();
            } catch (err) {
                console.error("[UpdateSettingsSection] Installation:", err);
            }
        });

        buttons.check?.addEventListener("click", async () => {
            if (!buttons.check) return;
            buttons.check.disabled = true;
            manualCheckPending = true;
            try {
                await window.electronAPI.updateCheck();
            } catch (err) {
                console.error("[UpdateSettingsSection] Vérification:", err);
            } finally {
                buttons.check.disabled = false;
            }
        });

        actionsBound = true;
    }

    function bindUpdateSettingsSection() {
        if (!getPaneRoot()) return;
        bindActions();
        void refreshUpdateSettingsSection();
    }

    async function refreshUpdateSettingsSection() {
        if (!getPaneRoot()) return;
        try {
            const state = await window.electronAPI.updateGetStatus();
            renderState(state);
        } catch (err) {
            console.error("[UpdateSettingsSection] Lecture statut:", err);
        }
    }

    window.electronAPI.onUpdateStatus((state) => {
        renderState(state);
    });

    globalThis.HubI18n?.onChange?.(() => {
        const root = getPaneRoot();
        if (!root) return;
        if (lastState) {
            renderState(lastState);
        }
        globalThis.HubI18n?.applyDomI18n?.(root);
    });

    window.bindUpdateSettingsSection = bindUpdateSettingsSection;
    window.refreshUpdateSettingsSection = refreshUpdateSettingsSection;
})();
