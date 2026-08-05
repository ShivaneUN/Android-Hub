const fs = require("fs");
const path = require("path");
const {
    DEFAULT_STREAM_PARAMS,
    DEFAULT_WIFI_STREAM_PARAMS,
    CONTROL_OPTIONS,
    PERFORMANCE_STREAM_RESOLUTION,
    normalizeParams,
    cloneParams
} = require("../../shared/stream-params");

const TRANSPORT_USB = "usb";
const TRANSPORT_WIFI = "wifi";
const PERFORMANCE_PRESET_ID = "performance-qhd";
const PERFORMANCE_PRESET_NAME = "Performance qHD";

const SEED_PRESETS = Object.freeze([
    {
        id: "full-hd",
        name: "Full HD",
        width: 1920,
        height: 1080,
        maxFps: 60,
        bitRateMbps: 8
    },
    {
        id: "wifi-hd",
        name: "Wi‑Fi HD",
        width: DEFAULT_WIFI_STREAM_PARAMS.width,
        height: DEFAULT_WIFI_STREAM_PARAMS.height,
        maxFps: DEFAULT_WIFI_STREAM_PARAMS.maxFps,
        bitRateMbps: DEFAULT_WIFI_STREAM_PARAMS.bitRateMbps
    }
]);

const DEFAULT_SEED = Object.freeze({
    defaultPresetUsb: "full-hd",
    defaultPresetWifi: "wifi-hd",
    prePerformanceDefaults: null,
    performanceResolutionActive: false,
    presets: SEED_PRESETS
});

function slugifyId(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "preset";
}

function isValidPresetShape(preset) {
    return Boolean(
        preset
        && typeof preset.id === "string"
        && preset.id.length > 0
        && typeof preset.name === "string"
        && preset.name.trim().length > 0
        && Number.isFinite(preset.width)
        && Number.isFinite(preset.height)
        && Number.isFinite(preset.maxFps)
        && Number.isFinite(preset.bitRateMbps)
    );
}

function sanitizePresetInput(input = {}) {
    const normalized = normalizeParams({
        width: input.width,
        height: input.height,
        maxFps: input.maxFps,
        bitRateMbps: input.bitRateMbps,
        dpi: DEFAULT_STREAM_PARAMS.dpi,
        iFrameInterval: DEFAULT_STREAM_PARAMS.iFrameInterval,
        videoCodec: input.videoCodec
    });

    return {
        width: normalized.width,
        height: normalized.height,
        maxFps: normalized.maxFps,
        bitRateMbps: normalized.bitRateMbps,
        videoCodec: normalized.videoCodec
    };
}

function normalizeTransport(value) {
    return value === TRANSPORT_WIFI ? TRANSPORT_WIFI : TRANSPORT_USB;
}

function isPerformanceResolution(preset) {
    return Boolean(
        preset
        && preset.width === PERFORMANCE_STREAM_RESOLUTION.width
        && preset.height === PERFORMANCE_STREAM_RESOLUTION.height
    );
}

class DisplayPresetsManager {
    constructor(userDataPath) {
        this.filePath = path.join(userDataPath, "display-presets.json");
        this.data = structuredClone(DEFAULT_SEED);
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                this.save();
                return;
            }

            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            const presets = Array.isArray(parsed?.presets)
                ? parsed.presets.filter(isValidPresetShape).map((preset) => ({ ...preset }))
                : [];

            if (presets.length === 0) {
                this.data = structuredClone(DEFAULT_SEED);
                this.save();
                return;
            }

            this.data = {
                presets,
                defaultPresetUsb: null,
                defaultPresetWifi: null,
                prePerformanceDefaults: parsed?.prePerformanceDefaults && typeof parsed.prePerformanceDefaults === "object"
                    ? parsed.prePerformanceDefaults
                    : null,
                performanceResolutionActive: parsed?.performanceResolutionActive === true
            };
            this._ensureWifiSeedPreset();
            this._migrateDefaults(parsed);
            this._ensureDefaultPresets();
            this.save();
        } catch (err) {
            console.error("[DisplayPresetsManager] Erreur lecture:", err.message);
            this.data = structuredClone(DEFAULT_SEED);
            this.save();
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
        } catch (err) {
            console.error("[DisplayPresetsManager] Erreur écriture:", err.message);
        }
    }

    _findPreset(presetId) {
        return this.data.presets.find((preset) => preset.id === presetId) || null;
    }

    _defaultKey(transport) {
        return normalizeTransport(transport) === TRANSPORT_WIFI
            ? "defaultPresetWifi"
            : "defaultPresetUsb";
    }

    _ensureWifiSeedPreset() {
        if (this._findPreset("wifi-hd")) return;
        const seedWifi = SEED_PRESETS.find((preset) => preset.id === "wifi-hd");
        if (seedWifi) {
            this.data.presets.push({ ...seedWifi });
        }
    }

    _migrateDefaults(parsed = {}) {
        const usbId = typeof parsed.defaultPresetUsb === "string"
            ? parsed.defaultPresetUsb
            : (typeof parsed.defaultPreset === "string" ? parsed.defaultPreset : null);
        const wifiId = typeof parsed.defaultPresetWifi === "string"
            ? parsed.defaultPresetWifi
            : null;

        this.data.defaultPresetUsb = usbId && this._findPreset(usbId)
            ? usbId
            : (this._findPreset("full-hd")?.id || this.data.presets[0].id);

        this.data.defaultPresetWifi = wifiId && this._findPreset(wifiId)
            ? wifiId
            : (this._findPreset("wifi-hd")?.id || this.data.presets[0].id);
    }

    _ensureDefaultPresets() {
        if (!this.data.presets.length) {
            this.data = structuredClone(DEFAULT_SEED);
            return;
        }
        if (!this._findPreset(this.data.defaultPresetUsb)) {
            this.data.defaultPresetUsb = this.data.presets[0].id;
        }
        if (!this._findPreset(this.data.defaultPresetWifi)) {
            this.data.defaultPresetWifi = this._findPreset("wifi-hd")?.id || this.data.presets[0].id;
        }
    }

    _ensureDefaultPreset() {
        this._ensureWifiSeedPreset();
        this._ensureDefaultPresets();
    }

    _makeUniqueId(baseId, excludeId = null) {
        let candidate = baseId;
        let suffix = 2;
        while (this.data.presets.some((preset) => preset.id === candidate && preset.id !== excludeId)) {
            candidate = `${baseId}-${suffix}`;
            suffix += 1;
        }
        return candidate;
    }

    list() {
        this._ensureDefaultPreset();
        return {
            success: true,
            defaultPreset: this.data.defaultPresetUsb,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            performanceResolutionActive: this.data.performanceResolutionActive === true,
            presets: this.data.presets.map((preset) => ({ ...preset }))
        };
    }

    _withPerformanceOverlay(params) {
        if (this.data.performanceResolutionActive !== true) return params;
        return normalizeParams({
            ...params,
            width: PERFORMANCE_STREAM_RESOLUTION.width,
            height: PERFORMANCE_STREAM_RESOLUTION.height
        });
    }

    _clearPerformanceOverride() {
        this.data.performanceResolutionActive = false;
    }

    getDefault(transport = TRANSPORT_USB) {
        this._ensureDefaultPreset();
        const key = this._defaultKey(transport);
        const presetId = this.data[key];
        const preset = this._findPreset(presetId) || this.data.presets[0] || null;
        if (!preset) {
            return { success: false, error: "Aucun preset disponible" };
        }

        const rawParams = this.resolveParams(preset.id);
        return {
            success: true,
            transport: normalizeTransport(transport),
            defaultPreset: preset.id,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            performanceResolutionActive: this.data.performanceResolutionActive === true,
            preset: { ...preset },
            params: this._withPerformanceOverlay(rawParams)
        };
    }

    resolveParams(presetId = null) {
        this._ensureDefaultPreset();
        const id = presetId || this.data.defaultPresetUsb;
        const preset = this._findPreset(id);
        if (!preset) {
            return cloneParams(DEFAULT_STREAM_PARAMS);
        }

        return normalizeParams({
            ...DEFAULT_STREAM_PARAMS,
            width: preset.width,
            height: preset.height,
            maxFps: preset.maxFps,
            bitRateMbps: preset.bitRateMbps,
            videoCodec: preset.videoCodec
        });
    }

    savePreset({ name, params, id = null } = {}) {
        this._ensureDefaultPreset();
        if (!Array.isArray(this.data.presets)) {
            this.data.presets = [];
        }

        const trimmedName = String(name || "").trim();
        if (!trimmedName) {
            return { success: false, error: "Nom du preset requis" };
        }

        const sanitized = sanitizePresetInput(params || {});
        const baseId = id ? slugifyId(id) : slugifyId(trimmedName);
        const presetId = this._makeUniqueId(baseId);
        const preset = {
            id: presetId,
            name: trimmedName,
            ...sanitized
        };

        this.data.presets.push(preset);
        this.save();

        return {
            success: true,
            preset: { ...preset },
            defaultPreset: this.data.defaultPresetUsb,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            presets: this.data.presets.map((item) => ({ ...item }))
        };
    }

    setDefaultPreset(presetId, transport = TRANSPORT_USB) {
        if (!this._findPreset(presetId)) {
            return { success: false, error: "Preset introuvable" };
        }

        const key = this._defaultKey(transport);
        this.data[key] = presetId;
        // Choix explicite utilisateur : ne plus forcer qHD au lancement.
        this._clearPerformanceOverride();
        this.save();

        return {
            success: true,
            transport: normalizeTransport(transport),
            defaultPreset: this.data.defaultPresetUsb,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            performanceResolutionActive: false,
            params: this.resolveParams(presetId)
        };
    }

    updateDefaultFromParams(params = {}, transport = TRANSPORT_USB) {
        this._ensureDefaultPreset();

        const key = this._defaultKey(transport);
        const preset = this._findPreset(this.data[key]);
        if (!preset) {
            return { success: false, error: "Preset par défaut introuvable" };
        }

        const sanitized = sanitizePresetInput(params);
        Object.assign(preset, sanitized);
        this._clearPerformanceOverride();
        this.save();

        return {
            success: true,
            transport: normalizeTransport(transport),
            defaultPreset: this.data.defaultPresetUsb,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            performanceResolutionActive: false,
            preset: { ...preset },
            params: this.resolveParams(preset.id),
            message: "Paramètres enregistrés pour les prochains lancements."
        };
    }

    /**
     * Mode performance : crée/réutilise le preset « Performance qHD »
     * et le met par défaut USB + Wi‑Fi (sans écraser les autres presets).
     */
    applyPerformanceResolution() {
        this._ensureDefaultPreset();
        this._healSeedPresetsFromPerformance();

        if (!this.data.prePerformanceDefaults) {
            this.data.prePerformanceDefaults = {
                usbPresetId: this.data.defaultPresetUsb,
                wifiPresetId: this.data.defaultPresetWifi
            };
        }

        const usbCurrent = this.resolveParams(this.data.defaultPresetUsb);
        const perfParams = sanitizePresetInput({
            ...usbCurrent,
            width: PERFORMANCE_STREAM_RESOLUTION.width,
            height: PERFORMANCE_STREAM_RESOLUTION.height
        });

        let preset = this._findPreset(PERFORMANCE_PRESET_ID);
        if (!preset) {
            preset = {
                id: PERFORMANCE_PRESET_ID,
                name: PERFORMANCE_PRESET_NAME,
                ...perfParams
            };
            this.data.presets.push(preset);
        } else {
            Object.assign(preset, {
                name: PERFORMANCE_PRESET_NAME,
                ...perfParams
            });
        }

        this.data.defaultPresetUsb = PERFORMANCE_PRESET_ID;
        this.data.defaultPresetWifi = PERFORMANCE_PRESET_ID;
        // Preset réel : plus besoin d'overlay au lancement.
        this.data.performanceResolutionActive = false;
        this.save();

        return {
            success: true,
            defaultPreset: PERFORMANCE_PRESET_ID,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            performanceResolutionActive: false,
            performancePresetId: PERFORMANCE_PRESET_ID,
            preset: { ...preset },
            params: this.resolveParams(PERFORMANCE_PRESET_ID),
            message: "Preset Performance qHD créé et défini par défaut."
        };
    }

    /**
     * Restaure les défauts USB/Wi‑Fi d'avant le mode performance.
     * @param {{ healSeeds?: boolean }} [opts]
     */
    restorePerformanceResolution(opts = {}) {
        this._ensureDefaultPreset();
        let restored = false;
        const snapshot = this.data.prePerformanceDefaults;

        if (snapshot && typeof snapshot === "object") {
            if (snapshot.usbPresetId && this._findPreset(snapshot.usbPresetId)) {
                this.data.defaultPresetUsb = snapshot.usbPresetId;
                restored = true;
            }
            if (snapshot.wifiPresetId && this._findPreset(snapshot.wifiPresetId)) {
                this.data.defaultPresetWifi = snapshot.wifiPresetId;
                restored = true;
            }
        }

        if (this.data.performanceResolutionActive) {
            this.data.performanceResolutionActive = false;
            restored = true;
        }
        this.data.prePerformanceDefaults = null;

        if (opts.healSeeds !== false) {
            restored = this._healSeedPresetsFromPerformance() || restored;
        }

        this._ensureDefaultPresets();
        this.save();

        const defaultPreset = this._findPreset(this.data.defaultPresetUsb);
        return {
            success: true,
            restored: true,
            defaultPreset: this.data.defaultPresetUsb,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            performanceResolutionActive: false,
            preset: defaultPreset ? { ...defaultPreset } : null,
            params: this.resolveParams(),
            message: "Défauts USB / Wi‑Fi restaurés hors mode performance."
        };
    }

    /** Remet Full HD / Wi‑Fi HD d'usine s'ils sont restés bloqués en qHD. */
    _healSeedPresetsFromPerformance() {
        let changed = false;
        for (const seed of SEED_PRESETS) {
            const preset = this._findPreset(seed.id);
            if (!preset || !isPerformanceResolution(preset)) continue;
            Object.assign(preset, {
                name: seed.name,
                ...sanitizePresetInput(seed)
            });
            changed = true;
        }
        return changed;
    }

    /** Remet le preset d'usine USB ou Wi‑Fi et le définit par défaut. */
    resetTransportToFactory(transport = TRANSPORT_USB) {
        this._ensureDefaultPreset();
        const normalized = normalizeTransport(transport);
        const seed = SEED_PRESETS.find((item) => (
            normalized === TRANSPORT_WIFI ? item.id === "wifi-hd" : item.id === "full-hd"
        ));
        if (!seed) {
            return { success: false, error: "Preset d'usine introuvable" };
        }

        let preset = this._findPreset(seed.id);
        if (!preset) {
            preset = { ...seed };
            this.data.presets.push(preset);
        } else {
            Object.assign(preset, {
                name: seed.name,
                ...sanitizePresetInput(seed)
            });
        }

        this.data[this._defaultKey(normalized)] = seed.id;
        this._clearPerformanceOverride();
        this.save();

        return {
            success: true,
            transport: normalized,
            defaultPreset: this.data.defaultPresetUsb,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            performanceResolutionActive: false,
            preset: { ...preset },
            params: this.resolveParams(seed.id),
            message: normalized === TRANSPORT_WIFI
                ? "Preset Wi‑Fi réinitialisé (HD 720p)."
                : "Preset USB réinitialisé (Full HD)."
        };
    }

    deletePreset(presetId) {
        if (!this._findPreset(presetId)) {
            return { success: false, error: "Preset introuvable" };
        }

        if (this.data.presets.length <= 1) {
            return { success: false, error: "Impossible de supprimer le dernier preset" };
        }

        this.data.presets = this.data.presets.filter((preset) => preset.id !== presetId);

        if (this.data.defaultPresetUsb === presetId) {
            this.data.defaultPresetUsb = this.data.presets[0].id;
        }
        if (this.data.defaultPresetWifi === presetId) {
            this.data.defaultPresetWifi = this._findPreset("wifi-hd")?.id || this.data.presets[0].id;
        }

        this.save();

        return {
            success: true,
            defaultPreset: this.data.defaultPresetUsb,
            defaultPresetUsb: this.data.defaultPresetUsb,
            defaultPresetWifi: this.data.defaultPresetWifi,
            presets: this.data.presets.map((preset) => ({ ...preset }))
        };
    }

    getAllowedOptions() {
        return {
            resolutions: CONTROL_OPTIONS.resolutions.map((resolution) => ({
                width: resolution.width,
                height: resolution.height,
                label: resolution.label
            })),
            fps: [...CONTROL_OPTIONS.fps],
            bitRateMbps: [...CONTROL_OPTIONS.bitRateMbps]
        };
    }
}

module.exports = {
    DisplayPresetsManager,
    SEED_PRESETS,
    DEFAULT_SEED,
    TRANSPORT_USB,
    TRANSPORT_WIFI
};
