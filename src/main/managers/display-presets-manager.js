const fs = require("fs");
const path = require("path");
const {
    DEFAULT_STREAM_PARAMS,
    CONTROL_OPTIONS,
    normalizeParams,
    cloneParams
} = require("../../shared/stream-params");

const SEED_PRESETS = Object.freeze([
    {
        id: "full-hd",
        name: "Full HD",
        width: 1920,
        height: 1080,
        maxFps: 60,
        bitRateMbps: 8
    }
]);

const DEFAULT_SEED = Object.freeze({
    defaultPreset: "full-hd",
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
        iFrameInterval: DEFAULT_STREAM_PARAMS.iFrameInterval
    });

    return {
        width: normalized.width,
        height: normalized.height,
        maxFps: normalized.maxFps,
        bitRateMbps: normalized.bitRateMbps
    };
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
                ? parsed.presets.filter(isValidPresetShape)
                : [];

            if (presets.length === 0) {
                this.data = structuredClone(DEFAULT_SEED);
                this.save();
                return;
            }

            const defaultPreset = typeof parsed?.defaultPreset === "string"
                && presets.some((preset) => preset.id === parsed.defaultPreset)
                ? parsed.defaultPreset
                : presets[0].id;

            this.data = { defaultPreset, presets };
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
        return {
            success: true,
            defaultPreset: this.data.defaultPreset,
            presets: this.data.presets.map((preset) => ({ ...preset }))
        };
    }

    getDefault() {
        const preset = this._findPreset(this.data.defaultPreset) || this.data.presets[0] || null;
        if (!preset) {
            return { success: false, error: "Aucun preset disponible" };
        }

        return {
            success: true,
            defaultPreset: preset.id,
            preset: { ...preset },
            params: this.resolveParams(preset.id)
        };
    }

    resolveParams(presetId = null) {
        const id = presetId || this.data.defaultPreset;
        const preset = this._findPreset(id);
        if (!preset) {
            return cloneParams(DEFAULT_STREAM_PARAMS);
        }

        return normalizeParams({
            ...DEFAULT_STREAM_PARAMS,
            width: preset.width,
            height: preset.height,
            maxFps: preset.maxFps,
            bitRateMbps: preset.bitRateMbps
        });
    }

    savePreset({ name, params, id = null } = {}) {
        const trimmedName = String(name || "").trim();
        if (!trimmedName) {
            return { success: false, error: "Nom du preset requis" };
        }

        const sanitized = sanitizePresetInput(params);
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
            defaultPreset: this.data.defaultPreset
        };
    }

    setDefaultPreset(presetId) {
        if (!this._findPreset(presetId)) {
            return { success: false, error: "Preset introuvable" };
        }

        this.data.defaultPreset = presetId;
        this.save();

        return {
            success: true,
            defaultPreset: presetId,
            params: this.resolveParams(presetId)
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

        if (this.data.defaultPreset === presetId) {
            this.data.defaultPreset = this.data.presets[0].id;
        }

        this.save();

        return {
            success: true,
            defaultPreset: this.data.defaultPreset,
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

module.exports = { DisplayPresetsManager, SEED_PRESETS, DEFAULT_SEED };
