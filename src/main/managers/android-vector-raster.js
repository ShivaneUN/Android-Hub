const path = require("path");
const { execFile } = require("child_process");
const { Resvg } = require("@resvg/resvg-js");
const { getAapt2Path, aapt2Available } = require("./apk-aapt-icon");

const AAPT_TIMEOUT_MS = 45000;
const OUTPUT_SIZE = 192;

function execFilePromise(bin, args, timeoutMs = AAPT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        execFile(
            bin,
            args,
            { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
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

function argbToCss(argb) {
    const value = Number(argb) >>> 0;
    const a = (value >>> 24) & 0xff;
    const r = (value >>> 16) & 0xff;
    const g = (value >>> 8) & 0xff;
    const b = value & 0xff;
    if (a === 0xff) {
        return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    }
    return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

function parseColorMap(resourcesStdout) {
    /** @type {Map<number, string>} */
    const colors = new Map();
    /** @type {Map<number, string>} */
    const drawableFiles = new Map();
    const lines = String(resourcesStdout || "").split(/\r?\n/);
    let currentId = null;

    for (const line of lines) {
        const resMatch = line.match(/^\s*resource\s+0x([0-9a-fA-F]+)\b/);
        if (resMatch) {
            currentId = Number.parseInt(resMatch[1], 16);
            continue;
        }
        if (currentId == null) continue;

        const fileMatch = line.match(/\(file\)\s+(\S+\.xml)/i);
        if (fileMatch) {
            drawableFiles.set(currentId, fileMatch[1]);
        }

        const hexMatch = line.match(/#([0-9a-fA-F]{6,8})\b/);
        if (hexMatch) {
            let hex = hexMatch[1];
            if (hex.length === 6) hex = `ff${hex}`;
            if (hex.length === 8) {
                colors.set(currentId, argbToCss(Number.parseInt(hex, 16)));
            }
            continue;
        }

        const typed = line.match(/\(type 0x1d\)0x([0-9a-fA-F]+)/i);
        if (typed) {
            colors.set(currentId, argbToCss(Number.parseInt(typed[1], 16)));
        }
    }

    return { colors, drawableFiles };
}

function parseAndroidColorToken(raw) {
    if (!raw) return "#ffffff";
    const hash = raw.match(/#([0-9a-fA-F]{6,8})/);
    if (hash) {
        let hex = hash[1];
        if (hex.length === 6) return `#${hex}`;
        return argbToCss(Number.parseInt(hex, 16));
    }
    const typed = raw.match(/\(type 0x1d\)0x([0-9a-fA-F]+)/i);
    if (typed) return argbToCss(Number.parseInt(typed[1], 16));
    return "#ffffff";
}

function gradientXmltreeToSvgDef(xmltree, gradId) {
    const lines = String(xmltree || "").split(/\r?\n/);
    let startX = 0;
    let startY = 0;
    let endX = 1;
    let endY = 0;
    /** @type {Array<{ offset: number, color: string }>} */
    const stops = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sx = line.match(/startX\([^)]*\)=([0-9.]+)/i);
        const sy = line.match(/startY\([^)]*\)=([0-9.]+)/i);
        const ex = line.match(/endX\([^)]*\)=([0-9.]+)/i);
        const ey = line.match(/endY\([^)]*\)=([0-9.]+)/i);
        if (sx) startX = Number(sx[1]);
        if (sy) startY = Number(sy[1]);
        if (ex) endX = Number(ex[1]);
        if (ey) endY = Number(ey[1]);

        if (/E:\s*item\b/i.test(line)) {
            let color = "#ffffff";
            let offset = stops.length === 0 ? 0 : 1;
            for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
                if (/^\s*E:/i.test(lines[j])) break;
                if (/color\(/i.test(lines[j])) color = parseAndroidColorToken(lines[j]);
                const off = lines[j].match(/offset\([^)]*\)=([0-9.]+)/i);
                if (off) offset = Number(off[1]);
            }
            stops.push({ offset, color });
        }
    }

    if (!stops.length) return null;

    const stopMarkup = stops
        .map((stop) => `<stop offset="${stop.offset}" stop-color="${stop.color}" />`)
        .join("");

    return [
        `<linearGradient id="${gradId}" gradientUnits="userSpaceOnUse"`,
        ` x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}">`,
        stopMarkup,
        "</linearGradient>"
    ].join("");
}

function resolveFill(raw, fillMap) {
    if (!raw) return "#ffffff";
    const literal = raw.match(/\(type 0x1d\)0x([0-9a-fA-F]+)/i);
    if (literal) return argbToCss(Number.parseInt(literal[1], 16));

    const ref = raw.match(/@0x([0-9a-fA-F]+)/i);
    if (ref) {
        const id = Number.parseInt(ref[1], 16);
        if (fillMap.has(id)) return fillMap.get(id);
        return "#888888";
    }

    const plain = raw.match(/#([0-9a-fA-F]{6,8})/);
    if (plain) {
        let hex = plain[1];
        if (hex.length === 6) return `#${hex}`;
        return argbToCss(Number.parseInt(hex, 16));
    }

    return "#ffffff";
}

function parseIeeeFloatHex(hex) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(Number.parseInt(hex, 16) >>> 0);
    return buf.readFloatBE(0);
}

function parseVectorViewport(lines, startIdx) {
    let viewportWidth = 24;
    let viewportHeight = 24;

    for (let j = startIdx + 1; j < Math.min(startIdx + 24, lines.length); j++) {
        const line = lines[j];
        if (/^\s*E:/i.test(line)) break;

        let match = line.match(/viewportWidth\([^)]*\)=\(type 0x4\)0x([0-9a-fA-F]+)/i);
        if (match) {
            viewportWidth = parseIeeeFloatHex(match[1]);
            continue;
        }
        match = line.match(/viewportHeight\([^)]*\)=\(type 0x4\)0x([0-9a-fA-F]+)/i);
        if (match) {
            viewportHeight = parseIeeeFloatHex(match[1]);
            continue;
        }

        match = line.match(/viewportWidth\([^)]*\)=(\d+(?:\.\d+)?)\b/i);
        if (match) {
            viewportWidth = Number(match[1]);
            continue;
        }
        match = line.match(/viewportHeight\([^)]*\)=(\d+(?:\.\d+)?)\b/i);
        if (match) {
            viewportHeight = Number(match[1]);
        }
    }

    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) viewportWidth = 24;
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) viewportHeight = 24;
    return { viewportWidth, viewportHeight };
}

/**
 * Convert aapt2 xmltree of an Android VectorDrawable into SVG markup.
 * @param {string} xmltree
 * @param {Map<number, string>} fillMap
 * @param {string[]} extraDefs
 */
function vectorXmltreeToSvg(xmltree, fillMap = new Map(), extraDefs = []) {
    const lines = String(xmltree || "").split(/\r?\n/);
    let viewportWidth = 24;
    let viewportHeight = 24;
    /** @type {string[]} */
    const parts = [];
    let clipIdSeq = 0;
    /** @type {string[]} */
    const defs = [...extraDefs];
    let openGroups = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/E:\s*vector\b/i.test(line)) {
            const viewport = parseVectorViewport(lines, i);
            viewportWidth = viewport.viewportWidth;
            viewportHeight = viewport.viewportHeight;
            continue;
        }

        if (/E:\s*clip-path\b/i.test(line)) {
            let pathData = null;
            for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                if (/^\s*E:/i.test(lines[j])) break;
                const rawQuoted = lines[j].match(/\(Raw:\s*"([^"]+)"\)/);
                if (rawQuoted && /pathData/i.test(lines[j])) {
                    pathData = rawQuoted[1];
                    break;
                }
                const pd = lines[j].match(/pathData\([^)]*\)=(?:"([^"]+)"|([^\s(]+))/i);
                if (pd) {
                    pathData = (pd[1] || pd[2] || "").trim();
                    break;
                }
            }
            if (pathData) {
                const id = `c${clipIdSeq++}`;
                defs.push(`<clipPath id="${id}"><path d="${pathData}"/></clipPath>`);
                parts.push(`<g clip-path="url(#${id})">`);
                openGroups += 1;
            }
            continue;
        }

        if (/E:\s*path\b/i.test(line)) {
            let pathData = null;
            let fillRaw = null;
            let fillAlpha = 1;
            let fillType = "nonzero";

            for (let j = i + 1; j < Math.min(i + 16, lines.length); j++) {
                if (/^\s*E:/i.test(lines[j])) break;

                const rawQuoted = lines[j].match(/\(Raw:\s*"([^"]+)"\)/);
                if (rawQuoted && /pathData/i.test(lines[j])) {
                    pathData = rawQuoted[1];
                }
                if (!pathData) {
                    const pd = lines[j].match(/pathData\([^)]*\)=(?:"([^"]+)"|([^\s(]+))/i);
                    if (pd) pathData = (pd[1] || pd[2] || "").trim();
                }

                if (/fillColor/i.test(lines[j])) fillRaw = lines[j];

                const faHex = lines[j].match(/fillAlpha\([^)]*\)=\(type 0x4\)0x([0-9a-fA-F]+)/i);
                if (faHex) {
                    fillAlpha = parseIeeeFloatHex(faHex[1]);
                } else {
                    const faNum = lines[j].match(/fillAlpha\([^)]*\)=([0-9.]+)/i);
                    if (faNum) fillAlpha = Number(faNum[1]);
                }

                if (/fillType/i.test(lines[j]) && /0x1\b/.test(lines[j])) {
                    fillType = "evenodd";
                }
            }

            if (!pathData) continue;
            let fill = resolveFill(fillRaw || "", fillMap);
            if (
                fillAlpha < 0.999
                && fill.startsWith("#")
                && fill.length === 7
            ) {
                const r = Number.parseInt(fill.slice(1, 3), 16);
                const g = Number.parseInt(fill.slice(3, 5), 16);
                const b = Number.parseInt(fill.slice(5, 7), 16);
                fill = `rgba(${r},${g},${b},${Math.max(0, Math.min(1, fillAlpha)).toFixed(3)})`;
            }
            parts.push(
                `<path d="${pathData}" fill="${fill}" fill-rule="${fillType}" />`
            );
        }
    }

    while (openGroups > 0) {
        parts.push("</g>");
        openGroups -= 1;
    }

    if (!parts.length) return null;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}"`,
        ` viewBox="0 0 ${viewportWidth} ${viewportHeight}">`,
        defs.length ? `<defs>${defs.join("")}</defs>` : "",
        parts.join(""),
        "</svg>"
    ].join("");
}

/**
 * Rasterize an Android vector XML entry inside an APK to a PNG buffer.
 * @param {string} apkPath
 * @param {string} vectorEntry
 * @returns {Promise<Buffer|null>}
 */
async function rasterizeApkVectorEntry(apkPath, vectorEntry) {
    if (!apkPath || !vectorEntry || !aapt2Available()) return null;

    const aapt2 = getAapt2Path();
    let xmltree = "";
    try {
        xmltree = await execFilePromise(aapt2, ["dump", "xmltree", "--file", vectorEntry, apkPath]);
    } catch (_err) {
        return null;
    }

    if (!/\bvector\b/i.test(xmltree)) return null;

    /** @type {Map<number, string>} */
    let fillMap = new Map();
    /** @type {string[]} */
    const gradientDefs = [];

    try {
        const resources = await execFilePromise(aapt2, ["dump", "resources", apkPath]);
        const { colors, drawableFiles } = parseColorMap(resources);
        fillMap = new Map(colors);

        const fillRefs = [...xmltree.matchAll(/fillColor[^@\n]*@0x([0-9a-fA-F]+)/gi)]
            .map((match) => Number.parseInt(match[1], 16));
        const uniqueRefs = [...new Set(fillRefs)];
        let gradSeq = 0;

        for (const id of uniqueRefs) {
            if (fillMap.has(id)) continue;
            const drawablePath = drawableFiles.get(id);
            if (!drawablePath) continue;
            try {
                const nested = await execFilePromise(aapt2, ["dump", "xmltree", "--file", drawablePath, apkPath]);
                if (/\bgradient\b/i.test(nested)) {
                    const gradId = `g${gradSeq++}`;
                    const def = gradientXmltreeToSvgDef(nested, gradId);
                    if (def) {
                        gradientDefs.push(def);
                        fillMap.set(id, `url(#${gradId})`);
                    }
                }
            } catch (_err) {
                // keep fallback gray
            }
        }
    } catch (_err) {
        // Colors may still be literal in the vector.
    }

    const svg = vectorXmltreeToSvg(xmltree, fillMap, gradientDefs);
    if (!svg) return null;

    try {
        const resvg = new Resvg(svg, {
            fitTo: { mode: "width", value: OUTPUT_SIZE }
        });
        return Buffer.from(resvg.render().asPng());
    } catch (err) {
        console.warn("[VectorRaster]", path.basename(vectorEntry), err.message);
        return null;
    }
}

/**
 * Find a vector XML entry from badging / adaptive foreground when no raster exists.
 * @param {string} apkPath
 * @returns {Promise<string|null>}
 */
async function resolveApkVectorEntry(apkPath) {
    if (!apkPath || !aapt2Available()) return null;
    const aapt2 = getAapt2Path();

    let badging = "";
    try {
        badging = await execFilePromise(aapt2, ["dump", "badging", apkPath]);
    } catch (_err) {
        return null;
    }

    const icons = [];
    for (const match of badging.matchAll(/application-icon-(\d+):'([^']+)'/g)) {
        icons.push({ density: Number(match[1]), path: match[2] });
    }
    icons.sort((a, b) => b.density - a.density);
    if (!icons.length) return null;

    const seen = new Set();
    for (const icon of icons) {
        if (!icon.path || seen.has(icon.path)) continue;
        seen.add(icon.path);
        if (!/\.xml$/i.test(icon.path)) continue;

        let xmltree = "";
        try {
            xmltree = await execFilePromise(aapt2, ["dump", "xmltree", "--file", icon.path, apkPath]);
        } catch (_err) {
            continue;
        }

        if (/\bE:\s*vector\b/i.test(xmltree) || /\bvector\s+\(line/i.test(xmltree)) {
            return icon.path;
        }

        if (!/adaptive-icon/i.test(xmltree)) continue;

        // Adaptive → prefer foreground drawable resource file if it's a vector XML.
        const refs = [...xmltree.matchAll(/@0x([0-9a-fA-F]+)/g)]
            .map((m) => Number.parseInt(m[1], 16))
            .filter((id) => (id & 0xff000000) !== 0x01000000);
        if (!refs.length) continue;

        let resourcesStdout = "";
        try {
            resourcesStdout = await execFilePromise(aapt2, ["dump", "resources", apkPath]);
        } catch (_err) {
            continue;
        }

        const ordered = [...refs].reverse();
        // Prefer foreground over monochrome / background.
        const scored = ordered.map((id, index) => {
            const hex = `0x${id.toString(16)}`;
            const blockMatch = resourcesStdout.match(
                new RegExp(`resource\\s+${hex}\\b([\\s\\S]*?)(?=\\n\\s*resource\\s+0x|\\n\\s*type\\s+|$)`, "i")
            );
            const fileMatch = blockMatch?.[1]?.match(/\(file\)\s+(\S+\.xml)/i);
            const filePath = fileMatch?.[1] || "";
            let score = index;
            if (/monochrome/i.test(filePath)) score -= 100;
            if (/background/i.test(filePath)) score -= 50;
            if (/foreground/i.test(filePath)) score += 100;
            return { id, filePath, score };
        }).filter((item) => item.filePath)
            .sort((a, b) => b.score - a.score);

        for (const item of scored) {
            let nestedTree = "";
            try {
                nestedTree = await execFilePromise(aapt2, ["dump", "xmltree", "--file", item.filePath, apkPath]);
            } catch (_err) {
                continue;
            }
            if (/\bvector\b/i.test(nestedTree)) return item.filePath;
        }
    }

    return null;
}

module.exports = {
    rasterizeApkVectorEntry,
    resolveApkVectorEntry,
    vectorXmltreeToSvg
};
