/**
 * Liste d'applications reutilisable (launcher / historique).
 * Affiche icone + nom lisible, filtrage live optionnel, tri alphabetique.
 */
(function initAppList(global) {
    const SEARCH_DEBOUNCE_MS = 100;
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    const DEFAULT_ICON_SVG = globalThis.HubAppIconPlaceholder?.APP_ICON_PLACEHOLDER_SVG
        || `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="#3d4f6f"/></svg>`;

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function defaultGetAppName(item) {
        if (global.AppDisplay?.getAppLabel) {
            return global.AppDisplay.getAppLabel(item);
        }
        return item.appName || item.labelName || item.displayName || item.packageName || item.package || "";
    }

    function defaultGetPackageName(item) {
        return item.packageName || item.package || "";
    }

    function defaultGetIconSrc(item) {
        return item.iconUrl || item.iconPath || null;
    }

    function defaultGetItemKey(item) {
        if (item.key) return String(item.key);
        if (item.appKey) return String(item.appKey);
        const pkg = defaultGetPackageName(item);
        const userId = item.userId === undefined || item.userId === null ? "0" : String(item.userId);
        return `${pkg}@@${userId}`;
    }

    class AppList {
        constructor(container, options = {}) {
            if (!container) {
                throw new Error("AppList: container requis");
            }

            this.container = container;
            this.options = {
                mode: options.mode || "select",
                emptyMessage: options.emptyMessage || t("apps.noResults"),
                loadingMessage: options.loadingMessage || t("apps.loading"),
                sortAlphabetically: options.sortAlphabetically !== false,
                showPackageAsSubtitle: Boolean(options.showPackageAsSubtitle),
                getItemKey: options.getItemKey || defaultGetItemKey,
                getAppName: options.getAppName || defaultGetAppName,
                getPackageName: options.getPackageName || defaultGetPackageName,
                getIconSrc: options.getIconSrc || defaultGetIconSrc,
                getVariantClass: options.getVariantClass || (() => ""),
                isSelected: options.isSelected || (() => false),
                onSelect: options.onSelect || null,
                renderMeta: options.renderMeta || null,
                renderActions: options.renderActions || null,
                itemClassName: options.itemClassName || "app-list-item",
                itemTag: options.itemTag || "button",
                searchInput: options.searchInput || null,
                noResultsMessage: options.noResultsMessage || null
            };

            this.items = [];
            this.filteredItems = [];
            this.searchQuery = "";
            this.isLoading = false;
            this._searchDebounceTimer = null;
            this._clickHandler = this._handleClick.bind(this);
            this._searchInputHandler = this._handleSearchInput.bind(this);
            this.container.addEventListener("click", this._clickHandler);

            if (this.options.searchInput) {
                this.options.searchInput.addEventListener("input", this._searchInputHandler);
            }
        }

        destroy() {
            if (this._searchDebounceTimer !== null) {
                clearTimeout(this._searchDebounceTimer);
                this._searchDebounceTimer = null;
            }
            this.container.removeEventListener("click", this._clickHandler);
            if (this.options.searchInput) {
                this.options.searchInput.removeEventListener("input", this._searchInputHandler);
            }
        }

        _handleSearchInput(event) {
            const query = event.target.value || "";
            if (this._searchDebounceTimer !== null) {
                clearTimeout(this._searchDebounceTimer);
            }
            this._searchDebounceTimer = setTimeout(() => {
                this._searchDebounceTimer = null;
                this.setSearchQuery(query);
            }, SEARCH_DEBOUNCE_MS);
        }

        resetSearch() {
            this.searchQuery = "";
            if (this.options.searchInput) {
                this.options.searchInput.value = "";
            }
            if (this.items.length) {
                this.applyFilter("");
            }
        }

        getSearchQuery() {
            if (this.options.searchInput) {
                return this.options.searchInput.value || "";
            }
            return this.searchQuery;
        }

        syncSearchFromInput() {
            this.setSearchQuery(this.getSearchQuery());
        }

        setLoading(isLoading, message) {
            this.isLoading = isLoading;
            if (isLoading) {
                this.container.innerHTML = `<p class="apps-loading">${escapeHtml(message || this.options.loadingMessage)}</p>`;
            }
        }

        setItems(items) {
            this.items = Array.isArray(items) ? items.slice() : [];
            this.applyFilter(this.searchQuery);
        }

        setSearchQuery(query) {
            this.searchQuery = query || "";
            this.applyFilter(this.searchQuery);
        }

        updateMetadata(updates = []) {
            if (!Array.isArray(updates) || !updates.length) return;

            const updateMap = new Map();
            for (const update of updates) {
                const key = this.options.getItemKey(update);
                updateMap.set(key, update);
            }

            let changed = false;
            this.items = this.items.map((item) => {
                const key = this.options.getItemKey(item);
                const patch = updateMap.get(key);
                if (!patch) return item;
                changed = true;
                return {
                    ...item,
                    appName: patch.appName || item.appName,
                    labelName: patch.appName || item.labelName,
                    displayName: patch.appName || item.displayName,
                    iconPath: patch.iconPath || item.iconPath,
                    iconUrl: patch.iconUrl || item.iconUrl
                };
            });

            if (!changed) return;

            let patched = false;
            this.container.querySelectorAll(`[data-item-key]`).forEach((node) => {
                const patch = updateMap.get(node.dataset.itemKey);
                if (!patch) return;

                const iconSrc = patch.iconUrl || patch.iconPath;
                if (!iconSrc) return;

                const iconWrap = node.querySelector(".app-list-item-icon");
                if (!iconWrap) return;

                const img = iconWrap.querySelector("img");
                if (img) {
                    if (img.getAttribute("src") !== iconSrc) {
                        img.setAttribute("src", iconSrc);
                        patched = true;
                    }
                    return;
                }

                iconWrap.innerHTML = `<img src="${escapeHtml(iconSrc)}" alt="" loading="lazy">`;
                patched = true;
            });

            if (!patched) {
                this.applyFilter(this.searchQuery);
            }
        }

        applyFilter(query) {
            const normalized = String(query || "").toLowerCase().trim();
            let list = this.items.slice();

            if (normalized) {
                list = list.filter((item) => {
                    const appName = this.options.getAppName(item).toLowerCase();
                    const packageName = this.options.getPackageName(item).toLowerCase();
                    return appName.includes(normalized) || packageName.includes(normalized);
                });
            }

            if (this.options.sortAlphabetically) {
                list.sort((a, b) => this.options.getAppName(a).localeCompare(
                    this.options.getAppName(b),
                    "fr",
                    { sensitivity: "base" }
                ));
            }

            this.filteredItems = list;
            this.render();
        }

        renderIcon(item) {
            const iconSrc = this.options.getIconSrc(item);
            if (iconSrc) {
                return `<img src="${escapeHtml(iconSrc)}" alt="" loading="lazy">`;
            }
            return globalThis.HubAppIconPlaceholder?.APP_ICON_PLACEHOLDER_SVG || DEFAULT_ICON_SVG;
        }

        renderItem(item) {
            const key = this.options.getItemKey(item);
            const appName = escapeHtml(this.options.getAppName(item));
            const packageName = escapeHtml(this.options.getPackageName(item));
            const variantClass = this.options.getVariantClass(item);
            const selectedClass = this.options.isSelected(item) ? " selected" : "";
            const metaHtml = typeof this.options.renderMeta === "function"
                ? this.options.renderMeta(item)
                : "";
            const actionsHtml = typeof this.options.renderActions === "function"
                ? this.options.renderActions(item)
                : "";
            const subtitleHtml = this.options.showPackageAsSubtitle && packageName
                ? `<span class="app-list-item-package">${packageName}</span>`
                : "";

            const dataAttrs = [
                `data-item-key="${escapeHtml(key)}"`,
                packageName ? `data-package="${packageName}"` : "",
                appName ? `data-app-name="${appName}"` : "",
                item.userId !== undefined && item.userId !== null ? `data-user-id="${escapeHtml(item.userId)}"` : "",
                item.iconPath ? `data-icon-path="${escapeHtml(item.iconPath)}"` : "",
                item.iconUrl ? `data-icon-url="${escapeHtml(item.iconUrl)}"` : "",
                item.key ? `data-history-key="${escapeHtml(item.key)}"` : "",
                item.deviceId ? `data-device-id="${escapeHtml(item.deviceId)}"` : ""
            ].filter(Boolean).join(" ");

            const tag = this.options.itemTag;
            const typeAttr = tag === "button" ? ' type="button"' : "";

            return `
                <${tag}${typeAttr} class="${this.options.itemClassName}${selectedClass}${variantClass ? ` ${variantClass}` : ""}" ${dataAttrs}>
                    <span class="app-list-item-icon">${this.renderIcon(item)}</span>
                    <span class="app-list-item-main">
                        <span class="app-list-item-name">${appName}</span>
                        ${subtitleHtml}
                        ${metaHtml}
                    </span>
                    ${actionsHtml}
                </${tag}>
            `;
        }

        render() {
            if (this.isLoading) return;

            if (!this.filteredItems.length) {
                const message = this.searchQuery.trim() && this.options.noResultsMessage
                    ? this.options.noResultsMessage
                    : this.options.emptyMessage;
                this.container.innerHTML = `<p class="apps-loading">${escapeHtml(message)}</p>`;
                return;
            }

            this.container.innerHTML = this.filteredItems
                .map((item) => this.renderItem(item))
                .join("");
        }

        _handleClick(event) {
            const itemEl = event.target.closest(`.${this.options.itemClassName}`);
            if (!itemEl || !this.container.contains(itemEl)) return;

            if (event.target.closest("[data-app-list-action]")) {
                return;
            }

            const itemKey = itemEl.dataset.itemKey;
            const item = this.filteredItems.find((entry) => this.options.getItemKey(entry) === itemKey);
            if (!item || typeof this.options.onSelect !== "function") return;

            this.options.onSelect(item, event);
        }
    }

    global.AppList = AppList;
})(window);
