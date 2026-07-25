const sharp = require("sharp");

const OUTPUT_SIZE = 192;

function detectRasterKind(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return "png";
    }
    if (
        buffer.toString("ascii", 0, 4) === "RIFF"
        && buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
        return "webp";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "jpg";
    }
    return null;
}

function parseCssColor(css) {
    const value = String(css || "").trim();
    if (!value) return null;
    const hex = value.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
    if (hex) {
        return {
            r: Number.parseInt(hex[1].slice(0, 2), 16),
            g: Number.parseInt(hex[1].slice(2, 4), 16),
            b: Number.parseInt(hex[1].slice(4, 6), 16),
            alpha: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1
        };
    }
    const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
    if (rgba) {
        return {
            r: Number(rgba[1]),
            g: Number(rgba[2]),
            b: Number(rgba[3]),
            alpha: rgba[4] != null ? Number(rgba[4]) : 1
        };
    }
    return null;
}

/**
 * Compose le logo launcher officiel : fond (couleur ou bitmap) + foreground.
 * @param {{ backgroundColor?: string|null, backgroundRaster?: Buffer|null, foregroundRaster: Buffer }} layers
 * @returns {Promise<Buffer|null>}
 */
async function compositeAdaptiveIconLayers(layers = {}) {
    const fgRaw = layers.foregroundRaster;
    if (!Buffer.isBuffer(fgRaw) || !fgRaw.length) return null;
    if (!detectRasterKind(fgRaw)) return null;

    const bgColor = parseCssColor(layers.backgroundColor);
    const hasBgRaster = Buffer.isBuffer(layers.backgroundRaster)
        && layers.backgroundRaster.length
        && detectRasterKind(layers.backgroundRaster);
    const needsComposite = Boolean(hasBgRaster || bgColor);

    try {
        const fg = await sharp(fgRaw)
            .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();

        if (!needsComposite) {
            return fg;
        }

        let base;
        if (hasBgRaster) {
            base = sharp(layers.backgroundRaster)
                .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "fill" })
                .ensureAlpha();
        } else {
            base = sharp({
                create: {
                    width: OUTPUT_SIZE,
                    height: OUTPUT_SIZE,
                    channels: 4,
                    background: bgColor
                }
            });
        }

        return await base
            .composite([{ input: fg, gravity: "centre" }])
            .png()
            .toBuffer();
    } catch (err) {
        console.warn("[AdaptiveComposite]", err.message);
        return detectRasterKind(fgRaw) === "png" ? fgRaw : null;
    }
}

module.exports = {
    OUTPUT_SIZE,
    compositeAdaptiveIconLayers,
    detectRasterKind
};
