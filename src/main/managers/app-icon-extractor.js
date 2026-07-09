const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { adbSerialArg } = require("../../shared/adb-serial-arg");
const { toAppIconUrl } = require("../../shared/app-icon-url");
const {
    MIN_ICON_FILE_BYTES,
    isValidIconFileSize
} = require("../../shared/app-icon-placeholder");

const DEFAULT_COMMAND_TIMEOUT_MS = 20000;
const MAX_APK_PULL_ATTEMPTS = 2;

const ICON_ENTRY_PRIORITY = [
    /[/\\]res[/\\]mipmap-xxxhdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xxhdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-xhdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-hdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-mdpi[^/\\]*[/\\]ic_launcher\.(png|webp)$/i,
    /[/\\]res[/\\]mipmap-[^/\\]+[/\\].*launcher.*\.(png|webp)$/i,
    /[/\\]res[/\\]drawable-[^/\\]+[/\\]ic_launcher.*\.(png|webp)$/i,
    /[/\\]res[/\\]drawable-[^/\\]+[/\\].*icon.*\.(png|webp)$/i
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
    const baseName = path.basename(filePath).toLowerCase();
    return baseName.includes("launcher") || baseName.includes("icon");
}

function isValidIconCandidate(filePath) {
    return isIconResourcePath(filePath) && isValidIconFileSize(filePath);
}

function walkFiles(dir, files = []) {
    if (!fs.existsSync(dir)) return files;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (/^assets$/i.test(entry.name)) continue;
            walkFiles(fullPath, files);
        } else if (/\.(png|webp)$/i.test(entry.name)) {
            files.push(fullPath);
        }
    }

    return files;
}

function walkXmlFiles(dir, files = []) {
    if (!fs.existsSync(dir)) return files;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkXmlFiles(fullPath, files);
        } else if (/\.xml$/i.test(entry.name)) {
            files.push(fullPath);
        }
    }

    return files;
}

function collectValidIconCandidates(extractDir) {
    return walkFiles(extractDir).filter(isValidIconCandidate);
}

function findBestIconFile(extractDir) {
    const candidates = collectValidIconCandidates(extractDir);
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
        .map(({ filePath }) => filePath)
        .sort((a, b) => b.length - a.length);
    if (namedCandidates.length) return namedCandidates[0];

    const mipmapCandidates = normalizedCandidates
        .filter(({ norm }) => /\/res\/mipmap-/i.test(norm) && hasLauncherOrIconName(norm))
        .map(({ filePath }) => filePath)
        .sort((a, b) => b.length - a.length);
    if (mipmapCandidates.length) return mipmapCandidates[0];

    const drawableCandidates = normalizedCandidates
        .filter(({ norm }) => /\/res\/drawable-/i.test(norm) && hasLauncherOrIconName(norm))
        .map(({ filePath }) => filePath)
        .sort((a, b) => b.length - a.length);
    if (drawableCandidates.length) return drawableCandidates[0];

    return null;
}

function parseDrawableRef(xmlContent, tagName) {
    const pattern = new RegExp(`<${tagName}[^>]*android:drawable=["']@([^/"']+)/([^"']+)["']`, "i");
    const match = xmlContent.match(pattern);
    if (!match) return null;
    return { type: match[1], name: match[2] };
}

function findAdaptiveLauncherXml(extractDir) {
    const xmlFiles = walkXmlFiles(extractDir);
    const launcherXml = xmlFiles
        .filter((filePath) => /[/\\]res[/\\]mipmap-anydpi[^/\\]*[/\\]ic_launcher\.xml$/i.test(filePath.replace(/\\/g, "/")))
        .sort((a, b) => a.length - b.length);
    if (launcherXml.length) return launcherXml[0];

    return xmlFiles.find((filePath) => /ic_launcher\.xml$/i.test(filePath)) || null;
}

function resolveResourceFile(extractDir, resourceType, resourceName) {
    const resDir = path.join(extractDir, "res");
    if (!fs.existsSync(resDir)) return null;

    const folderPrefix = resourceType.startsWith("drawable") ? "drawable" : "mipmap";
    const orderedFolders = DPI_FOLDER_PRIORITY.filter((folder) => folder.startsWith(folderPrefix));

    for (const folder of orderedFolders) {
        const folderPath = path.join(resDir, folder);
        if (!fs.existsSync(folderPath)) continue;
        for (const ext of ["png", "webp"]) {
            const candidate = path.join(folderPath, `${resourceName}.${ext}`);
            if (isValidIconCandidate(candidate)) return candidate;
        }
    }

    for (const entry of fs.readdirSync(resDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith(folderPrefix)) continue;
        for (const ext of ["png", "webp"]) {
            const candidate = path.join(resDir, entry.name, `${resourceName}.${ext}`);
            if (isValidIconCandidate(candidate)) return candidate;
        }
    }

    return null;
}

function findAdaptiveIconRaster(extractDir) {
    const xmlPath = findAdaptiveLauncherXml(extractDir);
    if (!xmlPath) return null;

    let xmlContent = "";
    try {
        xmlContent = fs.readFileSync(xmlPath, "utf-8");
    } catch (_err) {
        return null;
    }

    const foreground = parseDrawableRef(xmlContent, "foreground");
    const background = parseDrawableRef(xmlContent, "background");

    const foregroundFile = foreground
        ? resolveResourceFile(extractDir, foreground.type, foreground.name)
        : null;
    const backgroundFile = background
        ? resolveResourceFile(extractDir, background.type, background.name)
        : null;

    return foregroundFile || backgroundFile || null;
}

function findBestZipIconEntry(entryNames = []) {
    if (!entryNames.length) return null;

    const normalizedEntries = entryNames.map((name) => ({
        name,
        norm: String(name || "").replace(/\\/g, "/")
    }));

    for (const pattern of ICON_ENTRY_PRIORITY) {
        const hit = normalizedEntries.find((entry) => pattern.test(entry.norm));
        if (hit) return hit.name;
    }

    const fallback = normalizedEntries.find((entry) => (
        /\/res\/(mipmap|drawable)/i.test(entry.norm)
        && /launcher|icon/i.test(entry.norm)
        && /\.(png|webp)$/i.test(entry.norm)
    ));
    return fallback?.name || null;
}

function parseUnzipListing(stdout) {
    const entries = [];
    for (const line of String(stdout || "").split(/\r?\n/)) {
        const match = line.match(/^\s*\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
        if (match) {
            entries.push(match[1].trim());
        }
    }
    return entries;
}

function shellQuote(value) {
    return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function streamExecOutToFile(adbPath, serial, shellCommand, outputPath, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        const proc = spawn(
            adbPath,
            ["-s", adbSerialArg(serial), "exec-out", "sh", "-c", shellCommand],
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

            try {
                fs.writeFileSync(outputPath, Buffer.concat(chunks));
                if (isValidIconFileSize(outputPath)) {
                    resolve(outputPath);
                    return;
                }
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
                reject(new Error("Icon stream invalide"));
            } catch (err) {
                reject(err);
            }
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
    return unique.sort((a, b) => {
        const aBase = /base\.apk$/i.test(a) ? 0 : 1;
        const bBase = /base\.apk$/i.test(b) ? 0 : 1;
        if (aBase !== bBase) return aBase - bBase;
        return a.localeCompare(b);
    });
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
        fs.mkdirSync(path.dirname(localApkPath), { recursive: true });
        await execWithTimeout(
            `"${this.adbPath}" -s ${adbSerialArg(serial)} pull "${remoteApkPath}" "${localApkPath}"`,
            45000
        );

        if (!fs.existsSync(localApkPath) || fs.statSync(localApkPath).size === 0) {
            throw new Error("APK introuvable après pull ADB");
        }
    }

    async extractIconFromApk(apkPath, outputPath) {
        const extractDir = `${outputPath}.extract`;
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        if (fs.existsSync(extractDir)) {
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
        fs.mkdirSync(extractDir, { recursive: true });

        try {
            await execWithTimeout(`tar -xf "${apkPath}" -C "${extractDir}"`, 30000);

            const legacyIcon = findBestIconFile(extractDir);
            if (legacyIcon) {
                fs.copyFileSync(legacyIcon, outputPath);
                return isValidIconFileSize(outputPath) ? outputPath : null;
            }

            const adaptiveIcon = findAdaptiveIconRaster(extractDir);
            if (adaptiveIcon) {
                fs.copyFileSync(adaptiveIcon, outputPath);
                return isValidIconFileSize(outputPath) ? outputPath : null;
            }

            return null;
        } finally {
            fs.rmSync(extractDir, { recursive: true, force: true });
            if (fs.existsSync(apkPath)) {
                fs.unlinkSync(apkPath);
            }
        }
    }

    buildIconFilePath(cacheRoot, deviceId, packageName, userId = null) {
        const deviceSegment = sanitizeFileSegment(deviceId);
        const packageSegment = sanitizeFileSegment(packageName);
        const userSegment = Number.isInteger(userId) ? `@u${userId}` : "";
        return path.join(cacheRoot, deviceSegment, `${packageSegment}${userSegment}.png`);
    }

    toIconUrl(iconPath) {
        if (!iconPath || !isValidIconFileSize(iconPath)) return null;
        return toAppIconUrl(iconPath);
    }

    async listZipIconEntriesOnDevice(serial, remoteApkPath) {
        try {
            const stdout = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell unzip -l ${shellQuote(remoteApkPath)} 2>/dev/null`,
                12000
            );
            return parseUnzipListing(stdout).filter((entry) => (
                /\/res\/(mipmap|drawable)/i.test(entry.replace(/\\/g, "/"))
                && /\.(png|webp)$/i.test(entry)
            ));
        } catch (_err) {
            return [];
        }
    }

    async tryExtractIconFromDeviceZip(serial, remoteApkPath, outputPath) {
        const zipEntries = await this.listZipIconEntriesOnDevice(serial, remoteApkPath);
        const bestEntry = findBestZipIconEntry(zipEntries);
        if (!bestEntry) return null;

        const shellCommand = `unzip -p ${shellQuote(remoteApkPath)} ${shellQuote(bestEntry)}`;
        try {
            return await streamExecOutToFile(
                this.adbPath,
                serial,
                shellCommand,
                outputPath,
                15000
            );
        } catch (err) {
            console.warn(`[AppIconExtractor] stream zip ${path.basename(remoteApkPath)}:`, err.message);
            return null;
        }
    }

    async extractIcon(serial, packageName, outputPath, userId = null) {
        const remoteApkPaths = await this.getAllApkPathsOnDevice(serial, packageName, userId);
        if (!remoteApkPaths.length) return null;

        const attemptCount = Math.min(remoteApkPaths.length, MAX_APK_PULL_ATTEMPTS);
        for (let index = 0; index < attemptCount; index += 1) {
            const remoteApkPath = remoteApkPaths[index];
            const streamedPath = await this.tryExtractIconFromDeviceZip(serial, remoteApkPath, outputPath);
            if (streamedPath) return streamedPath;

            const tempApkPath = `${outputPath}.apk${index}`;
            try {
                await this.pullApk(serial, remoteApkPath, tempApkPath);
                const savedPath = await this.extractIconFromApk(tempApkPath, outputPath);
                if (savedPath) return savedPath;
            } catch (err) {
                console.warn(`[AppIconExtractor] ${packageName} (${path.basename(remoteApkPath)}):`, err.message);
            } finally {
                if (fs.existsSync(tempApkPath)) {
                    try {
                        fs.unlinkSync(tempApkPath);
                    } catch (_err) {
                        // noop
                    }
                }
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
    MIN_ICON_FILE_BYTES,
    isValidIconCandidate
};
