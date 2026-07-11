/**
 * Overlay de chargement centré, non bloquant (réutilisable).
 */
(function initHubLoadingOverlay() {
    let root = null;
    let hideTimer = null;
    let timeoutTimer = null;
    let errorTimer = null;

    function ensureRoot() {
        if (root && document.body.contains(root)) return root;
        root = document.createElement("div");
        root.id = "hub-loading-overlay";
        root.className = "hub-loading-overlay hidden";
        root.setAttribute("role", "status");
        root.setAttribute("aria-live", "polite");
        root.innerHTML = `
            <div class="hub-loading-overlay-card">
                <div class="hub-loading-spinner" aria-hidden="true"></div>
                <span class="hub-loading-message"></span>
            </div>
        `;
        document.body.appendChild(root);
        return root;
    }

    function clearTimers() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
        }
        if (errorTimer) {
            clearTimeout(errorTimer);
            errorTimer = null;
        }
    }

    function setMessage(message) {
        const msgEl = root?.querySelector(".hub-loading-message");
        if (msgEl) msgEl.textContent = String(message || "");
    }

    function setSpinnerVisible(visible) {
        const spinner = root?.querySelector(".hub-loading-spinner");
        if (spinner) spinner.style.display = visible ? "" : "none";
    }

    function show(message, options = {}) {
        clearTimers();
        const el = ensureRoot();
        el.classList.remove("hidden", "hub-loading-overlay--error");
        setMessage(message);
        setSpinnerVisible(true);
        requestAnimationFrame(() => el.classList.add("visible"));

        const timeoutMs = Number(options.timeoutMs);
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                showError(
                    options.timeoutMessage || message,
                    options.errorAutoCloseMs || 2800
                );
            }, timeoutMs);
        }

        return {
            hide: () => hide(),
            showError: (errorMessage, autoCloseMs) => showError(errorMessage, autoCloseMs)
        };
    }

    function hide() {
        clearTimers();
        if (!root) return;
        root.classList.remove("visible", "hub-loading-overlay--error");
        hideTimer = setTimeout(() => {
            if (root) root.classList.add("hidden");
            hideTimer = null;
        }, 200);
    }

    function showError(message, autoCloseMs = 2800) {
        clearTimers();
        const el = ensureRoot();
        el.classList.remove("hidden");
        el.classList.add("hub-loading-overlay--error");
        setSpinnerVisible(false);
        setMessage(message);
        requestAnimationFrame(() => el.classList.add("visible"));
        errorTimer = setTimeout(() => hide(), Math.max(1500, autoCloseMs));
    }

    window.showHubLoadingOverlay = show;
    window.hideHubLoadingOverlay = hide;
    window.showHubLoadingOverlayError = showError;
})();
