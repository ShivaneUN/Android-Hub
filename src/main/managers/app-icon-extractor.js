const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { pathToFileURL } = require("url");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

const DEFAULT_COMMAND_TIMEOUT_MS = 20000;

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

function walkFiles(dir, files = []) {
    if (!fs.existsSync(dir)) return files;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(fullPath, files);
        } else if (/\.(png|webp)$/i.test(entry.name)) {
            files.push(fullPath);
        }
    }

    return files;
}

function findBestIconFile(extractDir) {
    const candidates = walkFiles(extractDir);
    if (!candidates.length) return null;

    for (const pattern of ICON_ENTRY_PRIORITY) {
        const match = candidates.find((filePath) => pattern.test(filePath.replace(/\\/g, "/")));
        if (match) return match;
    }

    const mipmapCandidates = candidates
        .filter((filePath) => /[/\\]res[/\\]mipmap-/i.test(filePath))
        .sort((a, b) => b.length - a.length);
    if (mipmapCandidates.length) return mipmapCandidates[0];

    return candidates[0];
}

function sanitizeFileSegment(value) {
    return String(value || "unknown")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 120);
}

class AppIconExtractor {
    constructor(adbPath) {
        this.adbPath = adbPath;
    }

    async getApkPathOnDevice(serial, packageName, userId = null) {
        const userArg = Number.isInteger(userId) ? ` --user ${userId}` : "";
        const stdout = await execWithTimeout(
            `"${this.adbPath}" -s ${adbSerialArg(serial)} shell pm path${userArg} ${packageName}`
        );

        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const apkLine = lines.find((line) => /base\.apk$/i.test(line)) || lines[0];
        if (!apkLine) return null;

        const match = apkLine.match(/^package:(.+)$/);
        return match ? match[1].trim() : null;
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
            const iconFile = findBestIconFile(extractDir);
            if (!iconFile) return null;

            fs.copyFileSync(iconFile, outputPath);
            return outputPath;
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
        if (!iconPath) return null;
        try {
            return pathToFileURL(iconPath).href;
        } catch (_err) {
            return null;
        }
    }

    async extractIcon(serial, packageName, outputPath, userId = null) {
        const remoteApkPath = await this.getApkPathOnDevice(serial, packageName, userId);
        if (!remoteApkPath) return null;

        const tempApkPath = `${outputPath}.apk`;
        await this.pullApk(serial, remoteApkPath, tempApkPath);
        return this.extractIconFromApk(tempApkPath, outputPath);
    }
}

module.exports = { AppIconExtractor, findBestIconFile };
