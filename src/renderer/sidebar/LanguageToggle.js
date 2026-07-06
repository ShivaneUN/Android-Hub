(function initLanguageToggle() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    function createToggle() {
        const navAide = document.getElementById("nav-aide");
        const sidebar = document.getElementById("sidebar");
        if (!navAide || !sidebar || document.getElementById("nav-language")) return;

        const item = document.createElement("div");
        item.className = "sidebar-item sidebar-language-toggle";
        item.id = "nav-language";
        item.title = t("sidebar.language");
        item.innerHTML = `
            <div class="icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
            </div>
            <div class="label sidebar-language-label">
                <span data-i18n="sidebar.language">Langue</span>
                <span class="sidebar-language-badge" id="sidebar-language-badge">FR</span>
            </div>
        `;
        navAide.insertAdjacentElement("afterend", item);

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
            item.title = locale === "en" ? t("sidebar.languageEn") : t("sidebar.languageFr");
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
