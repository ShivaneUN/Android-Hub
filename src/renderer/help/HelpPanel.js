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

    const WIFI_ILLUSTRATIONS = [
        renderUsbIllustration,
        renderWifiNetworkIllustration,
        renderWifiToggleIllustration,
        renderWifiUnplugIllustration
    ];

    const NAV_ITEMS = [
        { id: "shortcuts", icon: "keys" },
        { id: "guide", icon: "mirror" },
        { id: "wifi", icon: "wifi" },
        { id: "troubleshoot", icon: "wrench" }
    ];

    let currentGuideStep = 0;
    let currentWifiStep = 0;
    let overlayEl = null;

    function getGuideSteps() {
        const steps = tArray("help.guide.steps");
        return steps.map((step, index) => ({
            ...step,
            illustration: GUIDE_ILLUSTRATIONS[index] || (() => "")
        }));
    }

    function getWifiSteps() {
        const wifi = tObject("help.wifi");
        const steps = Array.isArray(wifi.steps) ? wifi.steps : [];
        return steps.map((step, index) => ({
            ...step,
            illustration: WIFI_ILLUSTRATIONS[index] || (() => "")
        }));
    }

    function getShortcutGroups() {
        const groups = t("help.shortcuts.groups");
        return Array.isArray(groups) ? groups : [];
    }

    function getTroubleshootingItems() {
        return tArray("help.troubleshoot.items");
    }

    function navLabel(id) {
        if (id === "troubleshoot") return t("help.tab.troubleshoot");
        return t(`help.tab.${id}`);
    }

    function navIcon(type) {
        const icons = {
            keys: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h2M11 10h2M16 10h2M8 14h8"/></svg>`,
            mirror: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="10" height="16" rx="1.5"/><rect x="15" y="7" width="6" height="10" rx="1"/><path d="M13 12h2"/></svg>`,
            wifi: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12.5a9 9 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg>`,
            wrench: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-1.9-1.9 2-2.1z"/></svg>`
        };
        return icons[type] || "";
    }

    /* Illustrations sans filtres SVG (instables dans Electron) — formes solides lisibles. */

    function renderUsbIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Téléphone -->
            <rect x="28" y="40" width="88" height="152" rx="14" fill="#1a2230" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="38" y="56" width="68" height="116" rx="6" fill="#0b1220"/>
            <rect x="58" y="46" width="28" height="5" rx="2.5" fill="#3a465c"/>
            <circle cx="72" cy="182" r="5" fill="#3a465c"/>
            <!-- Écran hint -->
            <rect x="48" y="72" width="48" height="8" rx="2" fill="#1e2a3d"/>
            <rect x="48" y="88" width="36" height="6" rx="2" fill="#162033"/>
            <rect x="48" y="100" width="42" height="6" rx="2" fill="#162033"/>
            <!-- Port USB téléphone -->
            <rect x="108" y="108" width="10" height="12" rx="2" fill="#4f8cff"/>
            <!-- Câble USB -->
            <path d="M118 114 H148" stroke="#4f8cff" stroke-width="5" stroke-linecap="round"/>
            <path d="M148 114 C170 114, 178 92, 198 92" stroke="#4f8cff" stroke-width="5" fill="none" stroke-linecap="round"/>
            <rect x="148" y="108" width="14" height="12" rx="2" fill="#6aa4ff"/>
            <!-- PC / laptop -->
            <rect x="198" y="58" width="84" height="56" rx="6" fill="#222a38" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="206" y="66" width="68" height="40" rx="3" fill="#0b1220"/>
            <rect x="224" y="78" width="32" height="16" rx="3" fill="#1e2f4d" stroke="#4f8cff" stroke-width="1.5"/>
            <text x="240" y="89" text-anchor="middle" fill="#9ec0ff" font-size="8" font-weight="700" font-family="Segoe UI,sans-serif">HUB</text>
            <rect x="188" y="114" width="104" height="12" rx="3" fill="#1a2230" stroke="#3a465c" stroke-width="1.5"/>
            <rect x="228" y="116" width="24" height="4" rx="1" fill="#2a3344"/>
            <!-- Connecteur PC -->
            <rect x="198" y="86" width="8" height="10" rx="1.5" fill="#4f8cff"/>
            <text x="72" y="218" text-anchor="middle" fill="#9aa3b5" font-size="13" font-family="Segoe UI,sans-serif">Téléphone</text>
            <text x="240" y="150" text-anchor="middle" fill="#9aa3b5" font-size="13" font-family="Segoe UI,sans-serif">PC</text>
            <text x="150" y="228" text-anchor="middle" fill="#4f8cff" font-size="12" font-weight="600" font-family="Segoe UI,sans-serif">Câble USB données</text>
        </svg>`;
    }

    function renderDevOptionsIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="98" y="18" width="104" height="180" rx="16" fill="#1a2230" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="108" y="36" width="84" height="148" rx="6" fill="#0b1220"/>
            <rect x="132" y="26" width="36" height="5" rx="2.5" fill="#3a465c"/>
            <circle cx="150" cy="192" r="5" fill="#3a465c"/>
            <text x="150" y="58" text-anchor="middle" fill="#8b93a3" font-size="11" font-family="Segoe UI,sans-serif">À propos</text>
            <rect x="118" y="70" width="64" height="14" rx="4" fill="#1a2230"/>
            <rect x="118" y="92" width="64" height="14" rx="4" fill="#1a2230"/>
            <rect x="118" y="118" width="64" height="30" rx="8" fill="#1e2f4d" stroke="#4f8cff" stroke-width="2"/>
            <text x="150" y="137" text-anchor="middle" fill="#9ec0ff" font-size="11" font-weight="650" font-family="Segoe UI,sans-serif">N° de build</text>
            <circle cx="210" cy="133" r="20" fill="#4f8cff"/>
            <text x="210" y="139" text-anchor="middle" fill="#fff" font-size="14" font-weight="800" font-family="Segoe UI,sans-serif">×7</text>
            <text x="150" y="228" text-anchor="middle" fill="#9aa3b5" font-size="13" font-family="Segoe UI,sans-serif">Appuyez 7 fois</text>
        </svg>`;
    }

    function renderUsbDebugIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="98" y="18" width="104" height="180" rx="16" fill="#1a2230" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="108" y="36" width="84" height="148" rx="6" fill="#0b1220"/>
            <rect x="132" y="26" width="36" height="5" rx="2.5" fill="#3a465c"/>
            <circle cx="150" cy="192" r="5" fill="#3a465c"/>
            <text x="150" y="56" text-anchor="middle" fill="#8b93a3" font-size="11" font-family="Segoe UI,sans-serif">Développeur</text>
            <rect x="118" y="70" width="64" height="14" rx="4" fill="#1a2230"/>
            <rect x="118" y="92" width="64" height="14" rx="4" fill="#1a2230"/>
            <rect x="116" y="118" width="68" height="36" rx="8" fill="#1e2f4d" stroke="#4f8cff" stroke-width="2"/>
            <text x="126" y="135" fill="#e8eef8" font-size="11" font-family="Segoe UI,sans-serif">Débogage USB</text>
            <rect x="168" y="142" width="32" height="16" rx="8" fill="#4f8cff"/>
            <circle cx="188" cy="150" r="6" fill="#fff"/>
            <text x="150" y="228" text-anchor="middle" fill="#9aa3b5" font-size="13" font-family="Segoe UI,sans-serif">Activez le débogage</text>
        </svg>`;
    }

    function renderAuthorizeIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="98" y="18" width="104" height="180" rx="16" fill="#1a2230" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="108" y="36" width="84" height="148" rx="6" fill="#0b1220"/>
            <rect x="132" y="26" width="36" height="5" rx="2.5" fill="#3a465c"/>
            <rect x="116" y="58" width="68" height="90" rx="10" fill="#151c28" stroke="#3a465c" stroke-width="1.5"/>
            <text x="150" y="78" text-anchor="middle" fill="#f1f3f7" font-size="10" font-weight="650" font-family="Segoe UI,sans-serif">Autoriser USB ?</text>
            <rect x="124" y="90" width="12" height="12" rx="2" fill="none" stroke="#4f8cff" stroke-width="2"/>
            <path d="M127 96 l3 3 5-6" stroke="#4f8cff" stroke-width="2" fill="none" stroke-linecap="round"/>
            <text x="142" y="100" fill="#9aa3b5" font-size="9" font-family="Segoe UI,sans-serif">Toujours</text>
            <rect x="122" y="116" width="28" height="18" rx="5" fill="#1a2230"/>
            <text x="136" y="128" text-anchor="middle" fill="#8b93a3" font-size="9" font-family="Segoe UI,sans-serif">Non</text>
            <rect x="154" y="116" width="28" height="18" rx="5" fill="#4f8cff"/>
            <text x="168" y="128" text-anchor="middle" fill="#fff" font-size="9" font-weight="700" font-family="Segoe UI,sans-serif">Oui</text>
            <text x="150" y="228" text-anchor="middle" fill="#9aa3b5" font-size="13" font-family="Segoe UI,sans-serif">Sur le téléphone</text>
        </svg>`;
    }

    function renderReadyIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Téléphone + PC côte à côte, connectés -->
            <rect x="24" y="36" width="78" height="136" rx="12" fill="#1a2230" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="32" y="50" width="62" height="102" rx="5" fill="#0b1220"/>
            <circle cx="63" cy="162" r="4" fill="#3a465c"/>
            <circle cx="63" cy="78" r="6" fill="#4ade80"/>
            <text x="63" y="108" text-anchor="middle" fill="#9ec0ff" font-size="10" font-family="Segoe UI,sans-serif">Prêt</text>
            <rect x="94" y="98" width="8" height="10" rx="1.5" fill="#4f8cff"/>
            <path d="M102 103 H128" stroke="#4f8cff" stroke-width="4" stroke-linecap="round"/>
            <rect x="128" y="52" width="148" height="88" rx="10" fill="#161b24" stroke="#4a5870" stroke-width="2"/>
            <rect x="138" y="62" width="128" height="52" rx="4" fill="#0b1220"/>
            <rect x="148" y="72" width="50" height="22" rx="5" fill="#4f8cff"/>
            <text x="173" y="87" text-anchor="middle" fill="#fff" font-size="10" font-weight="700" font-family="Segoe UI,sans-serif">Mirroring</text>
            <rect x="206" y="72" width="50" height="22" rx="5" fill="#1e2f4d" stroke="#4f8cff"/>
            <text x="231" y="87" text-anchor="middle" fill="#9ec0ff" font-size="10" font-family="Segoe UI,sans-serif">Instance</text>
            <rect x="148" y="102" width="100" height="8" rx="2" fill="#1a2230"/>
            <text x="63" y="198" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">Téléphone</text>
            <text x="202" y="168" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">Android Hub</text>
            <text x="150" y="226" text-anchor="middle" fill="#4ade80" font-size="14" font-weight="700" font-family="Segoe UI,sans-serif">Connecté ✓</text>
        </svg>`;
    }

    function renderWifiNetworkIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Téléphone -->
            <rect x="28" y="48" width="72" height="124" rx="12" fill="#1a2230" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="36" y="62" width="56" height="90" rx="5" fill="#0b1220"/>
            <circle cx="64" cy="162" r="4" fill="#3a465c"/>
            <path d="M48 78 a16 16 0 0 1 32 0" stroke="#4f8cff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <path d="M54 86 a8 8 0 0 1 20 0" stroke="#7eb0ff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <circle cx="64" cy="94" r="3" fill="#4f8cff"/>
            <!-- PC -->
            <rect x="196" y="64" width="80" height="52" rx="6" fill="#222a38" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="204" y="72" width="64" height="32" rx="3" fill="#0b1220"/>
            <rect x="188" y="116" width="96" height="10" rx="3" fill="#1a2230" stroke="#3a465c"/>
            <path d="M220 82 a12 12 0 0 1 24 0" stroke="#4f8cff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <path d="M226 90 a6 6 0 0 1 12 0" stroke="#7eb0ff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <circle cx="232" cy="96" r="2.5" fill="#4f8cff"/>
            <!-- Routeur / réseau au centre -->
            <circle cx="150" cy="100" r="22" fill="#1e2f4d" stroke="#4f8cff" stroke-width="2"/>
            <rect x="142" y="90" width="16" height="12" rx="2" fill="#4f8cff"/>
            <rect x="146" y="102" width="8" height="10" rx="1" fill="#7eb0ff"/>
            <path d="M100 100 H128" stroke="#4f8cff" stroke-width="2" stroke-dasharray="4 3"/>
            <path d="M172 100 H196" stroke="#4f8cff" stroke-width="2" stroke-dasharray="4 3"/>
            <text x="64" y="198" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">Téléphone</text>
            <text x="236" y="150" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">PC</text>
            <text x="150" y="226" text-anchor="middle" fill="#4f8cff" font-size="13" font-weight="600" font-family="Segoe UI,sans-serif">Même WiFi</text>
        </svg>`;
    }

    function renderWifiToggleIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Sidebar + téléphone branché USB -->
            <rect x="20" y="40" width="160" height="140" rx="12" fill="#0c121a" stroke="#2a3344" stroke-width="2"/>
            <text x="36" y="64" fill="#6b7385" font-size="10" font-weight="700" font-family="Segoe UI,sans-serif">APPAREILS</text>
            <rect x="32" y="78" width="136" height="44" rx="10" fill="#161b24" stroke="#2f3a4d"/>
            <circle cx="52" cy="100" r="7" fill="#4ade80"/>
            <text x="68" y="104" fill="#f1f3f7" font-size="12" font-weight="600" font-family="Segoe UI,sans-serif">Xiaomi</text>
            <rect x="128" y="90" width="32" height="20" rx="10" fill="#4f8cff"/>
            <circle cx="148" cy="100" r="7" fill="#fff"/>
            <path d="M136 78 a10 10 0 0 1 16 0" stroke="#7eb0ff" stroke-width="2" fill="none" stroke-linecap="round"/>
            <!-- Petit téléphone + câble à droite -->
            <rect x="208" y="56" width="58" height="100" rx="10" fill="#1a2230" stroke="#4a5870" stroke-width="2"/>
            <rect x="216" y="68" width="42" height="72" rx="4" fill="#0b1220"/>
            <rect x="200" y="100" width="10" height="10" rx="2" fill="#4f8cff"/>
            <path d="M180 105 H200" stroke="#4f8cff" stroke-width="3" stroke-linecap="round"/>
            <text x="100" y="210" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">Sidebar Hub</text>
            <text x="237" y="180" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">USB</text>
            <text x="150" y="230" text-anchor="middle" fill="#4f8cff" font-size="13" font-weight="600" font-family="Segoe UI,sans-serif">Activez le toggle WiFi</text>
        </svg>`;
    }

    function renderWifiUnplugIllustration() {
        return `<svg viewBox="0 0 300 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Téléphone sans câble + PC WiFi -->
            <rect x="40" y="36" width="80" height="140" rx="14" fill="#1a2230" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="50" y="52" width="60" height="104" rx="5" fill="#0b1220"/>
            <rect x="68" y="42" width="24" height="5" rx="2.5" fill="#3a465c"/>
            <circle cx="80" cy="166" r="5" fill="#3a465c"/>
            <path d="M64 72 a20 20 0 0 1 32 0" stroke="#4f8cff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <path d="M70 82 a12 12 0 0 1 20 0" stroke="#7eb0ff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <circle cx="80" cy="92" r="3.5" fill="#4f8cff"/>
            <!-- Câble débranché (pointillé) -->
            <path d="M120 110 H168" stroke="#5b6373" stroke-width="3" stroke-dasharray="6 5" stroke-linecap="round"/>
            <path d="M160 104 l10 6 -10 6" stroke="#5b6373" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <text x="144" y="100" text-anchor="middle" fill="#8b93a3" font-size="10" font-family="Segoe UI,sans-serif">USB</text>
            <!-- PC -->
            <rect x="180" y="60" width="88" height="56" rx="6" fill="#222a38" stroke="#4a5870" stroke-width="2.5"/>
            <rect x="188" y="68" width="72" height="36" rx="3" fill="#0b1220"/>
            <rect x="170" y="116" width="108" height="11" rx="3" fill="#1a2230" stroke="#3a465c"/>
            <path d="M208 78 a14 14 0 0 1 28 0" stroke="#4f8cff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <circle cx="222" cy="90" r="3" fill="#4ade80"/>
            <text x="80" y="202" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">Téléphone</text>
            <text x="224" y="150" text-anchor="middle" fill="#9aa3b5" font-size="12" font-family="Segoe UI,sans-serif">PC</text>
            <text x="150" y="228" text-anchor="middle" fill="#4ade80" font-size="14" font-weight="700" font-family="Segoe UI,sans-serif">Sans câble · WiFi actif</text>
        </svg>`;
    }

    function renderShortcutKeys(keys) {
        const parts = [];
        (keys || []).forEach((k, i) => {
            if (i > 0) parts.push(`<span class="help-kbd-plus">+</span>`);
            parts.push(`<kbd class="help-kbd">${k}</kbd>`);
        });
        return parts.join("");
    }

    function renderShortcutsSection() {
        return `
            <p class="help-shortcuts-intro">${t("help.shortcuts.intro")}</p>
            <div class="help-shortcuts-list">
                ${getShortcutGroups().map((group) => `
                    <div class="help-shortcuts-group">
                        <div class="help-shortcuts-group-title">${group.title}</div>
                        <div class="help-shortcuts-cards">
                            ${(group.items || []).map((item) => `
                                <div class="help-shortcut-row">
                                    <div class="help-shortcut-keys">${renderShortcutKeys(item.keys || [])}</div>
                                    <div class="help-shortcut-desc">${item.desc}</div>
                                </div>
                            `).join("")}
                        </div>
                    </div>
                `).join("")}
            </div>
        `;
    }

    function renderStepper(steps, current, idPrefix) {
        const parts = [];
        for (let i = 0; i < steps.length; i++) {
            if (i > 0) {
                parts.push(`<div class="help-stepper-line${i <= current ? " done" : ""}"></div>`);
            }
            const dotClass = i < current ? "done" : i === current ? "active" : "";
            const content = i < current ? "✓" : String(i + 1);
            const chip = steps[i].chipLabel || steps[i].visualLabel || "";
            parts.push(`
                <div class="help-stepper-item" data-${idPrefix}-step="${i}">
                    <div class="help-stepper-dot ${dotClass}">${content}</div>
                    ${chip ? `<span class="help-stepper-chip${i === current ? " active" : ""}">${chip}</span>` : ""}
                </div>
            `);
        }
        return parts.join("");
    }

    function renderWizardStep(step, current, total, illustrationFn) {
        if (!step) return "";
        const stepsHtml = (step.steps || []).map((s) => `<li>${s}</li>`).join("");
        const tipHtml = step.tip
            ? `<div class="help-guide-tip"><strong>${t("help.guide.tipPrefix")}</strong> ${step.tip}</div>`
            : "";

        return `
            <div class="help-guide-content">
                <div class="help-guide-visual">
                    <div class="help-guide-visual-label">${step.visualLabel || ""}</div>
                    ${illustrationFn ? illustrationFn() : ""}
                    <div class="help-guide-visual-caption">${step.visualCaption || ""}</div>
                </div>
                <div class="help-guide-text">
                    <div class="help-guide-step-label">${t("help.guide.stepLabel", { current: current + 1, total })}</div>
                    <h3 class="help-guide-heading">${step.title || ""}</h3>
                    <p class="help-guide-lead">${step.lead || ""}</p>
                    <ol class="help-guide-steps">${stepsHtml}</ol>
                    ${tipHtml}
                </div>
            </div>
        `;
    }

    function renderGuideSection() {
        const steps = getGuideSteps();
        const step = steps[currentGuideStep];
        return `
            <div class="help-guide-stepper" id="help-guide-stepper">${renderStepper(steps, currentGuideStep, "guide")}</div>
            <div id="help-guide-root">${renderWizardStep(step, currentGuideStep, steps.length, step?.illustration)}</div>
        `;
    }

    function renderWifiSection() {
        const wifi = tObject("help.wifi");
        const steps = getWifiSteps();
        const step = steps[currentWifiStep];
        const noteHtml = wifi.note
            ? `<div class="help-guide-note"><strong>${t("help.guide.notePrefix")}</strong> ${wifi.note}</div>`
            : "";
        return `
            <div class="help-section-title-row">
                <h3 class="help-section-heading">${wifi.title || ""}</h3>
            </div>
            <div class="help-guide-stepper help-guide-stepper--chips" id="help-wifi-stepper">${renderStepper(steps, currentWifiStep, "wifi")}</div>
            <div id="help-wifi-root">${renderWizardStep(step, currentWifiStep, steps.length, step?.illustration)}</div>
            ${noteHtml}
        `;
    }

    function renderTroubleshootSection() {
        return `
            <h3 class="help-section-heading">${t("help.troubleshoot.title")}</h3>
            <ul class="help-troubleshoot-list">
                ${getTroubleshootingItems().map((item) => `<li>${item}</li>`).join("")}
            </ul>
        `;
    }

    function renderNav() {
        return NAV_ITEMS.map((item) => `
            <button type="button" class="help-nav-btn${item.id === "shortcuts" ? " active" : ""}" data-help-tab="${item.id}">
                <span class="help-nav-icon" aria-hidden="true">${navIcon(item.icon)}</span>
                <span class="help-nav-label">${navLabel(item.id)}</span>
            </button>
        `).join("");
    }

    function buildModal() {
        const host = document.getElementById("panel-help");
        const modalHtml = `
            <div class="help-modal help-modal--redesign" role="dialog" aria-labelledby="help-modal-title" aria-modal="true">
                <div class="help-modal-header">
                    <div class="help-modal-title-row">
                        <div class="help-modal-icon" aria-hidden="true">?</div>
                        <div>
                            <h2 class="help-modal-title" id="help-modal-title">${t("help.tab.title")}</h2>
                            <p class="help-modal-subtitle">${t("help.tab.subtitle")}</p>
                        </div>
                    </div>
                    <div class="hub-panel-header-actions">
                        <button type="button" class="hub-panel-refresh-btn" data-hub-panel-refresh="help" title="${t("help.tab.refresh")}">${t("help.tab.refresh")}</button>
                        <button type="button" class="help-modal-close" data-hub-modal-close id="help-modal-close" title="${t("help.tab.close")}">&#10005;</button>
                    </div>
                </div>
                <div class="help-modal-layout">
                    <aside class="help-modal-nav" aria-label="${t("help.tab.title")}">
                        ${renderNav()}
                    </aside>
                    <div class="help-modal-main">
                        <div class="help-modal-body">
                            <section class="help-section active" id="help-section-shortcuts" data-section="shortcuts">
                                ${renderShortcutsSection()}
                            </section>
                            <section class="help-section" id="help-section-guide" data-section="guide">
                                ${renderGuideSection()}
                            </section>
                            <section class="help-section" id="help-section-wifi" data-section="wifi">
                                ${renderWifiSection()}
                            </section>
                            <section class="help-section" id="help-section-troubleshoot" data-section="troubleshoot">
                                ${renderTroubleshootSection()}
                            </section>
                        </div>
                        <div class="help-guide-footer" id="help-guide-footer">
                            <button type="button" class="help-troubleshoot-link" id="help-troubleshoot-goto">${t("help.guide.showTroubleshoot")}</button>
                            <div class="help-guide-nav">
                                <button type="button" class="help-btn help-btn-secondary" id="help-guide-prev">${t("help.guide.prev")}</button>
                                <button type="button" class="help-btn help-btn-primary" id="help-guide-next">${t("help.guide.next")}</button>
                            </div>
                        </div>
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

    function getActiveTab() {
        const root = overlayEl?.querySelector(".help-modal") || overlayEl;
        return root?.querySelector(".help-nav-btn.active")?.dataset.helpTab || "shortcuts";
    }

    function isWizardTab(tabId) {
        return tabId === "guide" || tabId === "wifi";
    }

    function setActiveTab(tabId) {
        const root = overlayEl.querySelector(".help-modal") || overlayEl;
        root.querySelectorAll(".help-nav-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.helpTab === tabId);
        });
        root.querySelectorAll(".help-section").forEach((section) => {
            section.classList.toggle("active", section.dataset.section === tabId);
        });
        const footer = root.querySelector("#help-guide-footer");
        if (footer) {
            footer.style.display = isWizardTab(tabId) ? "flex" : "none";
        }
        updateWizardNav();
    }

    function updateWizardNav() {
        const root = overlayEl.querySelector(".help-modal") || overlayEl;
        const prevBtn = root.querySelector("#help-guide-prev");
        const nextBtn = root.querySelector("#help-guide-next");
        if (!prevBtn || !nextBtn) return;

        const tab = getActiveTab();
        if (tab === "wifi") {
            const steps = getWifiSteps();
            prevBtn.disabled = currentWifiStep === 0;
            nextBtn.textContent = currentWifiStep >= steps.length - 1
                ? t("help.guide.finish")
                : t("help.guide.next");
            return;
        }

        const guideSteps = getGuideSteps();
        prevBtn.disabled = currentGuideStep === 0;
        nextBtn.textContent = currentGuideStep >= guideSteps.length - 1
            ? t("help.guide.finish")
            : t("help.guide.next");
    }

    function refreshGuideView() {
        const root = overlayEl.querySelector(".help-modal") || overlayEl;
        const section = root.querySelector("#help-section-guide");
        if (section) section.innerHTML = renderGuideSection();
        updateWizardNav();
    }

    function refreshWifiView() {
        const root = overlayEl.querySelector(".help-modal") || overlayEl;
        const section = root.querySelector("#help-section-wifi");
        if (section) section.innerHTML = renderWifiSection();
        updateWizardNav();
    }

    function openHelpPanel(tab) {
        if (!overlayEl) overlayEl = buildModal();
        currentGuideStep = 0;
        currentWifiStep = 0;
        refreshGuideView();
        refreshWifiView();
        setActiveTab(tab || "shortcuts");
        overlayEl.querySelector(".help-modal-close")?.focus();
    }

    function closeHelpPanel() {
        if (window.hubModalWindowAPI?.close) {
            window.hubModalWindowAPI.close();
        }
    }

    function wireEvents() {
        overlayEl.querySelector("#help-modal-close")?.addEventListener("click", closeHelpPanel);

        overlayEl.querySelectorAll(".help-nav-btn").forEach((btn) => {
            btn.addEventListener("click", () => setActiveTab(btn.dataset.helpTab));
        });

        overlayEl.querySelector("#help-guide-prev")?.addEventListener("click", () => {
            const tab = getActiveTab();
            if (tab === "wifi") {
                if (currentWifiStep > 0) {
                    currentWifiStep -= 1;
                    refreshWifiView();
                }
                return;
            }
            if (currentGuideStep > 0) {
                currentGuideStep -= 1;
                refreshGuideView();
            }
        });

        overlayEl.querySelector("#help-guide-next")?.addEventListener("click", () => {
            const tab = getActiveTab();
            if (tab === "wifi") {
                const steps = getWifiSteps();
                if (currentWifiStep >= steps.length - 1) {
                    closeHelpPanel();
                    return;
                }
                currentWifiStep += 1;
                refreshWifiView();
                return;
            }
            const guideSteps = getGuideSteps();
            if (currentGuideStep >= guideSteps.length - 1) {
                closeHelpPanel();
                return;
            }
            currentGuideStep += 1;
            refreshGuideView();
        });

        overlayEl.querySelector("#help-troubleshoot-goto")?.addEventListener("click", () => {
            setActiveTab("troubleshoot");
        });
    }

    function refreshHelpPanel() {
        const activeTab = getActiveTab();
        const savedGuide = currentGuideStep;
        const savedWifi = currentWifiStep;
        overlayEl = buildModal();
        wireEvents();
        currentGuideStep = Math.min(savedGuide, Math.max(0, getGuideSteps().length - 1));
        currentWifiStep = Math.min(savedWifi, Math.max(0, getWifiSteps().length - 1));
        refreshGuideView();
        refreshWifiView();
        setActiveTab(activeTab);
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
