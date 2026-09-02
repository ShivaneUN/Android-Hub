/**
 * Toasts globaux (WiFi setup, feedback connexion).
 * Affichés dans une fenêtre overlay always-on-top pour rester au-dessus des BrowserViews.
 */
(function initHubToasts() {
    let container = null;
    let fallbackTimer = null;

    function ensureContainer() {
        if (container && document.body.contains(container)) return container;
        container = document.createElement("div");
        container.id = "hub-toast-container";
        container.className = "hub-toast-container";
        document.body.appendChild(container);
        return container;
    }

    function showFallbackToast(message, type = "info", durationMs = 4200) {
        const root = ensureContainer();
        const toast = document.createElement("div");
        toast.className = `hub-toast hub-toast-${type}`;
        toast.textContent = String(message || "");
        root.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add("visible"));

        const timer = setTimeout(() => {
            toast.classList.remove("visible");
            setTimeout(() => toast.remove(), 220);
        }, durationMs);

        return {
            dismiss: () => {
                clearTimeout(timer);
                toast.classList.remove("visible");
                setTimeout(() => toast.remove(), 220);
            }
        };
    }

    function showToast(message, type = "info", durationMs = 4200) {
        const text = String(message || "");
        if (!text) {
            return { dismiss: () => {} };
        }

        if (window.hubBubbleAPI?.showToast) {
            if (fallbackTimer) {
                clearTimeout(fallbackTimer);
                fallbackTimer = null;
            }
            void window.hubBubbleAPI.showToast({
                message: text,
                type,
                durationMs
            });
            return {
                dismiss: () => {
                    window.hubBubbleAPI?.hide?.();
                }
            };
        }

        return showFallbackToast(text, type, durationMs);
    }

    window.showHubToast = showToast;

    window.deviceFsAPI?.onToast?.((payload) => {
        if (payload?.message) showToast(payload.message, payload.type || "info");
    });
})();
