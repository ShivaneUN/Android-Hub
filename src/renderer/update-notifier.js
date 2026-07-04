/**
 * Bandeau de notification des mises à jour automatiques.
 */
(function initUpdateNotifier() {
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
        versionBtn.textContent = `v${currentVersion}`;

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
                titleEl.textContent = "Recherche de mises à jour…";
                detailEl.textContent = `Version actuelle : v${currentVersion}`;
                setProgress(false);
                renderActions(status);
                showBanner();
            } else if (manualCheckPending) {
                manualCheckPending = false;
                titleEl.textContent = "Vous êtes à jour";
                detailEl.textContent = `Version v${currentVersion} — aucune mise à jour disponible.`;
                setProgress(false);
                renderActions("uptodate");
                showBanner();
            } else if (state.error && state.enabled === false) {
                titleEl.textContent = "Mises à jour non configurées";
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
            titleEl.textContent = `Mise à jour v${nextVersion} disponible`;
            detailEl.textContent = state.releaseNotes
                ? state.releaseNotes.split("\n")[0]
                : `Une nouvelle version est prête (actuelle : v${currentVersion}).`;
            setProgress(false);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "downloading") {
            titleEl.textContent = `Téléchargement v${nextVersion || ""}…`.trim();
            detailEl.textContent = `${Math.round(state.progress?.percent ?? 0)} %`;
            setProgress(true, state.progress?.percent ?? 0);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "downloaded") {
            titleEl.textContent = `Mise à jour v${nextVersion} prête`;
            detailEl.textContent = state.canInstall === false
                ? "Téléchargement terminé — installez via Setup.exe pour appliquer la mise à jour."
                : "Redémarrez l'application pour terminer l'installation.";
            setProgress(true, 100);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "error") {
            titleEl.textContent = "Erreur de mise à jour";
            detailEl.textContent = state.error || "Impossible de vérifier les mises à jour.";
            setProgress(false);
            renderActions(status);
            showBanner();
            return;
        }

        if (status === "dev-mode") {
            titleEl.textContent = "Mises à jour";
            detailEl.textContent = state.error || "Disponible uniquement en version installée.";
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

    window.electronAPI.updateGetStatus?.()
        .then(renderState)
        .catch(() => {});
})();
