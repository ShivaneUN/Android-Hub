/**
 * Modèle et validation des paramètres de flux vidéo (scrcpy).
 * Valeurs autorisées = celles du panneau de contrôle (boutons segmentés).
 */

/** Défaut USB / preset seed — FULL HD 60 fps 8 Mbps. */
const DEFAULT_STREAM_PARAMS = Object.freeze({
    width: 1920,
    height: 1080,
    dpi: 240,
    maxFps: 60,
    bitRateMbps: 8,
    iFrameInterval: 1,
    videoCodec: "h264"
});

/** Défaut lancement WiFi — HD 720p 30 fps 8 Mbps (latence / bande passante). */
const DEFAULT_WIFI_STREAM_PARAMS = Object.freeze({
    width: 1280,
    height: 720,
    dpi: 240,
    maxFps: 30,
    bitRateMbps: 8,
    iFrameInterval: 1,
    videoCodec: "h264"
});

/** Résolution appliquée à l’activation du mode performance (modifiable ensuite). */
const PERFORMANCE_STREAM_RESOLUTION = Object.freeze({
    width: 960,
    height: 540
});

/** Serial ADB WiFi (`ip:port`) ou hint transport. */
function isWifiTransportSerial(serial) {
    return /:\d+$/.test(String(serial || "").trim());
}

/** Options affichées dans le panneau de contrôle */
const CONTROL_OPTIONS = Object.freeze({
    resolutions: [
        { width: 1920, height: 1080, label: "FULL HD" },
        { width: 1600, height: 900, label: "1600×900" },
        { width: 1280, height: 720, label: "HD" },
        { width: 960, height: 540, label: "qHD" }
    ],
    fps: [120, 60, 30],
    dpi: [
        { value: 420, label: "Natif" },
        { value: 320, label: "320" },
        { value: 280, label: "280" },
        { value: 240, label: "Normal" },
        { value: 200, label: "200" },
        { value: 160, label: "Moyen" },
        { value: 120, label: "Très gros" }
    ],
    bitRateMbps: [1, 2, 4, 6, 8, 12, 16, 24],
    iFrameInterval: [
        { value: 1, label: "Rapide" },
        { value: 2, label: "2 s" },
        { value: 3, label: "3 s" },
        { value: 5, label: "5 s" },
        { value: 10, label: "Lent" }
    ],
    videoCodec: [
        { value: "h264", label: "H264" },
        { value: "h265", label: "H265 (HEVC)" }
    ]
});

/** @deprecated alias pour compatibilité */
const RESOLUTION_PRESETS = CONTROL_OPTIONS.resolutions;

const ORIENTATION_PORTRAIT = "portrait";
const ORIENTATION_LANDSCAPE = "landscape";
const DEFAULT_ORIENTATION = ORIENTATION_LANDSCAPE;

function normalizeOrientation(value) {
    return value === ORIENTATION_LANDSCAPE ? ORIENTATION_LANDSCAPE : ORIENTATION_PORTRAIT;
}

function getOrientationFromScrcpyOptions(options = {}) {
    return options.orientation === ORIENTATION_PORTRAIT ? ORIENTATION_PORTRAIT : ORIENTATION_LANDSCAPE;
}

function withOrientation(scrcpyOptions, orientation) {
    const next = { ...(scrcpyOptions || {}) };
    if (normalizeOrientation(orientation) === ORIENTATION_PORTRAIT) {
        next.orientation = ORIENTATION_PORTRAIT;
    } else {
        delete next.orientation;
    }
    return next;
}

function toggleOrientationValue(orientation) {
    return normalizeOrientation(orientation) === ORIENTATION_LANDSCAPE
        ? ORIENTATION_PORTRAIT
        : ORIENTATION_LANDSCAPE;
}

/**
 * Verrou scrcpy relatif à l'orientation naturelle de l'appareil
 * (portrait = téléphone, paysage = tablette).
 * @returns {string|null} ex. '@270', '@90', ou null (naturel)
 */
function resolveCaptureOrientationLock(orientation, deviceWidth, deviceHeight) {
    const wantPortrait = normalizeOrientation(orientation) === ORIENTATION_PORTRAIT;
    const hasDims = Number(deviceWidth) > 0 && Number(deviceHeight) > 0;
    // Sans dims physiques, supposer un téléphone portrait (cas le plus fréquent).
    const naturalLandscape = hasDims ? deviceWidth >= deviceHeight : false;

    if (naturalLandscape) {
        return wantPortrait ? "@90" : null;
    }
    return wantPortrait ? null : "@270";
}

function captureRotationFromLock(lock) {
    if (!lock) return 0;
    const match = String(lock).match(/@?(\d+)/);
    return match ? Number(match[1]) || 0 : 0;
}

function applyCaptureOrientationToOptions(options, orientation, deviceWidth, deviceHeight) {
    const lock = resolveCaptureOrientationLock(orientation, deviceWidth, deviceHeight);
    options.captureOrientationLock = lock;
    options.captureRotation = captureRotationFromLock(lock);
    return options;
}

/** Type B au lancement : le VD `new_display` est déjà paysage — pas de verrou @270/@90.
 * (Un lock “landscape” sur téléphone portrait encode 1080x1920 dans un cadre 1920x1080 → letterbox.)
 */
function applyTypeBLaunchOrientation(options = {}, deviceWidth, deviceHeight) {
    delete options.orientation;
    options.captureOrientationLock = null;
    options.captureRotation = 0;
    if (Number(deviceWidth) > 0 && Number(deviceHeight) > 0) {
        options.deviceWidth = Number(deviceWidth);
        options.deviceHeight = Number(deviceHeight);
    } else {
        delete options.deviceWidth;
        delete options.deviceHeight;
    }
    return options;
}

function cloneParams(params = {}) {
    return {
        width: params.width ?? DEFAULT_STREAM_PARAMS.width,
        height: params.height ?? DEFAULT_STREAM_PARAMS.height,
        dpi: params.dpi ?? DEFAULT_STREAM_PARAMS.dpi,
        maxFps: params.maxFps ?? DEFAULT_STREAM_PARAMS.maxFps,
        bitRateMbps: params.bitRateMbps ?? DEFAULT_STREAM_PARAMS.bitRateMbps,
        iFrameInterval: params.iFrameInterval ?? DEFAULT_STREAM_PARAMS.iFrameInterval,
        videoCodec: params.videoCodec ?? DEFAULT_STREAM_PARAMS.videoCodec
    };
}

/**
 * Params d'usine selon le transport.
 * @param {{ wifi?: boolean, serial?: string }} [opts]
 */
function getFactoryStreamParams(opts = {}) {
    const wifi = opts.wifi === true
        || (opts.wifi !== false && isWifiTransportSerial(opts.serial));
    return cloneParams(wifi ? DEFAULT_WIFI_STREAM_PARAMS : DEFAULT_STREAM_PARAMS);
}

function snapResolution(width, height) {
    const match = CONTROL_OPTIONS.resolutions.find((r) => r.width === width && r.height === height);
    if (match) return { width: match.width, height: match.height };
    const target = Math.max(width || 0, height || 0);
    let best = CONTROL_OPTIONS.resolutions[0];
    let bestDelta = Infinity;
    for (const r of CONTROL_OPTIONS.resolutions) {
        const delta = Math.abs(Math.max(r.width, r.height) - target);
        if (delta < bestDelta) {
            bestDelta = delta;
            best = r;
        }
    }
    return { width: best.width, height: best.height };
}

function snapToAllowed(value, allowedValues) {
    if (allowedValues.includes(value)) return value;
    let best = allowedValues[0];
    let bestDelta = Infinity;
    for (const v of allowedValues) {
        const delta = Math.abs(v - value);
        if (delta < bestDelta) {
            bestDelta = delta;
            best = v;
        }
    }
    return best;
}

function snapDpi(value) {
    const allowed = CONTROL_OPTIONS.dpi.map((d) => d.value);
    return snapToAllowed(value, allowed);
}

function snapGop(value) {
    const allowed = CONTROL_OPTIONS.iFrameInterval.map((g) => g.value);
    return snapToAllowed(value, allowed);
}

function snapVideoCodec(value) {
    const allowed = CONTROL_OPTIONS.videoCodec.map((c) => c.value);
    if (allowed.includes(value)) return value;
    return DEFAULT_STREAM_PARAMS.videoCodec;
}

/** Normalise vers les valeurs autorisées du panneau */
function normalizeParams(params = {}) {
    const res = snapResolution(params.width, params.height);
    return cloneParams({
        width: res.width,
        height: res.height,
        dpi: snapDpi(params.dpi),
        maxFps: snapToAllowed(params.maxFps, CONTROL_OPTIONS.fps),
        bitRateMbps: snapToAllowed(params.bitRateMbps, CONTROL_OPTIONS.bitRateMbps),
        iFrameInterval: snapGop(params.iFrameInterval),
        videoCodec: snapVideoCodec(params.videoCodec)
    });
}

function parseNewDisplay(value) {
    if (!value || typeof value !== "string") return null;
    const match = value.trim().match(/^(\d+)x(\d+)(?:\/(\d+))?$/i);
    if (!match) return null;
    return {
        width: Number(match[1]),
        height: Number(match[2]),
        dpi: match[3] ? Number(match[3]) : DEFAULT_STREAM_PARAMS.dpi
    };
}

function formatNewDisplay(params) {
    const p = normalizeParams(params);
    return `${p.width}x${p.height}/${p.dpi}`;
}

function toScrcpyOptions(params, sessionType = "A") {
    const normalized = normalizeParams(params);
    const options = {
        bitRate: Math.round(normalized.bitRateMbps * 1_000_000),
        maxFps: Math.round(normalized.maxFps),
        iFrameInterval: Math.round(normalized.iFrameInterval),
        videoCodec: normalized.videoCodec
    };

    if (sessionType === "B") {
        options.newDisplay = formatNewDisplay(normalized);
    } else {
        options.maxSize = Math.max(normalized.width, normalized.height);
    }

    return options;
}

function fromScrcpyOptions(options = {}, sessionType = "A") {
    let base = { ...DEFAULT_STREAM_PARAMS };

    if (sessionType === "B" && options.newDisplay) {
        const parsed = parseNewDisplay(options.newDisplay);
        if (parsed) {
            base = { ...base, width: parsed.width, height: parsed.height, dpi: parsed.dpi };
        }
    } else {
        const maxSize = options.maxSize || DEFAULT_STREAM_PARAMS.width;
        const res = snapResolution(maxSize, Math.round(maxSize * 9 / 16));
        base = { ...base, width: res.width, height: res.height };
    }

    if (options.maxFps) base.maxFps = options.maxFps;
    if (options.bitRate) base.bitRateMbps = options.bitRate / 1_000_000;
    if (options.iFrameInterval) base.iFrameInterval = options.iFrameInterval;
    if (options.videoCodec) base.videoCodec = options.videoCodec;

    return normalizeParams(base);
}

function validateParams(params) {
    const normalized = normalizeParams(params);
    const errors = [];

    const resOk = CONTROL_OPTIONS.resolutions.some(
        (r) => r.width === normalized.width && r.height === normalized.height
    );
    if (!resOk) errors.push("Résolution non supportée");

    if (!CONTROL_OPTIONS.fps.includes(normalized.maxFps)) {
        errors.push("FPS non supporté");
    }
    if (!CONTROL_OPTIONS.dpi.some((d) => d.value === normalized.dpi)) {
        errors.push("DPI non supporté");
    }
    if (!CONTROL_OPTIONS.bitRateMbps.includes(normalized.bitRateMbps)) {
        errors.push("Bitrate non supporté");
    }
    if (!CONTROL_OPTIONS.iFrameInterval.some((g) => g.value === normalized.iFrameInterval)) {
        errors.push("Intervalle I-frame non supporté");
    }
    if (!CONTROL_OPTIONS.videoCodec.some((c) => c.value === normalized.videoCodec)) {
        errors.push("Codec vidéo non supporté");
    }

    return { valid: errors.length === 0, errors, params: normalized };
}

function paramsEqual(a, b) {
    const left = normalizeParams(a);
    const right = normalizeParams(b);
    return Object.keys(DEFAULT_STREAM_PARAMS).every((key) => left[key] === right[key]);
}

function formatParamsSummary(params) {
    const p = normalizeParams(params);
    const res = CONTROL_OPTIONS.resolutions.find((r) => r.width === p.width && r.height === p.height);
    return `${res?.label || `${p.width}×${p.height}`} · ${p.dpi} dpi · ${p.maxFps} fps · ${p.bitRateMbps} Mbps · GOP ${p.iFrameInterval}s`;
}

const streamParamsApi = {
    DEFAULT_STREAM_PARAMS,
    DEFAULT_WIFI_STREAM_PARAMS,
    PERFORMANCE_STREAM_RESOLUTION,
    CONTROL_OPTIONS,
    RESOLUTION_PRESETS,
    ORIENTATION_PORTRAIT,
    ORIENTATION_LANDSCAPE,
    DEFAULT_ORIENTATION,
    isWifiTransportSerial,
    getFactoryStreamParams,
    cloneParams,
    normalizeParams,
    snapResolution,
    parseNewDisplay,
    formatNewDisplay,
    toScrcpyOptions,
    fromScrcpyOptions,
    validateParams,
    paramsEqual,
    formatParamsSummary,
    normalizeOrientation,
    getOrientationFromScrcpyOptions,
    withOrientation,
    toggleOrientationValue,
    resolveCaptureOrientationLock,
    captureRotationFromLock,
    applyCaptureOrientationToOptions,
    applyTypeBLaunchOrientation
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = streamParamsApi;
} else {
    globalThis.StreamParams = streamParamsApi;
}
