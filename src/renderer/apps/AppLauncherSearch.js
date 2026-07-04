/**
 * Recherche + liste des apps installees sur le device selectionne (launcher Type B).
 * Composant independant de l'historique (AppList / historyEntries).
 */
(function initAppLauncherSearch(global) {
    const DEFAULT_ICON_SVG = `<svg viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/><circle cx="12" cy="12" r="2.5"/></svg>`;

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function getAppLabel(app = {}) {
        if (global.AppDisplay?.getAppLabel) {
            return global.AppDisplay.getAppLabel(app);
        }
        return app.appName || app.labelName || app.displayName || app.package || "";
    }

    function getAppVariantClass(app = {}) {
        if (app.variantType === "clone") return "app-variant-clone";
        if (app.variantType === "duplicate") return "app-variant-duplicate";
        return "";
    }

    function buildAppKey(app = {}) {
        if (app.appKey) return String(app.appKey);
        const pkg = String(app.package || "");
        const userId = app.userId === undefined || app.userId === null ? "0" : String(app.userId);
        return `${pkg}@@${userId}`;
    }

    class AppLauncherSearch {
        constructor(options = {}) {
            this.searchInput = options.searchInput || null;
            this.resultsContainer = options.resultsContainer || null;
            this.launcherHint = options.launcherHint || null;
            this.onLaunch = typeof options.onLaunch === "function" ? options.onLaunch : null;
            this.onStatus = typeof options.onStatus === "function" ? options.onStatus : null;

            this.allApps = [];
            this.searchQuery = "";
            this.deviceSerial = null;
            this._launching = false;

            this._onSearchInput = this._onSearchInput.bind(this);
            this._onResultClick = this._onResultClick.bind(this);

            if (this.searchInput) {
                this.searchInput.addEventListener("input", this._onSearchInput);
            }
            if (this.resultsContainer) {
                this.resultsContainer.addEventListener("click", this._onResultClick);
            }
        }

        destroy() {
            if (this.searchInput) {
                this.searchInput.removeEventListener("input", this._onSearchInput);
            }
            if (this.resultsContainer) {
                this.resultsContainer.removeEventListener("click", this._onResultClick);
            }
        }

        _onSearchInput(event) {
            this.filterAndRender(event.target.value || "");
        }

        _onResultClick(event) {
            const btn = event.target.closest(".new-instance-app-item");
            if (!btn || !this.resultsContainer?.contains(btn)) return;

            const app = this.allApps.find((entry) => buildAppKey(entry) === btn.dataset.appKey);
            if (!app || this._launching) return;

            this._launching = true;
            Promise.resolve(this.onLaunch?.(app))
                .catch((err) => {
                    this.onStatus?.(`Erreur lancement: ${err.message}`, true);
                })
                .finally(() => {
                    this._launching = false;
                });
        }

        _setIdleState() {
            this.deviceSerial = null;
            if (this.searchInput) {
                this.searchInput.value = "";
                this.searchInput.disabled = true;
                this.searchInput.placeholder = "Rechercher une application à lancer...";
            }
            if (this.launcherHint) {
                this.launcherHint.textContent = "Sélectionnez un appareil pour afficher ses applications.";
                this.launcherHint.classList.remove("hidden");
            }
            if (this.resultsContainer) {
                this.resultsContainer.innerHTML = '<p class="apps-loading">Aucun appareil sélectionné</p>';
            }
        }

        reset() {
            this.allApps = [];
            this.searchQuery = "";
            this._setIdleState();
        }

        prepareForDevice(deviceLabel) {
            if (this.searchInput) {
                this.searchInput.disabled = false;
                this.searchInput.value = "";
                this.searchInput.placeholder = `Rechercher une application sur ${deviceLabel}...`;
                this.searchInput.focus();
            }
            if (this.launcherHint) {
                this.launcherHint.textContent = `Applications installées sur ${deviceLabel}`;
                this.launcherHint.classList.remove("hidden");
            }
            this.setLoading();
        }

        setLoading(message = "Chargement des applications...") {
            if (this.resultsContainer) {
                this.resultsContainer.innerHTML = `<p class="apps-loading">${escapeHtml(message)}</p>`;
            }
        }

        normalizeApps(apps = []) {
            return apps.map((app) => ({
                ...app,
                appKey: buildAppKey(app),
                appName: app.appName || app.labelName || app.displayName || app.package,
                labelName: app.labelName || app.appName || app.displayName || app.package
            }));
        }

        async loadForDevice(serial) {
            if (!serial || !this.resultsContainer) return [];

            this.deviceSerial = serial;

            try {
                const response = await global.electronAPI?.getAppsWithDetails?.(serial);
                if (response?.success === false) {
                    throw new Error(response.error || "Impossible de charger les applications");
                }

                const apps = Array.isArray(response)
                    ? response
                    : Array.isArray(response?.apps)
                        ? response.apps
                        : [];

                this.allApps = this.normalizeApps(apps);
                this.filterAndRender(this.searchInput?.value || "");

                return this.allApps;
            } catch (err) {
                this.allApps = [];
                if (this.resultsContainer) {
                    this.resultsContainer.innerHTML = '<p class="apps-loading">Erreur lors du chargement des applications</p>';
                }
                throw err;
            }
        }

        updateMetadata(updates = []) {
            if (!Array.isArray(updates) || !updates.length) return;

            const updateMap = new Map();
            for (const update of updates) {
                updateMap.set(buildAppKey(update), update);
            }

            let changed = false;
            this.allApps = this.allApps.map((app) => {
                const patch = updateMap.get(buildAppKey(app));
                if (!patch) return app;
                changed = true;
                return {
                    ...app,
                    appName: patch.appName || app.appName,
                    labelName: patch.appName || app.labelName,
                    displayName: patch.appName || app.displayName,
                    iconPath: patch.iconPath || app.iconPath,
                    iconUrl: patch.iconUrl || app.iconUrl
                };
            });

            if (changed) {
                this.filterAndRender(this.searchInput?.value || "");
            }
        }

        scheduleMetadataPrefetch(apps = []) {
            if (!this.deviceSerial || !global.electronAPI?.prefetchAppMetadata) return;

            clearTimeout(this._prefetchTimer);
            this._prefetchTimer = setTimeout(() => {
                const payloadApps = apps.slice(0, 16).map((app) => ({
                    package: app.package,
                    packageName: app.package,
                    userId: app.userId ?? null,
                    appName: app.appName || app.labelName || app.displayName || app.package
                }));

                if (!payloadApps.length) return;

                global.electronAPI.prefetchAppMetadata({
                    deviceId: this.deviceSerial,
                    apps: payloadApps,
                    maxCount: 16
                }).catch((err) => {
                    console.warn("[AppLauncherSearch] prefetch metadata:", err.message);
                });
            }, 450);
        }

        filterAndRender(query) {
            this.searchQuery = String(query || "");
            const normalized = this.searchQuery.toLowerCase().trim();

            let list = this.allApps.slice();
            if (normalized) {
                list = list.filter((app) => {
                    const appName = getAppLabel(app).toLowerCase();
                    const packageName = String(app.package || "").toLowerCase();
                    return appName.includes(normalized) || packageName.includes(normalized);
                });
            }

            list.sort((a, b) => getAppLabel(a).localeCompare(getAppLabel(b), "fr", { sensitivity: "base" }));
            this.render(list);
            this.scheduleMetadataPrefetch(list);
        }

        renderAppIcon(app) {
            const iconSrc = app.iconUrl || app.iconPath;
            if (iconSrc) {
                return `<span class="new-instance-app-icon"><img src="${escapeHtml(iconSrc)}" alt="" loading="lazy"></span>`;
            }
            return `<span class="new-instance-app-icon">${DEFAULT_ICON_SVG}</span>`;
        }

        render(apps) {
            if (!this.resultsContainer) return;

            if (!apps.length) {
                const message = this.searchQuery.trim()
                    ? "Aucune application ne correspond a la recherche"
                    : "Aucune application trouvee";
                this.resultsContainer.innerHTML = `<p class="apps-loading">${escapeHtml(message)}</p>`;
                return;
            }

            this.resultsContainer.innerHTML = apps.map((app) => {
                const label = getAppLabel(app);
                const variantClass = getAppVariantClass(app);
                const iconPath = app.iconPath ? escapeHtml(app.iconPath) : "";
                const iconUrl = app.iconUrl ? escapeHtml(app.iconUrl) : "";
                const profileSuffix = app.userId !== undefined && app.userId !== null
                    ? ` (profil ${app.userId})`
                    : "";

                return `
                <button type="button" class="new-instance-app-item ${variantClass}" data-package="${escapeHtml(app.package)}" data-display="${escapeHtml(app.displayName || label)}" data-label="${escapeHtml(label)}" data-variant="${app.variantType || "original"}" data-app-key="${buildAppKey(app)}" data-user-id="${app.userId ?? ""}" data-icon-path="${iconPath}" data-icon-url="${iconUrl}">
                    ${this.renderAppIcon(app)}
                    <span class="new-instance-app-main">
                        <span class="new-instance-app-name">${escapeHtml(label)}</span>
                        <span class="new-instance-app-package">${escapeHtml(app.package)}${profileSuffix}</span>
                    </span>
                </button>
            `;
            }).join("");
        }
    }

    global.AppLauncherSearch = AppLauncherSearch;
})(window);
