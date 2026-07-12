/**
 * Bandeau de notification des mises à jour automatiques.
 */
(function initUpdateNotifier() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;
    const { renderUpdateState } = globalThis.HubUpdateUi || {};
    if (!renderUpdateState) {
        console.warn("[UpdateNotifier] HubUpdateUi indisponible");
        return;
    }

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

    const targets = {
        titleEl,
        detailEl,
        progressEl,
        progressBarEl,
        buttons: {
            download: btnDownload,
            install: btnInstall,
            later: btnLater,
            check: btnCheck
        }
    };

    let dismissedVersion = null;
    let manualCheckPending = false;

    function showBanner() {
        banner.classList.remove("hidden");
    }

    function hideBanner() {
        banner.classList.add("hidden");
    }

    function updateVersionBadge(state = {}) {
        if (!versionBtn) return;
        const currentVersion = state.currentVersion || "?";
        versionBtn.textContent = t("titlebar.version", { version: currentVersion });

        const hasUpdate = state.status === "available" || state.status === "downloaded";
        versionBtn.classList.toggle("has-update", hasUpdate);
    }

    function renderState(state = {}) {
        updateVersionBadge(state);
        const result = renderUpdateState(state, targets, {
            t,
            surface: "banner",
            manualCheckPending,
            dismissedVersion
        });
        manualCheckPending = result.manualCheckPending;
        if (result.visibility === "show") showBanner();
        else hideBanner();
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
