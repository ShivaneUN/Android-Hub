/**
 * Logique UI partagée pour le bandeau et la section Paramètres (mise à jour).
 * Ne communique pas avec le main process — rendu uniquement.
 */
(function initUpdateUiController(global) {
    const DEFAULT_BUTTON_KEYS = ["download", "install", "check", "later"];

    /**
     * @typedef {Object} UpdateState
     * @property {string} [status]
     * @property {string|null} [version]
     * @property {string|null} [releaseNotes]
     * @property {{ percent?: number }|null} [progress]
     * @property {string|null} [error]
     * @property {string} [currentVersion]
     * @property {boolean} [enabled]
     * @property {boolean} [canInstall]
     */

    /**
     * @typedef {Object} UpdateUiTargets
     * @property {HTMLElement|null|undefined} titleEl
     * @property {HTMLElement|null|undefined} detailEl
     * @property {HTMLElement|null|undefined} progressEl
     * @property {HTMLElement|null|undefined} progressBarEl
     * @property {Record<string, HTMLElement|null|undefined>} [buttons]
     */

    /**
     * @typedef {Object} UpdateUiRenderOptions
     * @property {(key: string, vars?: Record<string, string|number>) => string} t
     * @property {'banner'|'settings'} [surface]
     * @property {boolean} [manualCheckPending]
     * @property {string|null} [dismissedVersion]
     */

    /**
     * @typedef {Object} UpdateUiRenderResult
     * @property {'show'|'hide'} visibility
     * @property {string} status
     * @property {boolean} manualCheckPending
     */

    function setProgress(targets, visible, percent = 0) {
        const { progressEl, progressBarEl } = targets;
        if (!progressEl || !progressBarEl) return;
        progressEl.classList.toggle("hidden", !visible);
        progressBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }

    function renderActions(status, buttons = {}, options = {}) {
        const keys = options.buttonKeys || DEFAULT_BUTTON_KEYS;
        for (const key of keys) {
            const btn = buttons[key];
            if (!btn) continue;
            btn.classList.add("hidden");
            if (key === "check") btn.disabled = false;
        }

        if (status === "checking") {
            if (options.surface === "settings") {
                const checkBtn = buttons.check;
                if (checkBtn) {
                    checkBtn.classList.remove("hidden");
                    checkBtn.disabled = true;
                }
            }
            return;
        }

        if (status === "available") {
            buttons.download?.classList.remove("hidden");
            if (options.surface !== "settings") {
                buttons.later?.classList.remove("hidden");
            }
            return;
        }

        if (status === "downloading") {
            if (options.surface !== "settings") {
                buttons.later?.classList.remove("hidden");
            }
            return;
        }

        if (status === "downloaded") {
            buttons.install?.classList.remove("hidden");
            if (options.surface !== "settings") {
                buttons.later?.classList.remove("hidden");
            }
            return;
        }

        if (status === "error" || status === "dev-mode" || status === "uptodate") {
            buttons.check?.classList.remove("hidden");
            if (options.surface !== "settings") {
                buttons.later?.classList.remove("hidden");
            }
        }
    }

    /**
     * Met à jour le DOM à partir de l'état updater.
     *
     * @param {UpdateState} state
     * @param {UpdateUiTargets} targets
     * @param {UpdateUiRenderOptions} [options]
     * @returns {UpdateUiRenderResult}
     */
    function renderUpdateState(state = {}, targets = {}, options = {}) {
        const t = options.t || ((key) => key);
        const surface = options.surface || "banner";
        let manualCheckPending = Boolean(options.manualCheckPending);
        const dismissedVersion = options.dismissedVersion ?? null;

        const status = state.status || "idle";
        const currentVersion = state.currentVersion || "?";
        const nextVersion = state.version;
        const { titleEl, detailEl, buttons = {} } = targets;

        if (status === "idle" || status === "checking") {
            if (status === "checking") {
                if (titleEl) titleEl.textContent = t("update.status.checking");
                if (detailEl) detailEl.textContent = t("update.status.currentVersion", { version: currentVersion });
                setProgress(targets, false);
                renderActions(status, buttons, options);
                return { visibility: "show", status, manualCheckPending };
            }

            if (manualCheckPending) {
                manualCheckPending = false;
                if (titleEl) titleEl.textContent = t("update.status.upToDate");
                if (detailEl) detailEl.textContent = t("update.status.upToDateDetail", { version: currentVersion });
                setProgress(targets, false);
                renderActions("uptodate", buttons, options);
                return { visibility: "show", status: "uptodate", manualCheckPending };
            }

            if (state.error && state.enabled === false) {
                if (titleEl) titleEl.textContent = t("update.status.notConfigured");
                if (detailEl) detailEl.textContent = state.error;
                setProgress(targets, false);
                renderActions("error", buttons, options);
                return { visibility: "show", status: "error", manualCheckPending };
            }

            if (surface === "settings") {
                if (titleEl) titleEl.textContent = t("update.status.upToDate");
                if (detailEl) detailEl.textContent = t("update.status.upToDateDetail", { version: currentVersion });
                setProgress(targets, false);
                renderActions("uptodate", buttons, { ...options, surface: "settings" });
                return { visibility: "show", status: "idle", manualCheckPending };
            }

            return { visibility: "hide", status, manualCheckPending };
        }

        manualCheckPending = false;

        if (status === "available") {
            if (surface === "banner" && dismissedVersion && dismissedVersion === nextVersion) {
                return { visibility: "hide", status, manualCheckPending };
            }
            if (titleEl) titleEl.textContent = t("update.status.available", { version: nextVersion });
            if (detailEl) {
                detailEl.textContent = state.releaseNotes
                    ? state.releaseNotes.split("\n")[0]
                    : t("update.status.availableDetail", { currentVersion });
            }
            setProgress(targets, false);
            renderActions(status, buttons, options);
            return { visibility: "show", status, manualCheckPending };
        }

        if (status === "downloading") {
            const percent = Math.round(state.progress?.percent ?? 0);
            if (titleEl) titleEl.textContent = t("update.status.downloading", { version: nextVersion || "" });
            if (detailEl) detailEl.textContent = t("update.status.progress", { percent });
            setProgress(targets, true, state.progress?.percent ?? 0);
            renderActions(status, buttons, options);
            return { visibility: "show", status, manualCheckPending };
        }

        if (status === "downloaded") {
            if (titleEl) titleEl.textContent = t("update.status.downloaded", { version: nextVersion });
            if (detailEl) {
                detailEl.textContent = state.canInstall === false
                    ? t("update.status.downloadedManual")
                    : t("update.status.downloadedInstall");
            }
            setProgress(targets, true, 100);
            renderActions(status, buttons, options);
            return { visibility: "show", status, manualCheckPending };
        }

        if (status === "error") {
            if (titleEl) titleEl.textContent = t("update.error.title");
            if (detailEl) detailEl.textContent = state.error || t("update.error.checkFailed");
            setProgress(targets, false);
            renderActions(status, buttons, options);
            return { visibility: "show", status, manualCheckPending };
        }

        if (status === "dev-mode") {
            if (titleEl) titleEl.textContent = t("update.status.devMode");
            if (detailEl) detailEl.textContent = state.error || t("update.status.devModeDetail");
            setProgress(targets, false);
            renderActions(status, buttons, options);
            return { visibility: "show", status, manualCheckPending };
        }

        return { visibility: surface === "settings" ? "show" : "hide", status, manualCheckPending };
    }

    global.HubUpdateUi = {
        renderUpdateState,
        setProgress,
        renderActions
    };
})(globalThis);
