(function initHubAccent() {
    const STORAGE_KEY = "androidHub.uiAccent";
    const DEFAULT_ID = "5"; // Bleu pastille appareil
    const LEGACY_MAP = Object.freeze({
        blue: "5",
        green: "3",
        cyan: "4",
        amber: "1",
        coral: "0"
    });

    function getPalette() {
        return globalThis.DeviceColors?.DEVICE_COLORS || [];
    }

    function softFromHex(hex) {
        const raw = String(hex || "").replace("#", "");
        if (raw.length !== 6) return "#2a3b56";
        const r = parseInt(raw.slice(0, 2), 16);
        const g = parseInt(raw.slice(2, 4), 16);
        const b = parseInt(raw.slice(4, 6), 16);
        const mix = (channel) => Math.round(channel * 0.28 + 14);
        const toHex = (n) => n.toString(16).padStart(2, "0");
        return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
    }

    function buildPresets() {
        const presets = {};
        for (const color of getPalette()) {
            presets[String(color.id)] = {
                accent: color.hex,
                soft: softFromHex(color.hex),
                key: color.key,
                name: color.name
            };
        }
        return presets;
    }

    function normalizeAccent(id) {
        const presets = buildPresets();
        const raw = String(id ?? "");
        if (presets[raw]) return raw;
        if (LEGACY_MAP[raw] && presets[LEGACY_MAP[raw]]) return LEGACY_MAP[raw];
        return presets[DEFAULT_ID] ? DEFAULT_ID : Object.keys(presets)[0] || "5";
    }

    function getUiAccent() {
        try {
            return normalizeAccent(localStorage.getItem(STORAGE_KEY));
        } catch (_err) {
            return DEFAULT_ID;
        }
    }

    function colorLabel(preset) {
        if (!preset?.key) return preset?.name || "";
        return globalThis.HubI18n?.t?.(`colors.${preset.key}`) || preset.name || preset.key;
    }

    function renderSwatches(root = document) {
        const host = root.querySelector?.("#settings-accent-swatches") || document.getElementById("settings-accent-swatches");
        if (!host) return;
        const presets = buildPresets();
        const current = getUiAccent();
        host.innerHTML = Object.entries(presets).map(([id, preset]) => {
            const label = colorLabel(preset);
            const active = id === current ? " active" : "";
            return `<button type="button" class="settings-accent-swatch${active}" data-hub-accent="${id}" style="background:${preset.accent}" title="${label}" aria-label="${label}"></button>`;
        }).join("");
    }

    function applyUiAccent(id) {
        const presets = buildPresets();
        const next = normalizeAccent(id);
        const preset = presets[next] || presets[DEFAULT_ID];
        if (!preset) return next;

        const root = document.documentElement;
        root.style.setProperty("--accent-blue", preset.accent);
        root.style.setProperty("--accent-blue-soft", preset.soft);
        root.dataset.hubAccent = next;
        document.querySelectorAll("[data-hub-accent]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.hubAccent === next);
        });
        return next;
    }

    function setUiAccent(id) {
        const next = normalizeAccent(id);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch (_err) {
            /* ignore */
        }
        return applyUiAccent(next);
    }

    function refreshAccentLabels() {
        renderSwatches();
        applyUiAccent(getUiAccent());
    }

    // Appliquer dès le chargement (main + modal).
    applyUiAccent(getUiAccent());
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => renderSwatches(), { once: true });
    } else {
        renderSwatches();
    }

    globalThis.HubI18n?.onChange?.(refreshAccentLabels);

    window.HubAccent = {
        STORAGE_KEY,
        DEFAULT_ID,
        normalizeAccent,
        getUiAccent,
        applyUiAccent,
        setUiAccent,
        renderSwatches,
        buildPresets
    };
    window.applyUiAccent = applyUiAccent;
    window.getUiAccent = getUiAccent;
    window.setUiAccent = setUiAccent;
})();
