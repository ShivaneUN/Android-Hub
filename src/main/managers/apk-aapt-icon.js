const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { getToolsDir } = require("../paths");

const AAPT_TIMEOUT_MS = 45000;
const MAX_XML_DEPTH = 4;

const DPI_RANK = {
    xxxhdpi: 0,
    xxhdpi: 1,
    xhdpi: 2,
    hdpi: 3,
    mdpi: 4,
    ldpi: 5,
    nodpi: 6,
    anydpi: 7
};

function getAapt2Path() {
    return path.join(getToolsDir(), "aapt", "aapt2.exe");
}

function aapt2Available() {
    try {
        return fs.existsSync(getAapt2Path());
    } catch (_err) {
        return false;
    }
}

function execFilePromise(bin, args, timeoutMs = AAPT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        execFile(
            bin,
            args,
            {
                windowsHide: true,
                maxBuffer: 64 * 1024 * 1024,
                timeout: timeoutMs
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve(String(stdout || ""));
            }
        );
    });
}

function parseBadgingIconPaths(badgingStdout) {
    /** @type {Map<number, string>} */
    const byDensity = new Map();
    const re = /application-icon-(\d+):'([^']+)'/g;
    let match = re.exec(badgingStdout);
    while (match) {
        byDensity.set(Number(match[1]), match[2]);
        match = re.exec(badgingStdout);
    }
    return byDensity;
}

/** Chemins XML (adaptive-icon) déclarés dans badging — à streamer dans un slim APK. */
async function listBadgingXmlIconPaths(apkPath) {
    if (!apkPath || !aapt2Available()) return [];
    try {
        const badging = await execFilePromise(getAapt2Path(), ["dump", "badging", apkPath], 20000);
        const paths = [...parseBadgingIconPaths(badging).values()];
        return [...new Set(paths.filter((entry) => looksLikeXmlPath(entry)))];
    } catch (_err) {
        return [];
    }
}

/**
 * @param {string} resourcesStdout
 * @returns {Map<number, Array<{ density: string, path: string, isXml: boolean }>>}
 */
function parseResourcesFileIndex(resourcesStdout) {
    /** @type {Map<number, Array<{ density: string, path: string, isXml: boolean }>>} */
    const index = new Map();
    const lines = String(resourcesStdout || "").split(/\r?\n/);
    let currentId = null;

    for (const line of lines) {
        const resMatch = line.match(/^\s*resource\s+0x([0-9a-fA-F]+)\b/);
        if (resMatch) {
            currentId = Number.parseInt(resMatch[1], 16);
            if (!index.has(currentId)) index.set(currentId, []);
            continue;
        }
        if (currentId == null) continue;

        const fileMatch = line.match(/^\s*\(([^)]*)\)\s+\(file\)\s+(\S+)(?:\s+type=(\S+))?/);
        if (!fileMatch) continue;

        const density = String(fileMatch[1] || "").trim().toLowerCase() || "nodpi";
        const filePath = fileMatch[2];
        const type = String(fileMatch[3] || "");
        const isXml = /xml/i.test(type) || /\.xml$/i.test(filePath);
        index.get(currentId).push({ density, path: filePath, isXml });
    }

    return index;
}

function parseXmlDrawableRefs(xmltreeStdout) {
    const ids = [];
    const re = /@0x([0-9a-fA-F]+)/g;
    let match = re.exec(xmltreeStdout);
    while (match) {
        ids.push(Number.parseInt(match[1], 16));
        match = re.exec(xmltreeStdout);
    }
    return [...new Set(ids)];
}

function rankDensity(density) {
    const key = String(density || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DPI_RANK, key)) return DPI_RANK[key];
    return 50;
}

function sortResourceVariants(variants = []) {
    return [...variants].sort((a, b) => {
        if (a.isXml !== b.isXml) return a.isXml ? 1 : -1;
        return rankDensity(a.density) - rankDensity(b.density);
    });
}

function looksLikeRasterPath(entryPath) {
    return /\.(png|webp|jpe?g)$/i.test(String(entryPath || ""));
}

function looksLikeXmlPath(entryPath) {
    return /\.xml$/i.test(String(entryPath || ""));
}

function isExtensionlessResPath(entryPath) {
    const value = String(entryPath || "").replace(/\\/g, "/");
    if (!/^res\//i.test(value)) return false;
    const base = path.basename(value);
    // Accept obfuscated files like res/ima or res/raw/btB (no extension).
    if (/\.(png|webp|jpe?g|xml|mp3|mp4|ogg|json|txt)$/i.test(base)) return false;
    return !/\.[a-z0-9]{1,5}$/i.test(base);
}

function resourceType(id) {
    return (Number(id) >> 16) & 0xff;
}

function isLikelyColorOrStringType(id) {
    const type = resourceType(id);
    // Skip low resource types that are never launcher bitmaps.
    return type <= 0x06;
}

function dpiRankFromPath(entryPath) {
    const norm = String(entryPath || "").replace(/\\/g, "/").toLowerCase();
    if (norm.includes("xxxhdpi")) return 0;
    if (norm.includes("xxhdpi")) return 1;
    if (norm.includes("xhdpi")) return 2;
    if (norm.includes("hdpi")) return 3;
    if (norm.includes("mdpi")) return 4;
    if (norm.includes("ldpi")) return 5;
    return 40;
}

/**
 * Prefer density rasters that share the XML basename (ic_logo_square.xml → ic_logo_square.png).
 * Uses tar listing — much faster than a full aapt2 resources dump on huge APKs.
 */
async function findRasterSiblingsViaTar(apkPath, xmlEntry) {
    const base = path.basename(String(xmlEntry || "")).replace(/\.xml$/i, "");
    if (!base) return null;

    let listing = "";
    try {
        listing = await execFilePromise("tar", ["-tf", apkPath], 60000);
    } catch (_err) {
        return null;
    }

    const needle = new RegExp(`(^|/)${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(png|webp)$`, "i");
    const matches = listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && needle.test(line) && /(^|\/)res\//i.test(line));

    if (!matches.length) return null;
    matches.sort((a, b) => dpiRankFromPath(a) - dpiRankFromPath(b));
    return matches[0];
}

function parseAdaptiveLayerIds(xmltreeStdout) {
    const lines = String(xmltreeStdout || "").split(/\r?\n/);
    /** @type {{ background: number|null, foreground: number|null, monochrome: number|null }} */
    const layers = { background: null, foreground: null, monochrome: null };
    let current = null;

    for (const line of lines) {
        if (/E:\s*background\b/i.test(line)) current = "background";
        else if (/E:\s*foreground\b/i.test(line)) current = "foreground";
        else if (/E:\s*monochrome\b/i.test(line)) current = "monochrome";
        else if (/^\s*E:/i.test(line)) current = null;

        if (!current) continue;
        const ref = line.match(/@0x([0-9a-fA-F]+)/);
        if (ref && layers[current] == null) {
            layers[current] = Number.parseInt(ref[1], 16);
        }
    }
    return layers;
}

/** Couleurs framework android.R.color les plus courantes pour adaptive-icon. */
const ANDROID_FRAMEWORK_COLORS = {
    0x0106000b: "#ffffff", // white
    0x0106000c: "#000000", // black
    0x0106000d: "#00000000", // transparent
    0x01060001: "#ffffff",
    0x0106000f: "#ffffff"
};

function parseResourceColors(resourcesStdout) {
    /** @type {Map<number, string>} */
    const colors = new Map();
    const lines = String(resourcesStdout || "").split(/\r?\n/);
    let currentId = null;

    for (const line of lines) {
        const resMatch = line.match(/^\s*resource\s+0x([0-9a-fA-F]+)\b/);
        if (resMatch) {
            currentId = Number.parseInt(resMatch[1], 16);
            continue;
        }
        if (currentId == null) continue;

        const hexMatch = line.match(/#([0-9a-fA-F]{6,8})\b/);
        if (hexMatch) {
            let hex = hexMatch[1];
            if (hex.length === 6) hex = `ff${hex}`;
            if (hex.length === 8) {
                const a = Number.parseInt(hex.slice(0, 2), 16);
                const r = Number.parseInt(hex.slice(2, 4), 16);
                const g = Number.parseInt(hex.slice(4, 6), 16);
                const b = Number.parseInt(hex.slice(6, 8), 16);
                colors.set(
                    currentId,
                    a === 0xff
                        ? `#${hex.slice(2)}`
                        : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
                );
            }
            continue;
        }

        const typed = line.match(/\(type 0x1d\)0x([0-9a-fA-F]+)/i);
        if (typed) {
            const value = Number.parseInt(typed[1], 16) >>> 0;
            const a = (value >>> 24) & 0xff;
            const r = (value >>> 16) & 0xff;
            const g = (value >>> 8) & 0xff;
            const b = value & 0xff;
            const rgb = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
            colors.set(currentId, a === 0xff ? `#${rgb}` : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`);
        }
    }
    return colors;
}

function pickBestVariantFile(variants = []) {
    const sorted = sortResourceVariants(variants);
    for (const variant of sorted) {
        if (!variant?.path) continue;
        if (variant.isXml || looksLikeXmlPath(variant.path)) continue;
        if (looksLikeRasterPath(variant.path) || isExtensionlessResPath(variant.path)) {
            return variant.path;
        }
    }
    return null;
}

/**
 * Resolve adaptive-icon layers (background + foreground) for official launcher look.
 * @returns {Promise<{
 *   sibling?: string,
 *   backgroundColor?: string|null,
 *   backgroundPath?: string|null,
 *   foregroundPath?: string|null,
 *   xmlEntry?: string
 * }|null>}
 */
async function resolveApkAdaptiveLayers(apkPath) {
    if (!apkPath || !aapt2Available()) return null;

    const aapt2 = getAapt2Path();
    let badging = "";
    try {
        badging = await execFilePromise(aapt2, ["dump", "badging", apkPath]);
    } catch (_err) {
        return null;
    }

    const iconByDensity = parseBadgingIconPaths(badging);
    if (!iconByDensity.size) return null;

    const densSorted = [...iconByDensity.entries()].sort((a, b) => b[0] - a[0]);
    const preferred = densSorted.filter(([density]) => density < 65534);
    const fallback = densSorted.filter(([density]) => density >= 65534);
    const xmlCandidates = [...preferred, ...fallback]
        .map(([, iconPath]) => iconPath)
        .filter((entry) => looksLikeXmlPath(entry));
    const uniqueXml = [...new Set(xmlCandidates)];
    if (!uniqueXml.length) return null;

    let resourcesStdout = null;
    const loadResourcesStdout = async () => {
        if (resourcesStdout != null) return resourcesStdout;
        try {
            resourcesStdout = await execFilePromise(aapt2, ["dump", "resources", apkPath]);
        } catch (_err) {
            resourcesStdout = "";
        }
        return resourcesStdout;
    };

    for (const xmlEntry of uniqueXml) {
        let xmltree = "";
        try {
            xmltree = await execFilePromise(aapt2, ["dump", "xmltree", "--file", xmlEntry, apkPath]);
        } catch (_err) {
            continue;
        }
        if (!/adaptive-icon/i.test(xmltree)) continue;

        // Discord etc. : raster sibling déjà = logo officiel composé.
        const sibling = await findRasterSiblingsViaTar(apkPath, xmlEntry);
        if (sibling) {
            return { sibling, xmlEntry, foregroundPath: sibling };
        }

        const layerIds = parseAdaptiveLayerIds(xmltree);
        if (layerIds.foreground == null && layerIds.background == null) continue;

        const resourcesStdoutLocal = await loadResourcesStdout();
        const resources = parseResourcesFileIndex(resourcesStdoutLocal);
        const colors = parseResourceColors(resourcesStdoutLocal);

        /** @type {{ sibling?: string, backgroundColor?: string|null, backgroundPath?: string|null, foregroundPath?: string|null, xmlEntry?: string }} */
        const result = {
            xmlEntry,
            backgroundColor: null,
            backgroundPath: null,
            foregroundPath: null
        };

        const resolveLayer = (id) => {
            if (id == null) return { color: null, path: null };
            if ((id & 0xff000000) === 0x01000000) {
                const color = ANDROID_FRAMEWORK_COLORS[id] || null;
                return {
                    color: color && color !== "#00000000" ? color : null,
                    path: null
                };
            }
            if (colors.has(id)) {
                return { color: colors.get(id), path: null };
            }
            const filePath = pickBestVariantFile(resources.get(id) || []);
            return { color: null, path: filePath };
        };

        const bg = resolveLayer(layerIds.background);
        const fg = resolveLayer(layerIds.foreground);

        result.backgroundColor = bg.color;
        result.backgroundPath = bg.path;
        result.foregroundPath = fg.path;

        // Foreground parfois XML (vecteur) — pas de compose raster ici.
        if (!result.foregroundPath) continue;
        if (looksLikeXmlPath(result.foregroundPath)) continue;

        return result;
    }

    return null;
}

/**
 * Resolve the best launcher icon zip entry inside an APK via aapt2
 * (handles obfuscated flat res/*, adaptive XML → layered rasters, Discord ic_logo, etc.).
 * @param {string} apkPath
 * @returns {Promise<string|null>}
 */
async function resolveApkIconEntry(apkPath) {
    if (!apkPath || !aapt2Available()) return null;

    // Prefer full adaptive composite sources when available.
    try {
        const layers = await resolveApkAdaptiveLayers(apkPath);
        if (layers?.sibling) return layers.sibling;
        if (layers?.foregroundPath) return layers.foregroundPath;
    } catch (_err) {
        // fallback legacy below
    }

    const aapt2 = getAapt2Path();
    let badging = "";
    try {
        badging = await execFilePromise(aapt2, ["dump", "badging", apkPath]);
    } catch (err) {
        console.warn("[ApkAaptIcon] badging:", err.message);
        return null;
    }

    const iconByDensity = parseBadgingIconPaths(badging);
    if (!iconByDensity.size) return null;

    /** @type {Map<number, Array<{ density: string, path: string, isXml: boolean }>>|null} */
    let resourcesIndex = null;
    const loadResources = async () => {
        if (resourcesIndex) return resourcesIndex;
        try {
            const stdout = await execFilePromise(aapt2, ["dump", "resources", apkPath]);
            resourcesIndex = parseResourcesFileIndex(stdout);
        } catch (err) {
            console.warn("[ApkAaptIcon] resources:", err.message);
            resourcesIndex = new Map();
        }
        return resourcesIndex;
    };

    const resolveXmlEntry = async (xmlEntry, depth) => {
        if (depth > MAX_XML_DEPTH) return null;

        let xmltree = "";
        try {
            xmltree = await execFilePromise(aapt2, ["dump", "xmltree", "--file", xmlEntry, apkPath]);
        } catch (_err) {
            return null;
        }

        // Pure vector drawables have no adaptive layers — don't chase color refs / huge dumps.
        if (!/adaptive-icon/i.test(xmltree)) {
            return null;
        }

        // Sibling rasters for the same icon name (Discord ic_logo_square.png, etc.).
        const sibling = await findRasterSiblingsViaTar(apkPath, xmlEntry);
        if (sibling) return sibling;

        const refs = parseXmlDrawableRefs(xmltree);
        if (!refs.length) return null;

        const resources = await loadResources();
        // Adaptive XML order is usually background → foreground → monochrome.
        // Prefer later refs first (foreground), then earlier.
        const orderedRefs = [...refs].reverse();

        for (const id of orderedRefs) {
            // Skip framework/system ids (0x01......) and non-drawable tables.
            if ((id & 0xff000000) === 0x01000000) continue;
            if (isLikelyColorOrStringType(id)) continue;

            const variants = sortResourceVariants(resources.get(id) || []);
            for (const variant of variants) {
                if (!variant?.path) continue;
                if (variant.isXml || looksLikeXmlPath(variant.path)) {
                    const nested = await resolveXmlEntry(variant.path, depth + 1);
                    if (nested) return nested;
                    continue;
                }
                if (looksLikeRasterPath(variant.path) || isExtensionlessResPath(variant.path)) {
                    return variant.path;
                }
            }
        }
        return null;
    };

    const resolveEntry = async (entryPath, depth = 0) => {
        if (!entryPath || depth > MAX_XML_DEPTH) return null;
        if (looksLikeRasterPath(entryPath) || isExtensionlessResPath(entryPath)) {
            return entryPath;
        }
        if (looksLikeXmlPath(entryPath)) {
            return resolveXmlEntry(entryPath, depth);
        }
        return null;
    };

    const densSorted = [...iconByDensity.entries()].sort((a, b) => b[0] - a[0]);
    // Prefer concrete densities first; anydpi (65534/65535) often points only to adaptive XML.
    const preferred = densSorted.filter(([density]) => density < 65534);
    const fallback = densSorted.filter(([density]) => density >= 65534);

    for (const [, iconPath] of [...preferred, ...fallback]) {
        const resolved = await resolveEntry(iconPath, 0);
        if (resolved) return resolved;
    }

    return null;
}

module.exports = {
    aapt2Available,
    getAapt2Path,
    listBadgingXmlIconPaths,
    resolveApkAdaptiveLayers,
    resolveApkIconEntry
};
