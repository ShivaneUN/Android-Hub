/**
 * Bandeau de notification des mises à jour automatiques.
 */
(function initUpdateNotifier() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    const banner = document.getElementById("update-banner");
    if (!banner || !window.electronAPI) return;

    const titleEl = document.getElementById("update-banner-title");
    const detailEl = document.getElementById("update-banner-detail");
    const progressEl = document.getElementById("update-banner-progress");
    const progressBarEl = document.getElementById("update-banner-progress-bar");
    const versionBtn = document.getElementById("titlebar-version");
    const btnDownload = document.getElementById("update-btn-download");
    const btnInstall = document.getElementById("update-btn-install");
    const btnLater = document.getElementById("update-btn-later");
    const btnCheck = document.getElementById("update-btn-check");

    let dismissedVersion = null;
    let manualCheckPending = false;

    function showBanner() {
        banner.classList.remove("hidden");
    }

    function hideBanner() {
        banner.classList.add("hidden");
    }

    function setProgress(visible, percent = 0) {
        if (!progressEl || !progressBarEl) return;
        progressEl.classList.toggle("hidden", !visible);
        progressBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }

    function renderActions(status) {
        btnDownload?.classList.add("hidden");
        btnInstall?.classList.add("hidden");
        btnLater?.classList.add("hidden");
        btnCheck?.classList.add("hidden");

        if (status === "available") {
            btnDownload?.classList.remove("hidden");
            btnLater?.classList.remove("hidden");
        } else if (status === "downloading") {
            btnLater?.classList.remove("hidden");
        } else if (status === "downloaded") {
            btnInstall?.classList.remove("hidden");
            btnLater?.classList.remove("hidden");
        } else if (status === "error" || status === "dev-mode" || status === "uptodate") {
            btnCheck?.classList.remove("hidden");
            btnLater?.classList.remove("hidden");
        }
    }

    function updateVersionBadge(state = {}) {
        if (!versionBtn) return;
        const currentVersion = state.currentVersion || "?";
        versionBtn.textContent = t("titlebar.version", { version: currentVersion });

        const hasUpdate = state.status === "available" || state.status === "downloaded";
        versionBtn.classList.toggle("has-update", hasUpdate);
    }

    function renderState(state = {}) {
        const status = state.status || "idle";
        const currentVersion = state.currentVersion || "?";
        const nextVersion = state.version;

        updateVersionBadge(state);

        if (status === "idle" || status === "checking") {
            if (status === "checking") {
                titleEl.textContent = t("update.status.checking");
                detailEl.textContent = t("update.status.currentVersion", { version: currentVersion });
                setProgress(false);
                renderActions(status);
                showBanner();
            } else if (manualCheckPending) {
                manualCheckPending = false;
                titleEl.textContent = t("update.status.upToDate");
                detailEl.textContent = t("update.status.upToDateDetail", { version: currentVersion });
                setProgress(false);
                renderActions("uptodate");
                showBanner();
            } else if (state.error && state.enabled === false) {
                titleEl.textContent = t("update.status.notConfigured");
                detailEl.textContent = state.error;
                renderActions("error");
                showBanner();
            } else {
                hideBanner();
            }
            return;
        }

        manualCheckPending = false;

        if (status === "available") {
            if (dismissedVersion && dismissedVersion === nextVersion) {
                hideBanner();
                return;
            }
            titleEl.textContent = t("update.status.available", { version: nextVersion });
            detailEl.textContent = state.releaseNotes
                ? state.releaseNotes.split("\n")[0]
                : t("update.status.availableDetail", { currentVersion });
            setProgress(false);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "downloading") {
            const percent = Math.round(state.progress?.percent ?? 0);
            titleEl.textContent = t("update.status.downloading", { version: nextVersion || "" });
            detailEl.textContent = t("update.status.progress", { percent });
            setProgress(true, state.progress?.percent ?? 0);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "downloaded") {
            titleEl.textContent = t("update.status.downloaded", { version: nextVersion });
            detailEl.textContent = state.canInstall === false
                ? t("update.status.downloadedManual")
                : t("update.status.downloadedInstall");
            setProgress(true, 100);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "error") {
            titleEl.textContent = t("update.error.title");
            detailEl.textContent = state.error || t("update.error.checkFailed");
            setProgress(false);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "dev-mode") {
            titleEl.textContent = t("update.status.devMode");
            detailEl.textContent = state.error || t("update.status.devModeDetail");
            setProgress(false);
            renderActions(status);
            showBanner();
        }
    }

    btnDownload?.addEventListener("click", async () => {
        btnDownload.disabled = true;
        try {
            const result = await window.electronAPI.updateDownload();
            if (result?.success === false) {
                console.error("[UpdateNotifier]", result.error);
            }
        } catch (err) {
            console.error("[UpdateNotifier] Téléchargement:", err);
        } finally {
            btnDownload.disabled = false;
        }
    });

    btnInstall?.addEventListener("click", async () => {
        try {
            await window.electronAPI.updateInstall();
        } catch (err) {
            console.error("[UpdateNotifier] Installation:", err);
        }
    });

    btnLater?.addEventListener("click", () => {
        if (window.__updateState?.version) {
            dismissedVersion = window.__updateState.version;
        }
        hideBanner();
    });

    btnCheck?.addEventListener("click", async () => {
        btnCheck.disabled = true;
        manualCheckPending = true;
        try {
            await window.electronAPI.updateCheck();
        } finally {
            btnCheck.disabled = false;
        }
    });

    window.electronAPI.onUpdateStatus((state) => {
        window.__updateState = state;
        renderState(state);
    });

    globalThis.HubI18n?.onChange?.(() => {
        if (window.__updateState) {
            renderState(window.__updateState);
        }
        globalThis.HubI18n?.applyDomI18n?.(banner);
    });

    window.electronAPI.updateGetStatus?.()
        .then(renderState)
        .catch(() => {});
})();
