(function initHelpPanel() {
    function isHubModalChildWindow() {
        return /hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"));
    }

    if (!isHubModalChildWindow()) {
        return;
    }

    const GUIDE_STEPS = [
        {
            visualLabel: "Connexion USB",
            visualCaption: "Utilisez un câble de données",
            title: "Branchez votre téléphone",
            lead: "Utilisez un câble USB de données (pas seulement de charge).",
            steps: [
                "Branchez votre téléphone Android à votre ordinateur via USB.",
                "Sur le téléphone, choisissez « Transfert de fichiers » (MTP) si Android demande le mode USB.",
                "Évitez les hubs USB bon marché — branchez directement à l'ordinateur si possible."
            ],
            tip: "Astuce : si rien ne se passe en branchant le câble, c'est souvent un câble de charge uniquement. Essayez celui fourni avec votre téléphone.",
            illustration: renderUsbIllustration
        },
        {
            visualLabel: "Options développeur",
            visualCaption: "À faire une seule fois",
            title: "Activez les options développeur",
            lead: "Cette étape n'est nécessaire qu'une seule fois par appareil.",
            steps: [
                "Ouvrez Paramètres → À propos du téléphone.",
                "Repérez « Numéro de build » (ou « Numéro de version »).",
                "Appuyez 7 fois dessus jusqu'au message « Vous êtes développeur »."
            ],
            tip: "Le libellé exact varie selon la marque (Samsung, Xiaomi, etc.) mais le principe reste le même.",
            illustration: renderDevOptionsIllustration
        },
        {
            visualLabel: "Débogage USB",
            visualCaption: "Paramètres développeur",
            title: "Activez le débogage USB",
            lead: "Android Hub communique avec votre téléphone via ADB — le débogage USB est requis.",
            steps: [
                "Allez dans Paramètres → Système → Options pour les développeurs.",
                "Activez l'option « Débogage USB ».",
                "Sur Xiaomi / Realme / Oppo : autorisez aussi « Débogage USB (paramètres de sécurité) » si proposé."
            ],
            tip: "Sur certaines marques, les options développeur sont dans Paramètres → Paramètres supplémentaires.",
            illustration: renderUsbDebugIllustration
        },
        {
            visualLabel: "Autorisation",
            visualCaption: "Fenêtre sur le téléphone",
            title: "Autorisez la connexion",
            lead: "Votre téléphone va demander de faire confiance à cet ordinateur.",
            steps: [
                "Une fenêtre « Autoriser le débogage USB ? » apparaît sur le téléphone.",
                "Cochez « Toujours autoriser depuis cet ordinateur ».",
                "Appuyez sur « Autoriser »."
            ],
            tip: "Si la fenêtre n'apparaît pas, débranchez/rebranchez le câble et déverrouillez l'écran du téléphone.",
            illustration: renderAuthorizeIllustration
        },
        {
            visualLabel: "Android Hub",
            visualCaption: "Appareil détecté",
            title: "Vous êtes prêt !",
            lead: "Votre téléphone est maintenant détecté par Android Hub.",
            steps: [
                "L'appareil apparaît dans le panneau « Appareils connectés » à gauche.",
                "Ouvrez « Nouvelle instance », sélectionnez l'appareil puis une application — ou cliquez « Mirroring » pour afficher l'écran complet.",
                "Chaque session s'ouvre dans un onglet dédié que vous pouvez contrôler à la souris et au clavier."
            ],
            tip: "Double-cliquez une entrée de l'historique pour relancer rapidement une application déjà utilisée.",
            illustration: renderReadyIllustration
        }
    ];

    const WIFI_GUIDE = {
        title: "Connecter un appareil en WiFi",
        steps: [
            "Branche ton appareil en USB et assure-toi qu'il est bien détecté dans le Hub (débogage USB activé sur le téléphone).",
            "Vérifie que ton téléphone est connecté au WiFi, sur le même réseau que cet ordinateur.",
            "Clique sur le toggle WiFi à côté de l'appareil dans la sidebar.",
            "À la première connexion, le Hub va automatiquement configurer l'appareil et te demander de lui donner un nom. Une fois connecté, un message « Connecté en WiFi » s'affiche.",
            "Tu peux maintenant débrancher le câble USB — l'appareil reste joignable tant qu'il est sur le même réseau WiFi.",
            "Pour repasser en USB, reclique simplement sur le toggle (le WiFi sera désactivé, mais la configuration reste enregistrée pour la prochaine fois).",
            "Retrouve tous tes appareils WiFi et USB, avec leur historique, dans le panneau « Appareils » (icône 📶 dans la barre principale)."
        ],
        note: "Si le WiFi du téléphone change de réseau ou si son adresse IP change, il se peut que tu doives reconnecter l'appareil via le toggle."
    };

    const SHORTCUT_GROUPS = [
        {
            title: "Navigation",
            items: [
                { keys: ["Ctrl", "Tab"], desc: "Passer à l'onglet session suivant." },
                { keys: ["Ctrl", "Shift", "Tab"], desc: "Revenir à l'onglet session précédent." }
            ]
        },
        {
            title: "Contrôle du flux (session active)",
            items: [
                { keys: ["Clic"], desc: "Taper / cliquer sur l'écran Android (canvas vidéo focalisé)." },
                { keys: ["Clic droit"], desc: "Touche Retour Android." }
            ]
        },
        {
            title: "Nouvelle instance",
            items: [
                { keys: ["Double-clic"], desc: "Relancer une application depuis la section Historique." }
            ]
        },
        {
            title: "Dialogues",
            items: [
                { keys: ["Entrée"], desc: "Valider le renommage d'une session ou d'un appareil." },
                { keys: ["Échap"], desc: "Annuler le renommage." }
            ]
        },
        {
            title: "Appareils connectés (sidebar)",
            items: [
                { keys: ["Double-clic"], desc: "Lancer le mirroring de l'écran complet pour l'appareil (équivalent au bouton Mirroring)." }
            ]
        },
        {
            title: "Clic droit — Appareils connectés (sidebar)",
            items: [
                { keys: ["Renommer"], desc: "Ouvrir le dialogue pour personnaliser le nom affiché dans la liste des appareils." },
                { keys: ["Réinitialiser le nom"], desc: "Revenir au nom d'origine (visible uniquement si l'appareil a été renommé)." },
                { keys: ["Couleur → Auto"], desc: "Attribuer automatiquement une couleur distincte à chaque appareil connecté." },
                { keys: ["Couleur → teinte"], desc: "Choisir une couleur fixe (Rouge, Orange, Jaune, Vert, Turquoise, Bleu, Violet, Rose, Marron, Ardoise) pour identifier l'appareil dans la sidebar et les onglets." }
            ]
        },
        {
            title: "Clic droit — Onglets de session",
            items: [
                { keys: ["Renommer"], desc: "Personnaliser le libellé de l'onglet (mirroring ou instance d'application)." },
                { keys: ["Réinitialiser le nom"], desc: "Restaurer le libellé d'origine (visible uniquement si l'onglet a été renommé)." },
                { keys: ["Fermer"], desc: "Fermer la session vidéo et retirer l'onglet." }
            ]
        }
    ];

    const TROUBLESHOOTING = [
        "Aucun appareil visible : vérifiez le câble USB (données, pas charge seule) et le mode MTP.",
        "« Autoriser le débogage USB » ne s'affiche pas : déverrouillez l'écran, rebranchez le câble.",
        "Appareil déconnecté aléatoirement : branchez directement sur le PC, évitez les hubs USB.",
        "Mirroring ne démarre pas : fermez les autres outils ADB (Android Studio, scrcpy en CLI).",
        "Touches clavier ignorées : cliquez une fois sur le flux vidéo pour le focaliser."
    ];

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
        const stepsHtml = WIFI_GUIDE.steps.map((step) => `<li>${step}</li>`).join("");
        return `
            <div class="help-guide-content help-guide-content--static">
                <div class="help-guide-text">
                    <h3 class="help-guide-heading">${WIFI_GUIDE.title}</h3>
                    <ol class="help-guide-steps">${stepsHtml}</ol>
                    <div class="help-guide-tip"><strong>Remarque :</strong> ${WIFI_GUIDE.note}</div>
                </div>
            </div>
        `;
    }

    function renderShortcutsSection() {
        return SHORTCUT_GROUPS.map((group) => `
            <div class="help-shortcuts-group">
                <div class="help-shortcuts-group-title">${group.title}</div>
                ${group.items.map((item) => `
                    <div class="help-shortcut-row">
                        <div class="help-shortcut-keys">${renderShortcutKeys(item.keys)}</div>
                        <div class="help-shortcut-desc">${item.desc}</div>
                    </div>
                `).join("")}
            </div>
        `).join("");
    }

    function renderStepper() {
        const parts = [];
        for (let i = 0; i < GUIDE_STEPS.length; i++) {
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
        const step = GUIDE_STEPS[currentGuideStep];
        const total = GUIDE_STEPS.length;
        const stepsHtml = step.steps.map((s) => `<li>${s}</li>`).join("");
        const tipHtml = step.tip
            ? `<div class="help-guide-tip"><strong>Astuce :</strong> ${step.tip}</div>`
            : "";

        return `
            <div class="help-guide-stepper" id="help-guide-stepper">${renderStepper()}</div>
            <div class="help-guide-content">
                <div class="help-guide-visual">
                    <div class="help-guide-visual-label">${step.visualLabel}</div>
                    ${step.illustration()}
                    <div class="help-guide-visual-caption">${step.visualCaption}</div>
                </div>
                <div class="help-guide-text">
                    <div class="help-guide-step-label">Étape ${currentGuideStep + 1} sur ${total}</div>
                    <h3 class="help-guide-heading">${step.title}</h3>
                    <p class="help-guide-lead">${step.lead}</p>
                    <ol class="help-guide-steps">${stepsHtml}</ol>
                    ${tipHtml}
                </div>
            </div>
        `;
    }

    function renderTroubleshootPanel() {
        return `
            <div class="help-troubleshoot-panel" id="help-troubleshoot-panel">
                <h4>Dépannage rapide</h4>
                <ul>${TROUBLESHOOTING.map((t) => `<li>${t}</li>`).join("")}</ul>
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
                        <h2 class="help-modal-title" id="help-modal-title">Aide &amp; Raccourcis</h2>
                    </div>
                    <div class="hub-panel-header-actions">
                        <button type="button" class="hub-panel-refresh-btn" data-hub-panel-refresh="help" title="Rafraîchir">Rafraîchir</button>
                        <button type="button" class="help-modal-close" data-hub-modal-close id="help-modal-close" title="Fermer">&#10005;</button>
                    </div>
                </div>
                <div class="help-modal-tabs">
                    <button type="button" class="help-tab-btn active" data-help-tab="shortcuts">Raccourcis</button>
                    <button type="button" class="help-tab-btn" data-help-tab="guide">Guide mirroring</button>
                    <button type="button" class="help-tab-btn" data-help-tab="wifi">Connexion WiFi</button>
                </div>
                <div class="help-modal-body">
                    <section class="help-section active" id="help-section-shortcuts" data-section="shortcuts">
                        <p class="help-shortcuts-intro">
                            Raccourcis clavier et actions disponibles dans Android Hub. Les raccourcis de navigation
                            ne s'appliquent pas lorsque vous tapez dans un champ texte.
                            <strong>Clic droit</strong> sur un appareil dans « Appareils connectés » ou sur un onglet
                            de session pour ouvrir un menu contextuel (renommer, couleur, fermer…).
                        </p>
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
                    <button type="button" class="help-troubleshoot-link" id="help-troubleshoot-toggle">Voir le dépannage</button>
                    <div class="help-guide-nav">
                        <button type="button" class="help-btn help-btn-secondary" id="help-guide-prev">Précédent</button>
                        <button type="button" class="help-btn help-btn-primary" id="help-guide-next">Suivant</button>
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

        prevBtn.disabled = currentGuideStep === 0;
        nextBtn.textContent = currentGuideStep >= GUIDE_STEPS.length - 1 ? "Terminer" : "Suivant";
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
            if (currentGuideStep >= GUIDE_STEPS.length - 1) {
                closeHelpPanel();
                return;
            }
            currentGuideStep += 1;
            refreshGuideView();
        });

        overlayEl.querySelector("#help-troubleshoot-toggle")?.addEventListener("click", () => {
            overlayEl.querySelector("#help-troubleshoot-panel")?.classList.toggle("visible");
        });

        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            closeHelpPanel();
        });
    }

    overlayEl = buildModal();
    wireEvents();

    window.openHelpPanel = openHelpPanel;
    window.closeHelpPanel = closeHelpPanel;
    window.refreshHelpPanel = function refreshHelpPanel() {
        const root = overlayEl?.querySelector(".help-modal") || overlayEl;
        const activeTab = root?.querySelector(".help-tab-btn.active")?.dataset.helpTab || "shortcuts";
        currentGuideStep = 0;
        refreshGuideView();
        setActiveTab(activeTab);
        root?.querySelector("#help-troubleshoot-panel")?.classList.remove("visible");
    };
})();
