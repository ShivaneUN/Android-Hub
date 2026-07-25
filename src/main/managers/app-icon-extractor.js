const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { adbSerialArg } = require("../../shared/adb-serial-arg");
const { toAppIconUrl } = require("../../shared/app-icon-url");
const {
    MIN_ICON_FILE_BYTES
} = require("../../shared/app-icon-placeholder");
const { listBadgingXmlIconPaths, resolveApkAdaptiveLayers, resolveApkIconEntry } = require("./apk-aapt-icon");
const {
    rasterizeApkVectorEntry,
    resolveApkVectorEntry
} = require("./android-vector-raster");
const { compositeAdaptiveIconLayers } = require("./android-adaptive-composite");

const DEFAULT_COMMAND_TIMEOUT_MS = 20000;
/** Essayer densités d'abord (pas les splits ABI/langue). */
const MAX_APK_STREAM_ATTEMPTS = 2;
/** Pull local : dernier recours. */
const MAX_APK_PULL_ATTEMPTS = 2;

async function pathExists(targetPath) {
    try {
        await fs.promises.access(targetPath);
        return true;
    } catch (_err) {
        return false;
    }
}

async function isValidIconFileSizeAsync(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    try {
        const stat = await fs.promises.stat(filePath);
        return stat.size >= MIN_ICON_FILE_BYTES;
    } catch (_err) {
        return false;
    }
}

async function removePathIfExists(targetPath) {
    if (!(await pathExists(targetPath))) return;
    try {
        await fs.promises.unlink(targetPath);
    } catch (_err) {
        // noop
    }
}

async function removeTreeIfExists(targetPath) {
    if (!(await pathExists(targetPath))) return;
    try {
        await fs.promises.rm(targetPath, { recursive: true, force: true });
    } catch (_err) {
        // noop
    }
}

const ICON_ENTRY_PRIORITY = [
    /[/\\]res[/\\]mipmap-xxxhdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxhdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xhdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-hdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-mdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxxhdpi[^/\\]*[/\\]ic_logo_square(_main)?\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxhdpi[^/\\]*[/\\]ic_logo_square(_main)?\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxxhdpi[^/\\]*[/\\]ic_logo_round(_main)?\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxhdpi[^/\\]*[/\\]ic_logo_round(_main)?\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxxhdpi[^/\\]*[/\\]brand_dark(_round)?\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxhdpi[^/\\]*[/\\]brand_dark(_round)?\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxxhdpi[^/\\]*[/\\]ic_launcher_round\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxhdpi[^/\\]*[/\\]ic_launcher_round\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-[^/\\]+[/\\].*launcher.*\.(png|webp)$/i,
    /[/\\]res[/\\]drawable-[^/\\]+[/\\]ic_launcher.*\.(png|webp)$/i,
    /[/\\]res[/\\]drawable-[^/\\]+[/\\].*icon.*\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-[^/\\]+[/\\].*icon.*\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-[^/\\]+[/\\].*logo.*\.(png|webp)$/i
];

const DPI_FOLDER_PRIORITY = [
    "mipmap-xxxhdpi",
    "mipmap-xxhdpi",
    "mipmap-xhdpi",
    "mipmap-hdpi",
    "mipmap-mdpi",
    "mipmap-ldpi",
    "drawable-xxxhdpi",
    "drawable-xxhdpi",
    "drawable-xhdpi",
    "drawable-hdpi",
    "drawable-mdpi",
    "drawable-ldpi"
];

const ICON_NAME_HINT = /launcher|icon|logo|app_icon|ic_app|ic_logo|brand_dark/i;
const SKIP_ICON_NAME = /notification|status|stat_|mono|shortcut|adaptive_icon_foreground_vector|camo|cherry|manga|galaxy|mushroom|beanie|y2k|pirate|angry|circuit|holowaves|pastel|gaming|controller|blush|midnight|color_wave|matte_/i;
/** Foreground-only = pas le logo officiel (manque le fond adaptive). */
const FOREGROUND_ONLY_NAME = /foreground|adaptiveproduct_.*_foreground|_fg(\.|$)/i;

function execPromise(command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(String(stdout || "").trim());
        });
    });
}

function execWithTimeout(command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return Promise.race([
        execPromise(command, timeoutMs),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timeout ADB (${timeoutMs}ms)`)), timeoutMs);
        })
    ]);
}

function isIconResourcePath(filePath) {
    const norm = String(filePath || "").replace(/\\/g, "/");
    if (/\/assets\//i.test(norm)) return false;
    return /\/res\/(mipmap|drawable)/i.test(norm);
}

function hasLauncherOrIconName(filePath) {
    const baseName = path.basename(filePath);
    if (SKIP_ICON_NAME.test(baseName)) return false;
    return ICON_NAME_HINT.test(baseName);
}

function dpiScoreForPath(normPath) {
    const norm = String(normPath || "").replace(/\\/g, "/").toLowerCase();
    const index = DPI_FOLDER_PRIORITY.findIndex((folder) => norm.includes(`/res/${folder}`));
    return index === -1 ? 100 : index;
}

async function pickLargestCandidate(candidates = []) {
    if (!candidates.length) return null;
    let best = null;
    let bestSize = -1;
    let bestDpi = 999;
    for (const filePath of candidates) {
        try {
            const stat = await fs.promises.stat(filePath);
            const dpi = dpiScoreForPath(filePath);
            if (stat.size > bestSize || (stat.size === bestSize && dpi < bestDpi)) {
                best = filePath;
                bestSize = stat.size;
                bestDpi = dpi;
            }
        } catch (_err) {
            // skip
        }
    }
    return best;
}

async function isValidIconCandidate(filePath) {
    return isIconResourcePath(filePath) && await isValidIconFileSizeAsync(filePath);
}

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

async function isRasterIconBuffer(filePath) {
    try {
        const handle = await fs.promises.open(filePath, "r");
        try {
            const buffer = Buffer.alloc(16);
            const { bytesRead } = await handle.read(buffer, 0, 16, 0);
            return Boolean(detectRasterKind(buffer.subarray(0, bytesRead)));
        } finally {
            await handle.close();
        }
    } catch (_err) {
        return false;
    }
}

async function writeValidatedIconFile(sourcePath, outputPath) {
    if (!(await isValidIconFileSizeAsync(sourcePath))) return null;
    if (!(await isRasterIconBuffer(sourcePath))) return null;
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, outputPath);
    return (await isValidIconFileSizeAsync(outputPath)) ? outputPath : null;
}

async function walkFiles(dir, files = []) {
    if (!(await pathExists(dir))) return files;

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (/^assets$/i.test(entry.name)) continue;
            await walkFiles(fullPath, files);
        } else if (/\.(png|webp)$/i.test(entry.name)) {
            files.push(fullPath);
        }
    }

    return files;
}

async function walkXmlFiles(dir, files = []) {
    if (!(await pathExists(dir))) return files;

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkXmlFiles(fullPath, files);
        } else if (/\.xml$/i.test(entry.name)) {
            files.push(fullPath);
        }
    }

    return files;
}

async function collectValidIconCandidates(extractDir) {
    const files = await walkFiles(extractDir);
    const candidates = [];
    for (const filePath of files) {
        if (await isValidIconCandidate(filePath)) {
            candidates.push(filePath);
        }
    }
    return candidates;
}

async function findBestIconFile(extractDir) {
    const candidates = await collectValidIconCandidates(extractDir);
    if (!candidates.length) return null;

    const normalizedCandidates = candidates.map((filePath) => ({
        filePath,
        norm: filePath.replace(/\\/g, "/")
    }));

    for (const pattern of ICON_ENTRY_PRIORITY) {
        const match = normalizedCandidates.find(({ norm }) => pattern.test(norm));
        if (match) return match.filePath;
    }

    const namedCandidates = normalizedCandidates
        .filter(({ filePath, norm }) => hasLauncherOrIconName(filePath) && /\/res\/(mipmap|drawable)/i.test(norm))
        .map(({ filePath }) => filePath);
    const namedBest = await pickLargestCandidate(namedCandidates);
    if (namedBest) return namedBest;

    // Dernier recours : plus gros raster mipmap *nommé* (évite les thèmes Discord/camo/etc.).
    const mipmapCandidates = normalizedCandidates
        .filter(({ filePath, norm }) => {
            if (!/\/res\/mipmap-/i.test(norm)) return false;
            if (SKIP_ICON_NAME.test(path.basename(filePath))) return false;
            return hasLauncherOrIconName(filePath);
        })
        .map(({ filePath }) => filePath);
    const mipmapBest = await pickLargestCandidate(mipmapCandidates);
    if (mipmapBest) return mipmapBest;

    const drawableCandidates = normalizedCandidates
        .filter(({ filePath, norm }) => {
            if (!/\/res\/drawable-/i.test(norm)) return false;
            return hasLauncherOrIconName(filePath);
        })
        .map(({ filePath }) => filePath);
    return pickLargestCandidate(drawableCandidates);
}

function parseDrawableRef(xmlContent, tagName) {
    const pattern = new RegExp(`<${tagName}[^>]*android:drawable=["']@([^/"']+)/([^"']+)["']`, "i");
    const match = xmlContent.match(pattern);
    if (!match) return null;
    return { type: match[1], name: match[2] };
}

function parseAllDrawableRefs(xmlContent) {
    const refs = [];
    const pattern = /android:drawable=["']@([^/"']+)\/([^"']+)["']/gi;
    let match = pattern.exec(xmlContent);
    while (match) {
        refs.push({ type: match[1], name: match[2] });
        match = pattern.exec(xmlContent);
    }
    const srcPattern = /android:src=["']@([^/"']+)\/([^"']+)["']/gi;
    match = srcPattern.exec(xmlContent);
    while (match) {
        refs.push({ type: match[1], name: match[2] });
        match = srcPattern.exec(xmlContent);
    }
    return refs;
}

function findAdaptiveLauncherXmlPaths(xmlFiles) {
    const preferred = xmlFiles
        .filter((filePath) => {
            const norm = filePath.replace(/\\/g, "/");
            return /[/\\]res[/\\]mipmap-anydpi[^/\\]*[/\\]ic_launcher(_round)?\.xml$/i.test(norm);
        })
        .sort((a, b) => a.length - b.length);
    if (preferred.length) return preferred[0];

    return xmlFiles.find((filePath) => /ic_launcher(_round)?\.xml$/i.test(filePath)) || null;
}

async function findAdaptiveLauncherXml(extractDir) {
    const xmlFiles = await walkXmlFiles(extractDir);
    return findAdaptiveLauncherXmlPaths(xmlFiles);
}

async function resolveResourceXml(extractDir, resourceType, resourceName) {
    const resDir = path.join(extractDir, "res");
    if (!(await pathExists(resDir))) return null;

    const folderPrefix = resourceType.startsWith("drawable") ? "drawable" : "mipmap";
    const entries = await fs.promises.readdir(resDir, { withFileTypes: true });
    const folders = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(folderPrefix))
        .map((entry) => entry.name)
        .sort((a, b) => {
            const aAny = /anydpi/i.test(a) ? 0 : 1;
            const bAny = /anydpi/i.test(b) ? 0 : 1;
            return aAny - bAny || a.length - b.length;
        });

    for (const folder of folders) {
        const candidate = path.join(resDir, folder, `${resourceName}.xml`);
        if (await pathExists(candidate)) return candidate;
    }
    return null;
}

async function resolveResourceFile(extractDir, resourceType, resourceName) {
    const resDir = path.join(extractDir, "res");
    if (!(await pathExists(resDir))) return null;

    const folderPrefix = resourceType.startsWith("drawable") ? "drawable" : "mipmap";
    const orderedFolders = DPI_FOLDER_PRIORITY.filter((folder) => folder.startsWith(folderPrefix));

    for (const folder of orderedFolders) {
        const folderPath = path.join(resDir, folder);
        if (!(await pathExists(folderPath))) continue;
        for (const ext of ["png", "webp"]) {
            const candidate = path.join(folderPath, `${resourceName}.${ext}`);
            if (await isValidIconCandidate(candidate)) return candidate;
        }
    }

    const entries = await fs.promises.readdir(resDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith(folderPrefix)) continue;
        for (const ext of ["png", "webp"]) {
            const candidate = path.join(resDir, entry.name, `${resourceName}.${ext}`);
            if (await isValidIconCandidate(candidate)) return candidate;
        }
    }

    return null;
}

async function resolveDrawableToRaster(extractDir, resourceType, resourceName, depth = 0) {
    if (!resourceType || !resourceName || depth > 2) return null;

    const direct = await resolveResourceFile(extractDir, resourceType, resourceName);
    if (direct) return direct;

    const xmlPath = await resolveResourceXml(extractDir, resourceType, resourceName);
    if (!xmlPath) return null;

    let xmlContent = "";
    try {
        xmlContent = await fs.promises.readFile(xmlPath, "utf-8");
    } catch (_err) {
        return null;
    }

    for (const ref of parseAllDrawableRefs(xmlContent)) {
        const nested = await resolveDrawableToRaster(extractDir, ref.type, ref.name, depth + 1);
        if (nested) return nested;
    }
    return null;
}

async function findAdaptiveIconRaster(extractDir) {
    const xmlPath = await findAdaptiveLauncherXml(extractDir);
    if (!xmlPath) return null;

    let xmlContent = "";
    try {
        xmlContent = await fs.promises.readFile(xmlPath, "utf-8");
    } catch (_err) {
        return null;
    }

    const foreground = parseDrawableRef(xmlContent, "foreground");
    const background = parseDrawableRef(xmlContent, "background");
    const monochrome = parseDrawableRef(xmlContent, "monochrome");

    const orderedRefs = [foreground, background, monochrome].filter(Boolean);
    for (const ref of orderedRefs) {
        const resolved = await resolveDrawableToRaster(extractDir, ref.type, ref.name);
        if (resolved) return resolved;
    }

    // Refs imbriqués (inset / layer-list) dans le XML adaptive.
    for (const ref of parseAllDrawableRefs(xmlContent)) {
        const resolved = await resolveDrawableToRaster(extractDir, ref.type, ref.name);
        if (resolved) return resolved;
    }

    return null;
}

function findBestZipIconEntry(entryNames = [], entrySizes = null) {
    if (!entryNames.length) return null;

    const normalizedEntries = entryNames.map((name, index) => ({
        name,
        norm: String(name || "").replace(/\\/g, "/"),
        size: Array.isArray(entrySizes) ? Number(entrySizes[index]) || 0 : 0
    }));

    for (const pattern of ICON_ENTRY_PRIORITY) {
        const hit = normalizedEntries.find((entry) => pattern.test(entry.norm));
        if (hit) return hit.name;
    }

    const named = normalizedEntries.filter((entry) => (
        /\/res\/(mipmap|drawable)/i.test(entry.norm)
        && ICON_NAME_HINT.test(entry.norm)
        && !SKIP_ICON_NAME.test(path.basename(entry.norm))
        && !FOREGROUND_ONLY_NAME.test(path.basename(entry.norm))
        && /\.(png|webp)$/i.test(entry.norm)
    ));
    if (named.length) {
        named.sort((a, b) => (b.size - a.size) || (dpiScoreForPath(a.norm) - dpiScoreForPath(b.norm)));
        return named[0].name;
    }

    const mipmaps = normalizedEntries.filter((entry) => (
        /\/res\/mipmap-/i.test(entry.norm)
        && ICON_NAME_HINT.test(entry.norm)
        && !SKIP_ICON_NAME.test(path.basename(entry.norm))
        && !FOREGROUND_ONLY_NAME.test(path.basename(entry.norm))
        && /\.(png|webp)$/i.test(entry.norm)
    ));
    if (!mipmaps.length) return null;
    mipmaps.sort((a, b) => (b.size - a.size) || (dpiScoreForPath(a.norm) - dpiScoreForPath(b.norm)));
    return mipmaps[0].name;
}

function parseUnzipListing(stdout) {
    const entries = [];
    for (const line of String(stdout || "").split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
        if (match) {
            entries.push({
                size: Number(match[1]) || 0,
                name: match[2].trim()
            });
        }
    }
    return entries;
}

function shellQuote(value) {
    return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

/** Serial brut pour spawn([...]) — ne pas re-quoté (sinon adb cherche '"serial"'). */
function adbSerialSpawnArg(serial) {
    return String(serial ?? "");
}

function streamExecOutToBuffer(adbPath, serial, shellCommand, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(
            adbPath,
            ["-s", adbSerialSpawnArg(serial), "exec-out", "sh", "-c", shellCommand],
            { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
        );

        const chunks = [];
        let stderr = "";
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`Timeout stream (${timeoutMs}ms)`));
        }, timeoutMs);

        proc.stdout.on("data", (chunk) => chunks.push(chunk));
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `adb exec-out exit ${code}`));
                return;
            }
            resolve(Buffer.concat(chunks));
        });
    });
}

/** ZIP "store" minimal (sans compression) pour aapt2 slim. */
async function writeStoreZip(zipPath, entries = []) {
    const { crc32 } = require("zlib");
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const name = String(entry.name || "").replace(/\\/g, "/");
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || []);
        const nameBuf = Buffer.from(name, "utf8");
        const crc = crc32(data) >>> 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8); // store
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);

        localParts.push(local, nameBuf, data);
        centralParts.push(central, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, buf) => sum + buf.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
    await fs.promises.writeFile(zipPath, Buffer.concat([...localParts, ...centralParts, end]));
}

function streamExecOutToFile(adbPath, serial, shellCommand, outputPath, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(
            adbPath,
            ["-s", adbSerialSpawnArg(serial), "exec-out", "sh", "-c", shellCommand],
            { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
        );

        const chunks = [];
        let stderr = "";
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`Timeout stream icone (${timeoutMs}ms)`));
        }, timeoutMs);

        proc.stdout.on("data", (chunk) => chunks.push(chunk));
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `adb exec-out exit ${code}`));
                return;
            }

            void (async () => {
                try {
                    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
                    const payload = Buffer.concat(chunks);
                    if (!detectRasterKind(payload) || payload.length < MIN_ICON_FILE_BYTES) {
                        await removePathIfExists(outputPath);
                        reject(new Error("Icon stream invalide"));
                        return;
                    }
                    await fs.promises.writeFile(outputPath, payload);
                    if (await isValidIconFileSizeAsync(outputPath)) {
                        resolve(outputPath);
                        return;
                    }
                    await removePathIfExists(outputPath);
                    reject(new Error("Icon stream invalide"));
                } catch (err) {
                    reject(err);
                }
            })();
        });
    });
}

function sanitizeFileSegment(value) {
    return String(value || "unknown")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 120);
}

function sortApkPaths(apkPaths = []) {
    const unique = [...new Set(apkPaths.filter(Boolean))];
    const rank = (apkPath) => {
        const name = String(apkPath || "").toLowerCase();
        // base d'abord : aapt2 a besoin du manifeste / resources complets.
        if (/base\.apk$/i.test(name)) return 0;
        if (/split_config\.xxxhdpi\.apk$/i.test(name)) return 1;
        if (/split_config\.xxhdpi\.apk$/i.test(name)) return 2;
        if (/split_config\.xhdpi\.apk$/i.test(name)) return 3;
        if (/split_config\.hdpi\.apk$/i.test(name)) return 4;
        if (/split_config\.(arm|x86|armeabi)/i.test(name)) return 8;
        if (/split_config\.[a-z]{2}/i.test(name)) return 7;
        return 5;
    };
    return unique.sort((a, b) => {
        const diff = rank(a) - rank(b);
        if (diff !== 0) return diff;
        return a.localeCompare(b);
    });
}

function sortApkPathsForStream(apkPaths = []) {
    const unique = [...new Set(apkPaths.filter(Boolean))];
    const rank = (apkPath) => {
        const name = String(apkPath || "").toLowerCase();
        // Stream : privilégier les splits densité (rasters) avant le gros base.apk.
        if (/split_config\.xxxhdpi\.apk$/i.test(name)) return 0;
        if (/split_config\.xxhdpi\.apk$/i.test(name)) return 1;
        if (/split_config\.xhdpi\.apk$/i.test(name)) return 2;
        if (/split_config\.hdpi\.apk$/i.test(name)) return 3;
        if (/base\.apk$/i.test(name)) return 4;
        return 6;
    };
    return unique
        .filter((apkPath) => isLikelyIconBearingApk(apkPath))
        .sort((a, b) => {
            const diff = rank(a) - rank(b);
            if (diff !== 0) return diff;
            return a.localeCompare(b);
        });
}

/** Ignore ABI / langue / feature splits — quasiment jamais l'icône launcher. */
function isLikelyIconBearingApk(apkPath) {
    const name = path.basename(String(apkPath || "")).toLowerCase();
    if (/^base\.apk$/i.test(name)) return true;
    if (/^split_config\.(xxxhdpi|xxhdpi|xhdpi|hdpi|mdpi|ldpi)\.apk$/i.test(name)) return true;
    return false;
}

class AppIconExtractor {
    constructor(adbPath) {
        this.adbPath = adbPath;
    }

    async getAllApkPathsOnDevice(serial, packageName, userId = null) {
        const userArg = Number.isInteger(userId) ? ` --user ${userId}` : "";
        const stdout = await execWithTimeout(
            `"${this.adbPath}" -s ${adbSerialArg(serial)} shell pm path${userArg} ${packageName}`
        );

        const apkPaths = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const match = line.match(/^package:(.+)$/);
                return match ? match[1].trim() : null;
            })
            .filter(Boolean);

        return sortApkPaths(apkPaths);
    }

    async pullApk(serial, remoteApkPath, localApkPath) {
        await fs.promises.mkdir(path.dirname(localApkPath), { recursive: true });
        await execWithTimeout(
            `"${this.adbPath}" -s ${adbSerialArg(serial)} pull "${remoteApkPath}" "${localApkPath}"`,
            45000
        );

        if (!(await pathExists(localApkPath))) {
            throw new Error("APK introuvable après pull ADB");
        }
        const stat = await fs.promises.stat(localApkPath);
        if (stat.size === 0) {
            throw new Error("APK introuvable après pull ADB");
        }
    }

    async extractIconFromApk(apkPath, outputPath) {
        const extractDir = `${outputPath}.extract`;
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await removeTreeIfExists(extractDir);
        await fs.promises.mkdir(extractDir, { recursive: true });

        try {
            // 1) Adaptive officiel = background + foreground (pas le foreground seul).
            try {
                const layers = await resolveApkAdaptiveLayers(apkPath);
                if (layers?.sibling || layers?.foregroundPath) {
                    const entry = layers.sibling || layers.foregroundPath;
                    if (layers.sibling || (!layers.backgroundPath && !layers.backgroundColor)) {
                        const quotedEntry = String(entry).replace(/\\/g, "/");
                        await execWithTimeout(
                            `tar -xf "${apkPath}" -C "${extractDir}" "${quotedEntry}"`,
                            30000
                        );
                        const extractedPath = path.join(extractDir, ...quotedEntry.split("/"));
                        const saved = await writeValidatedIconFile(extractedPath, outputPath);
                        if (saved) return saved;
                    } else {
                        const toExtract = [...new Set(
                            [layers.foregroundPath, layers.backgroundPath].filter(Boolean)
                        )];
                        for (const zipEntry of toExtract) {
                            const quotedEntry = String(zipEntry).replace(/\\/g, "/");
                            await execWithTimeout(
                                `tar -xf "${apkPath}" -C "${extractDir}" "${quotedEntry}"`,
                                30000
                            );
                        }
                        const fgPath = path.join(extractDir, ...String(layers.foregroundPath).split("/"));
                        const bgPath = layers.backgroundPath
                            ? path.join(extractDir, ...String(layers.backgroundPath).split("/"))
                            : null;
                        const fgBuf = await fs.promises.readFile(fgPath);
                        const bgBuf = bgPath && (await pathExists(bgPath))
                            ? await fs.promises.readFile(bgPath)
                            : null;
                        const composed = await compositeAdaptiveIconLayers({
                            backgroundColor: layers.backgroundColor,
                            backgroundRaster: bgBuf,
                            foregroundRaster: fgBuf
                        });
                        if (composed && composed.length >= MIN_ICON_FILE_BYTES) {
                            await fs.promises.writeFile(outputPath, composed);
                            if (await isValidIconFileSizeAsync(outputPath)) return outputPath;
                        }
                    }
                }
            } catch (err) {
                console.warn("[AppIconExtractor] adaptive composite:", err.message);
            }

            // 2) aapt2 single raster (legacy / non-adaptive).
            try {
                const aaptEntry = await resolveApkIconEntry(apkPath);
                if (aaptEntry) {
                    const quotedEntry = String(aaptEntry).replace(/\\/g, "/");
                    await execWithTimeout(
                        `tar -xf "${apkPath}" -C "${extractDir}" "${quotedEntry}"`,
                        30000
                    );
                    const extractedPath = path.join(extractDir, ...quotedEntry.split("/"));
                    const saved = await writeValidatedIconFile(extractedPath, outputPath);
                    if (saved) return saved;
                }
            } catch (err) {
                console.warn("[AppIconExtractor] aapt2 icon:", err.message);
            }

            // 3) VectorDrawable / adaptive→vector (Notes, Word, …) → PNG via resvg.
            try {
                const vectorEntry = await resolveApkVectorEntry(apkPath);
                if (vectorEntry) {
                    const pngBuffer = await rasterizeApkVectorEntry(apkPath, vectorEntry);
                    if (pngBuffer && pngBuffer.length >= MIN_ICON_FILE_BYTES) {
                        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
                        await fs.promises.writeFile(outputPath, pngBuffer);
                        if (await isValidIconFileSizeAsync(outputPath)) return outputPath;
                    }
                }
            } catch (err) {
                console.warn("[AppIconExtractor] vector icon:", err.message);
            }

            await removeTreeIfExists(extractDir);
            await fs.promises.mkdir(extractDir, { recursive: true });
            await execWithTimeout(`tar -xf "${apkPath}" -C "${extractDir}"`, 30000);

            // Adaptive d'abord (apps modernes), puis heuristique legacy / plus gros mipmap.
            const adaptiveIcon = await findAdaptiveIconRaster(extractDir);
            if (adaptiveIcon) {
                const savedAdaptive = await writeValidatedIconFile(adaptiveIcon, outputPath);
                if (savedAdaptive) return savedAdaptive;
            }

            const legacyIcon = await findBestIconFile(extractDir);
            if (legacyIcon) {
                return writeValidatedIconFile(legacyIcon, outputPath);
            }

            return null;
        } finally {
            await removeTreeIfExists(extractDir);
            await removePathIfExists(apkPath);
        }
    }

    buildIconFilePath(cacheRoot, deviceId, packageName, userId = null) {
        const deviceSegment = sanitizeFileSegment(deviceId);
        const packageSegment = sanitizeFileSegment(packageName);
        const userSegment = Number.isInteger(userId) ? `@u${userId}` : "";
        return path.join(cacheRoot, deviceSegment, `${packageSegment}${userSegment}.png`);
    }

    async toIconUrl(iconPath) {
        if (!iconPath || !(await isValidIconFileSizeAsync(iconPath))) return null;
        return toAppIconUrl(iconPath);
    }

    async listZipIconEntriesOnDevice(serial, remoteApkPath) {
        try {
            // grep on-device : listing plus léger (évite de ramener tout le zip -l).
            const stdout = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell "unzip -l ${shellQuote(remoteApkPath)} 2>/dev/null | grep -E 'res/(mipmap|drawable)' || true"`,
                6000
            );
            return parseUnzipListing(stdout).filter((entry) => {
                const norm = String(entry.name || "").replace(/\\/g, "/");
                return /\/res\/(mipmap|drawable)/i.test(norm) && /\.(png|webp)$/i.test(norm);
            });
        } catch (_err) {
            return [];
        }
    }

    async tryExtractIconFromDeviceZip(serial, remoteApkPath, outputPath) {
        const zipEntries = await this.listZipIconEntriesOnDevice(serial, remoteApkPath);
        const names = zipEntries.map((entry) => entry.name);
        const sizes = zipEntries.map((entry) => entry.size);
        const bestEntry = findBestZipIconEntry(names, sizes);
        if (!bestEntry) return null;

        const shellCommand = `unzip -p ${shellQuote(remoteApkPath)} ${shellQuote(bestEntry)}`;
        try {
            return await streamExecOutToFile(
                this.adbPath,
                serial,
                shellCommand,
                outputPath,
                12000
            );
        } catch (err) {
            console.warn(`[AppIconExtractor] stream zip ${path.basename(remoteApkPath)}:`, err.message);
            return null;
        }
    }

    /**
     * Rapide : stream manifest + resources.arsc (+ XML adaptive) → aapt2 → stream seule l'icône.
     * Évite le pull APK complet (souvent 20–100+ Mo). Vecteurs purs → null (fallback pull).
     */
    async tryExtractIconSlimRemote(serial, remoteApkPath, outputPath, candidateApks = []) {
        const slimPath = `${outputPath}.slim.apk`;
        const quotedApk = shellQuote(remoteApkPath);
        const apksForIcon = [...new Set([remoteApkPath, ...candidateApks].filter(Boolean))];

        try {
            const [manifestBuf, arscBuf] = await Promise.all([
                streamExecOutToBuffer(
                    this.adbPath,
                    serial,
                    `unzip -p ${quotedApk} AndroidManifest.xml`,
                    15000
                ),
                streamExecOutToBuffer(
                    this.adbPath,
                    serial,
                    `unzip -p ${quotedApk} resources.arsc`,
                    20000
                )
            ]);

            if (!manifestBuf?.length || !arscBuf?.length) return null;

            const slimEntries = [
                { name: "AndroidManifest.xml", data: manifestBuf },
                { name: "resources.arsc", data: arscBuf }
            ];
            await writeStoreZip(slimPath, slimEntries);

            // Adaptive icons : badging pointe vers un XML — l'inclure pour xmltree / resolve.
            const xmlIcons = await listBadgingXmlIconPaths(slimPath);
            if (xmlIcons.length) {
                const xmlParts = await Promise.all(
                    xmlIcons.map(async (xmlEntry) => {
                        try {
                            const data = await streamExecOutToBuffer(
                                this.adbPath,
                                serial,
                                `unzip -p ${quotedApk} ${shellQuote(xmlEntry)}`,
                                12000
                            );
                            return data?.length ? { name: xmlEntry, data } : null;
                        } catch (_err) {
                            return null;
                        }
                    })
                );
                for (const part of xmlParts) {
                    if (part) slimEntries.push(part);
                }
                if (slimEntries.length > 2) {
                    await writeStoreZip(slimPath, slimEntries);
                }
            }

            const layers = await resolveApkAdaptiveLayers(slimPath);
            if (layers?.sibling || layers?.foregroundPath) {
                const fgEntry = layers.sibling || layers.foregroundPath;
                const fgBuf = await this.streamRasterFromApks(serial, apksForIcon, fgEntry);
                if (fgBuf) {
                    let bgBuf = null;
                    if (layers.backgroundPath && !layers.sibling) {
                        // Fonds unis souvent < 512 o (PNG 1×1) — ne pas appliquer MIN_ICON.
                        bgBuf = await this.streamRasterFromApks(
                            serial,
                            apksForIcon,
                            layers.backgroundPath,
                            16
                        );
                    }
                    const composed = await compositeAdaptiveIconLayers({
                        backgroundColor: layers.sibling ? null : layers.backgroundColor,
                        backgroundRaster: layers.sibling ? null : bgBuf,
                        foregroundRaster: fgBuf
                    });
                    if (composed && composed.length >= MIN_ICON_FILE_BYTES) {
                        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
                        await fs.promises.writeFile(outputPath, composed);
                        if (await isValidIconFileSizeAsync(outputPath)) return outputPath;
                    }
                }
            }

            const entry = await resolveApkIconEntry(slimPath);
            if (!entry) return null;
            // Encore du XML (vecteur imbriqué) → besoin pull + resvg.
            if (/\.xml$/i.test(entry)) return null;

            let iconBuf = null;
            for (const apkPath of apksForIcon) {
                try {
                    const buf = await streamExecOutToBuffer(
                        this.adbPath,
                        serial,
                        `unzip -p ${shellQuote(apkPath)} ${shellQuote(entry)}`,
                        15000
                    );
                    if (detectRasterKind(buf) && buf.length >= MIN_ICON_FILE_BYTES) {
                        iconBuf = buf;
                        break;
                    }
                } catch (_err) {
                    // Fichier parfois dans un split densité uniquement.
                }
            }
            if (!iconBuf) return null;

            await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.promises.writeFile(outputPath, iconBuf);
            return (await isValidIconFileSizeAsync(outputPath)) ? outputPath : null;
        } catch (err) {
            console.warn(`[AppIconExtractor] slim ${path.basename(remoteApkPath)}:`, err.message);
            return null;
        } finally {
            await removePathIfExists(slimPath);
        }
    }

    async streamRasterFromApks(serial, apkPaths, entry, minBytes = MIN_ICON_FILE_BYTES) {
        if (!entry) return null;
        for (const apkPath of apkPaths) {
            try {
                const buf = await streamExecOutToBuffer(
                    this.adbPath,
                    serial,
                    `unzip -p ${shellQuote(apkPath)} ${shellQuote(entry)}`,
                    15000
                );
                if (detectRasterKind(buf) && buf.length >= minBytes) {
                    return buf;
                }
            } catch (_err) {
                // split manquant
            }
        }
        return null;
    }

    async extractIcon(serial, packageName, outputPath, userId = null) {
        const remoteApkPaths = await this.getAllApkPathsOnDevice(serial, packageName, userId);
        if (!remoteApkPaths.length) return null;

        const iconApks = sortApkPaths(remoteApkPaths).filter((apkPath) => isLikelyIconBearingApk(apkPath));
        const streamApks = sortApkPathsForStream(remoteApkPaths).slice(0, MAX_APK_STREAM_ATTEMPTS);
        // Slim : base.apk seulement (arsc + manifeste complets) ; 1 tentative suffit.
        const slimApks = (iconApks.length ? iconApks : sortApkPaths(remoteApkPaths))
            .filter((apkPath) => /base\.apk$/i.test(apkPath))
            .slice(0, 1);
        if (!slimApks.length) {
            slimApks.push(...(iconApks.length ? iconApks : sortApkPaths(remoteApkPaths)).slice(0, 1));
        }

        // Pass 1 — mipmap classiques via unzip on-device (Dofus, Discord, Canva…).
        // Parallel sur 2 densités : le 1er hit gagne (chemins temp distincts).
        if (streamApks.length) {
            const streamHits = await Promise.all(
                streamApks.map(async (remoteApkPath, index) => {
                    const tempOut = `${outputPath}.stream${index}`;
                    try {
                        const hit = await this.tryExtractIconFromDeviceZip(
                            serial,
                            remoteApkPath,
                            tempOut
                        );
                        return hit || null;
                    } catch (_err) {
                        await removePathIfExists(tempOut);
                        return null;
                    }
                })
            );
            const winner = streamHits.find(Boolean);
            for (const hit of streamHits) {
                if (hit && hit !== winner) await removePathIfExists(hit);
            }
            if (winner) {
                if (winner !== outputPath) {
                    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
                    await fs.promises.copyFile(winner, outputPath);
                    await removePathIfExists(winner);
                }
                if (await isValidIconFileSizeAsync(outputPath)) return outputPath;
            }
        }

        // Pass 2 — slim aapt2 distant (Google/Netflix obfusqués) sans pull APK entier.
        for (const remoteApkPath of slimApks) {
            const slimPath = await this.tryExtractIconSlimRemote(
                serial,
                remoteApkPath,
                outputPath,
                iconApks
            );
            if (slimPath) return slimPath;
        }

        // Pass 3 — pull complet (vecteurs Notes/Word, échecs slim).
        const pullPaths = (iconApks.length ? iconApks : sortApkPaths(remoteApkPaths))
            .slice(0, MAX_APK_PULL_ATTEMPTS);
        for (let index = 0; index < pullPaths.length; index += 1) {
            const remoteApkPath = pullPaths[index];
            const tempApkPath = `${outputPath}.apk${index}`;
            try {
                await this.pullApk(serial, remoteApkPath, tempApkPath);
                const savedPath = await this.extractIconFromApk(tempApkPath, outputPath);
                if (savedPath) return savedPath;
            } catch (err) {
                console.warn(`[AppIconExtractor] ${packageName} (${path.basename(remoteApkPath)}):`, err.message);
            } finally {
                await removePathIfExists(tempApkPath);
            }
        }

        return null;
    }
}

module.exports = {
    AppIconExtractor,
    findBestIconFile,
    findBestZipIconEntry,
    findAdaptiveIconRaster,
    sortApkPaths,
    sortApkPathsForStream,
    MIN_ICON_FILE_BYTES,
    isValidIconCandidate
};
