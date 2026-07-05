/**
 * Toasts globaux légers (WiFi setup, feedback connexion).
 */
(function initHubToasts() {
    let container = null;

    function ensureContainer() {
        if (container && document.body.contains(container)) return container;
        container = document.createElement("div");
        container.id = "hub-toast-container";
        container.className = "hub-toast-container";
        document.body.appendChild(container);
        return container;
    }

    function showToast(message, type = "info", durationMs = 4200) {
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

    window.showHubToast = showToast;
})();
