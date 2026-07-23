(function initLanguageToggle() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    function createToggle() {
        const dock = document.getElementById("quick-actions-dock");
        const navSettings = document.getElementById("nav-settings");
        const sidebar = document.getElementById("sidebar");
        if (!dock || !sidebar || document.getElementById("nav-language")) return;

        const item = document.createElement("div");
        item.className = "sidebar-item sidebar-language-toggle";
        item.id = "nav-language";
        item.title = t("sidebar.language");
        item.innerHTML = `
            <div class="icon sidebar-language-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="9"/>
                    <path d="M2.5 12h19"/>
                    <path d="M12 2.5a14 14 0 0 1 0 19"/>
                    <path d="M12 2.5a14 14 0 0 0 0 19"/>
                </svg>
                <span class="sidebar-language-badge" id="sidebar-language-badge">FR</span>
            </div>
            <div class="label sidebar-language-label">
                <span data-i18n="sidebar.language">Langue</span>
            </div>
        `;
        item.dataset.dockTip = t("sidebar.language");
        item.setAttribute("data-i18n-dock-tip", "sidebar.language");

        if (navSettings && dock.contains(navSettings)) {
            navSettings.insertAdjacentElement("afterend", item);
        } else {
            dock.appendChild(item);
        }

        item.addEventListener("click", () => {
            void globalThis.HubI18n?.toggleLocale?.();
        });
    }

    function updateBadge() {
        const badge = document.getElementById("sidebar-language-badge");
        if (!badge || !globalThis.HubI18n) return;
        const locale = globalThis.HubI18n.getLocale();
        badge.textContent = locale === "en" ? "EN" : "FR";
        const item = document.getElementById("nav-language");
        if (item) {
            const tipKey = locale === "en" ? "sidebar.languageEn" : "sidebar.languageFr";
            item.title = t(tipKey);
            item.dataset.dockTip = t(tipKey);
            item.setAttribute("data-i18n-dock-tip", tipKey);
        }
    }

    function init() {
        createToggle();
        updateBadge();
        globalThis.HubI18n?.onChange?.(() => {
            updateBadge();
            globalThis.HubI18n?.applyDomI18n?.(document.getElementById("sidebar") || document);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
