/**
 * Infobulles style toast via hubBubble (fenêtre enfant de l'app, au-dessus du flux).
 */
(function initDockTips() {
    let activeEl = null;
    let hideTimer = null;

    function clearHideTimer() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function resolvePlacement(el) {
        if (!el) return "above";
        if (el.classList.contains("tabs-new-instance")) return "below";
        if (el.closest(".dock-battery-more-panel")) return "left";
        if (el.closest(".dock-battery-strip")) return "above";
        if (el.classList.contains("sidebar-wifi-toggle") && !el.closest(".dock-battery-strip")) {
            return "below";
        }
        if (
            el.classList.contains("sidebar-device-audio-btn")
            && (el.closest(".home-devices-panel") || el.closest(".sidebar-devices-panel"))
        ) {
            return "below";
        }
        return "above";
    }

    function hideTip() {
        clearHideTimer();
        activeEl = null;
        window.hubBubbleAPI?.hide?.();
    }

    function showTipFor(el) {
        if (!el || !window.hubBubbleAPI?.showTip) return;
        const text = el.getAttribute("data-dock-tip");
        if (!text) return;

        // Le dock tablette agrandi gère ses tips via dock-overlay → hubBubble.
        if (
            document.body.classList.contains("theme-tablet")
            && el.closest("#quick-actions-dock")
        ) {
            return;
        }

        el.removeAttribute("title");
        const rect = el.getBoundingClientRect();
        activeEl = el;
        void window.hubBubbleAPI.showTip({
            text,
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            placement: resolvePlacement(el)
        });
    }

    document.addEventListener(
        "pointerover",
        (event) => {
            const el = event.target?.closest?.("[data-dock-tip]");
            if (!el) return;
            if (el === activeEl) return;
            clearHideTimer();
            showTipFor(el);
        },
        true
    );

    document.addEventListener(
        "pointerout",
        (event) => {
            const el = event.target?.closest?.("[data-dock-tip]");
            if (!el || el !== activeEl) return;
            const related = event.relatedTarget;
            if (related && el.contains(related)) return;
            clearHideTimer();
            hideTimer = setTimeout(() => {
                if (activeEl === el) hideTip();
            }, 80);
        },
        true
    );

    window.addEventListener("blur", hideTip);
    document.addEventListener("scroll", hideTip, true);
})();
