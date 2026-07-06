(function initHelpPanel() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;
    const tArray = (key) => globalThis.HubI18n?.tArray?.(key) ?? [];
    const tObject = (key) => globalThis.HubI18n?.tObject?.(key) ?? {};

    function isHubModalChildWindow() {
        return /hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"));
    }

    if (!isHubModalChildWindow()) {
        return;
    }

    const GUIDE_ILLUSTRATIONS = [
        renderUsbIllustration,
        renderDevOptionsIllustration,
        renderUsbDebugIllustration,
        renderAuthorizeIllustration,
        renderReadyIllustration
    ];

    function getGuideSteps() {
        const steps = tArray("help.guide.steps");
        return steps.map((step, index) => ({
            ...step,
            illustration: GUIDE_ILLUSTRATIONS[index] || (() => "")
        }));
    }

    function getWifiGuide() {
        return tObject("help.wifi");
    }

    function getShortcutGroups() {
        const groups = t("help.shortcuts.groups");
        return Array.isArray(groups) ? groups : [];
    }

    function getTroubleshootingItems() {
        return tArray("help.troubleshoot.items");
    }

    let currentGuideStep = 0;
    let overlayEl = null;

    function renderUsbIllustration() {
        return `<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="20" y="30" width="70" height="110" rx="8" fill="#11151c" stroke="#2a3344" stroke-width="2"/>
            <rect x="28" y="42" width="54" height="88" rx="4" fill="#0a0e14"/>
            <rect x="110" y="50" width="70" height="45" rx="6" fill="#161b24" stroke="#2a3344" stroke-width="2"/>
            <rect x="118" y="58" width="54" height="28" rx="3" fill="#0a0e14"/>
            <path d="M90 85 L110 72" stroke="#4f8cff" stroke-width="3" stroke-linecap="round"/>
            <circle cx="90" cy="85" r="4" fill="#4f8cff"/>
            <text x="55" y="152" text-anchor="middle" fill="#5b6373" font-size="9">Téléphone</text>
            <text x="145" y="108" text-anchor="middle" fill="#5b6373" font-size="9">PC</text>
        </svg>`;
    }

    function renderDevOptionsIllustration() {
        return `<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="55" y="8" width="90" height="144" rx="10" fill="#11151c" stroke="#2a3344" stroke-width="2"/>
            <rect x="63" y="20" width="74" height="120" rx="4" fill="#0a0e14"/>
            <text x="100" y="38" text-anchor="middle" fill="#8b93a3" font-size="8">À propos du téléphone</text>
            <rect x="70" y="48" width="60" height="14" rx="3" fill="#1a1f29"/>
            <rect x="70" y="68" width="60" height="14" rx="3" fill="#1a1f29"/>
            <rect x="70" y="88" width="60" height="18" rx="4" fill="#2a3b56" stroke="#4f8cff" stroke-width="1.5"/>
            <text x="100" y="100" text-anchor="middle" fill="#4f8cff" font-size="7" font-weight="600">Numéro de build</text>
            <circle cx="138" cy="92" r="8" fill="#4f8cff"/>
            <text x="138" y="95" text-anchor="middle" fill="#fff" font-size="7" font-weight="700">×7</text>
        </svg>`;
    }

    function renderUsbDebugIllustration() {
        return `<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="55" y="8" width="90" height="144" rx="10" fill="#11151c" stroke="#2a3344" stroke-width="2"/>
            <rect x="63" y="20" width="74" height="120" rx="4" fill="#0a0e14"/>
            <text x="100" y="36" text-anchor="middle" fill="#8b93a3" font-size="7">Options développeur</text>
            <rect x="70" y="48" width="60" height="12" rx="2" fill="#1a1f29"/>
            <rect x="70" y="66" width="60" height="12" rx="2" fill="#1a1f29"/>
            <rect x="70" y="84" width="60" height="22" rx="4" fill="#2a3b56" stroke="#4f8cff" stroke-width="1.5"/>
            <text x="78" y="98" fill="#f1f3f7" font-size="7">Débogage USB</text>
            <rect x="118" y="90" width="22" height="10" rx="5" fill="#4f8cff"/>
            <circle cx="128" cy="95" r="4" fill="#fff"/>
        </svg>`;
    }

    function renderAuthorizeIllustration() {
        return `<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="55" y="8" width="90" height="144" rx="10" fill="#11151c" stroke="#2a3344" stroke-width="2"/>
            <rect x="63" y="20" width="74" height="120" rx="4" fill="#0a0e14"/>
            <rect x="68" y="50" width="64" height="56" rx="6" fill="#161b24" stroke="#2a3344"/>
            <text x="100" y="64" text-anchor="middle" fill="#f1f3f7" font-size="6.5" font-weight="600">Autoriser le débogage USB ?</text>
            <rect x="72" y="72" width="8" height="8" rx="2" fill="none" stroke="#4f8cff" stroke-width="1"/>
            <text x="84" y="79" fill="#8b93a3" font-size="5.5">Toujours autoriser</text>
            <rect x="74" y="88" width="24" height="10" rx="3" fill="#1a1f29"/>
            <text x="86" y="96" text-anchor="middle" fill="#8b93a3" font-size="5">Annuler</text>
            <rect x="102" y="88" width="24" height="10" rx="3" fill="#4f8cff"/>
            <text x="114" y="96" text-anchor="middle" fill="#fff" font-size="5">Autoriser</text>
        </svg>`;
    }

    function renderReadyIllustration() {
        return `<svg viewBox="0 0 220 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="8" y="20" width="204" height="120" rx="8" fill="#0a0e14" stroke="#2a3344" stroke-width="1.5"/>
            <rect x="8" y="20" width="44" height="120" fill="#11151c" stroke="#2a3344"/>
            <rect x="18" y="32" width="24" height="24" rx="6" fill="#2a3b56" stroke="#4f8cff"/>
            <text x="30" y="48" text-anchor="middle" fill="#4f8cff" font-size="14">+</text>
            <rect x="14" y="68" width="32" height="32" rx="6" fill="#1a1f29" stroke="#4f8cff" stroke-width="1"/>
            <circle cx="30" cy="78" r="3" fill="#4ade80"/>
            <text x="58" y="38" fill="#5b6373" font-size="7" font-weight="600">APPAREILS CONNECTÉS</text>
            <rect x="58" y="48" width="140" height="28" rx="6" fill="#161b24" stroke="#2a3344"/>
            <circle cx="70" cy="62" r="4" fill="#4ade80"/>
            <text x="80" y="65" fill="#f1f3f7" font-size="8">Pixel — Prêt</text>
            <rect x="58" y="88" width="68" height="22" rx="5" fill="#4f8cff"/>
            <text x="92" y="102" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">Mirroring</text>
            <rect x="130" y="88" width="68" height="22" rx="5" fill="#2a3b56" stroke="#4f8cff"/>
            <text x="164" y="102" text-anchor="middle" fill="#4f8cff" font-size="7">+ Instance</text>
            <text x="110" y="152" text-anchor="middle" fill="#4ade80" font-size="9" font-weight="600">Téléphone connecté ✓</text>
        </svg>`;
    }

    function renderShortcutKeys(keys) {
        return keys.map((k) => `<kbd class="help-kbd">${k}</kbd>`).join("");
    }

    function renderWifiGuideSection() {
        const wifiGuide = getWifiGuide();
        const stepsHtml = (wifiGuide.steps || []).map((step) => `<li>${step}</li>`).join("");
        return `
            <div class="help-guide-content help-guide-content--static">
                <div class="help-guide-text">
                    <h3 class="help-guide-heading">${wifiGuide.title || ""}</h3>
                    <ol class="help-guide-steps">${stepsHtml}</ol>
                    <div class="help-guide-tip"><strong>${t("help.guide.notePrefix")}</strong> ${wifiGuide.note || ""}</div>
                </div>
            </div>
        `;
    }

    function renderShortcutsSection() {
        return getShortcutGroups().map((group) => `
            <div class="help-shortcuts-group">
                <div class="help-shortcuts-group-title">${group.title}</div>
                ${(group.items || []).map((item) => `
                    <div class="help-shortcut-row">
                        <div class="help-shortcut-keys">${renderShortcutKeys(item.keys || [])}</div>
                        <div class="help-shortcut-desc">${item.desc}</div>
                    </div>
                `).join("")}
            </div>
        `).join("");
    }

    function renderStepper() {
        const guideSteps = getGuideSteps();
        const parts = [];
        for (let i = 0; i < guideSteps.length; i++) {
            if (i > 0) {
                parts.push(`<div class="help-stepper-line${i <= currentGuideStep ? " done" : ""}"></div>`);
            }
            const dotClass = i < currentGuideStep ? "done" : i === currentGuideStep ? "active" : "";
            const content = i < currentGuideStep ? "✓" : String(i + 1);
            parts.push(`<div class="help-stepper-item"><div class="help-stepper-dot ${dotClass}">${content}</div></div>`);
        }
        return parts.join("");
    }

    function renderGuideStep() {
        const guideSteps = getGuideSteps();
        const step = guideSteps[currentGuideStep];
        if (!step) return "";

        const total = guideSteps.length;
        const stepsHtml = (step.steps || []).map((s) => `<li>${s}</li>`).join("");
        const tipHtml = step.tip
            ? `<div class="help-guide-tip"><strong>${t("help.guide.tipPrefix")}</strong> ${step.tip}</div>`
            : "";

        return `
            <div class="help-guide-stepper" id="help-guide-stepper">${renderStepper()}</div>
            <div class="help-guide-content">
                <div class="help-guide-visual">
                    <div class="help-guide-visual-label">${step.visualLabel || ""}</div>
                    ${step.illustration()}
                    <div class="help-guide-visual-caption">${step.visualCaption || ""}</div>
                </div>
                <div class="help-guide-text">
                    <div class="help-guide-step-label">${t("help.guide.stepLabel", { current: currentGuideStep + 1, total })}</div>
                    <h3 class="help-guide-heading">${step.title || ""}</h3>
                    <p class="help-guide-lead">${step.lead || ""}</p>
                    <ol class="help-guide-steps">${stepsHtml}</ol>
                    ${tipHtml}
                </div>
            </div>
        `;
    }

    function renderTroubleshootPanel() {
        return `
            <div class="help-troubleshoot-panel" id="help-troubleshoot-panel">
                <h4>${t("help.troubleshoot.title")}</h4>
                <ul>${getTroubleshootingItems().map((item) => `<li>${item}</li>`).join("")}</ul>
            </div>
        `;
    }

    function buildModal() {
        const host = document.getElementById("panel-help");
        const modalHtml = `
            <div class="help-modal" role="dialog" aria-labelledby="help-modal-title" aria-modal="true">
                <div class="help-modal-header">
                    <div class="help-modal-title-row">
                        <div class="help-modal-icon" aria-hidden="true">?</div>
                        <h2 class="help-modal-title" id="help-modal-title">${t("help.tab.title")}</h2>
                    </div>
                    <div class="hub-panel-header-actions">
                        <button type="button" class="hub-panel-refresh-btn" data-hub-panel-refresh="help" title="${t("help.tab.refresh")}">${t("help.tab.refresh")}</button>
                        <button type="button" class="help-modal-close" data-hub-modal-close id="help-modal-close" title="${t("help.tab.close")}">&#10005;</button>
                    </div>
                </div>
                <div class="help-modal-tabs">
                    <button type="button" class="help-tab-btn active" data-help-tab="shortcuts">${t("help.tab.shortcuts")}</button>
                    <button type="button" class="help-tab-btn" data-help-tab="guide">${t("help.tab.guide")}</button>
                    <button type="button" class="help-tab-btn" data-help-tab="wifi">${t("help.tab.wifi")}</button>
                </div>
                <div class="help-modal-body">
                    <section class="help-section active" id="help-section-shortcuts" data-section="shortcuts">
                        <p class="help-shortcuts-intro">${t("help.shortcuts.intro")}</p>
                        ${renderShortcutsSection()}
                    </section>
                    <section class="help-section" id="help-section-guide" data-section="guide">
                        <div id="help-guide-root">${renderGuideStep()}</div>
                        ${renderTroubleshootPanel()}
                    </section>
                    <section class="help-section" id="help-section-wifi" data-section="wifi">
                        ${renderWifiGuideSection()}
                    </section>
                </div>
                <div class="help-guide-footer" id="help-guide-footer">
                    <button type="button" class="help-troubleshoot-link" id="help-troubleshoot-toggle">${t("help.guide.showTroubleshoot")}</button>
                    <div class="help-guide-nav">
                        <button type="button" class="help-btn help-btn-secondary" id="help-guide-prev">${t("help.guide.prev")}</button>
                        <button type="button" class="help-btn help-btn-primary" id="help-guide-next">${t("help.guide.next")}</button>
                    </div>
                </div>
            </div>
        `;

        if (host) {
            host.innerHTML = modalHtml;
            return host;
        }

        const el = document.createElement("div");
        el.id = "help-modal-overlay";
        el.className = "help-modal-overlay hidden";
        el.innerHTML = modalHtml;
        document.body.appendChild(el);
        return el;
    }

    function setActiveTab(tabId) {
        const root = overlayEl.querySelector(".help-modal") || overlayEl;
        root.querySelectorAll(".help-tab-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.helpTab === tabId);
        });
        root.querySelectorAll(".help-section").forEach((section) => {
            section.classList.toggle("active", section.dataset.section === tabId);
        });
        const footer = root.querySelector("#help-guide-footer");
        if (footer) {
            footer.style.display = tabId === "guide" ? "flex" : "none";
        }
    }

    function updateGuideNav() {
        const root = overlayEl.querySelector(".help-modal") || overlayEl;
        const prevBtn = root.querySelector("#help-guide-prev");
        const nextBtn = root.querySelector("#help-guide-next");
        if (!prevBtn || !nextBtn) return;

        const guideSteps = getGuideSteps();
        prevBtn.disabled = currentGuideStep === 0;
        nextBtn.textContent = currentGuideStep >= guideSteps.length - 1
            ? t("help.guide.finish")
            : t("help.guide.next");
    }

    function refreshGuideView() {
        const root = overlayEl.querySelector(".help-modal") || overlayEl;
        const guideRoot = root.querySelector("#help-guide-root");
        if (guideRoot) guideRoot.innerHTML = renderGuideStep();
        updateGuideNav();
    }

    function openHelpPanel(tab) {
        if (!overlayEl) overlayEl = buildModal();
        currentGuideStep = 0;
        refreshGuideView();
        setActiveTab(tab || "shortcuts");
        overlayEl.querySelector("#help-troubleshoot-panel")?.classList.remove("visible");
        overlayEl.querySelector(".help-modal-close")?.focus();
    }

    function closeHelpPanel() {
        if (window.hubModalWindowAPI?.close) {
            window.hubModalWindowAPI.close();
        }
    }

    function wireEvents() {
        overlayEl.querySelector("#help-modal-close")?.addEventListener("click", closeHelpPanel);

        overlayEl.querySelectorAll(".help-tab-btn").forEach((btn) => {
            btn.addEventListener("click", () => setActiveTab(btn.dataset.helpTab));
        });

        overlayEl.querySelector("#help-guide-prev")?.addEventListener("click", () => {
            if (currentGuideStep > 0) {
                currentGuideStep -= 1;
                refreshGuideView();
            }
        });

        overlayEl.querySelector("#help-guide-next")?.addEventListener("click", () => {
            const guideSteps = getGuideSteps();
            if (currentGuideStep >= guideSteps.length - 1) {
                closeHelpPanel();
                return;
            }
            currentGuideStep += 1;
            refreshGuideView();
        });

        overlayEl.querySelector("#help-troubleshoot-toggle")?.addEventListener("click", () => {
            overlayEl.querySelector("#help-troubleshoot-panel")?.classList.toggle("visible");
        });
    }

    function refreshHelpPanel() {
        const root = overlayEl?.querySelector(".help-modal") || overlayEl;
        const activeTab = root?.querySelector(".help-tab-btn.active")?.dataset.helpTab || "shortcuts";
        const savedStep = currentGuideStep;
        overlayEl = buildModal();
        wireEvents();
        currentGuideStep = Math.min(savedStep, Math.max(0, getGuideSteps().length - 1));
        refreshGuideView();
        setActiveTab(activeTab);
        overlayEl.querySelector("#help-troubleshoot-panel")?.classList.remove("visible");
    }

    overlayEl = buildModal();
    wireEvents();

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        closeHelpPanel();
    });

    globalThis.HubI18n?.onChange?.(() => {
        refreshHelpPanel();
    });

    window.openHelpPanel = openHelpPanel;
    window.closeHelpPanel = closeHelpPanel;
    window.refreshHelpPanel = refreshHelpPanel;
})();
