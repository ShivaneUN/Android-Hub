const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const markerPath = path.join(dist, ".electron-builder-output");

function readMarkerSubdir() {
    if (!fs.existsSync(markerPath)) return null;
    const sub = fs.readFileSync(markerPath, "utf8").trim();
    return sub || null;
}

function setAlternateOutputDir() {
    fs.mkdirSync(dist, { recursive: true });
    const sub = `build-${Date.now()}`;
    fs.writeFileSync(markerPath, sub, "utf8");
    return path.join("dist", sub);
}

function clearAlternateOutputDir() {
    if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
    }
}

function resolveBuildOutputDir(defaultOutput = "dist") {
    const sub = readMarkerSubdir();
    if (!sub) return defaultOutput;
    return path.join("dist", sub);
}

function findSetupExe(distRoot, setupName) {
    const direct = path.join(distRoot, setupName);
    if (fs.existsSync(direct)) return direct;
    if (!fs.existsSync(distRoot)) return direct;

    for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "win-unpacked" || entry.name.startsWith("win-unpacked.")) continue;
        const candidate = path.join(distRoot, entry.name, setupName);
        if (fs.existsSync(candidate)) return candidate;
    }

    return direct;
}

function resolveDistAbsolute(defaultOutput = "dist") {
    const rel = resolveBuildOutputDir(defaultOutput);
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function findLatestYml(distRoot) {
    const direct = path.join(distRoot, "latest.yml");
    if (fs.existsSync(direct)) return direct;
    if (!fs.existsSync(distRoot)) return null;

    for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "win-unpacked" || entry.name.startsWith("win-unpacked.")) continue;
        const candidate = path.join(distRoot, entry.name, "latest.yml");
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * @param {string} distRoot
 * @param {string} version
 * @returns {{ setup: string, latestYml: string, blockmap: string|null }}
 */
function findUpdateArtifacts(distRoot, version) {
    const setupName = `Android Hub-Setup-${version}.exe`;
    const setup = findSetupExe(distRoot, setupName);
    const setupDir = path.dirname(setup);
    const latestYml = findLatestYml(distRoot) || path.join(setupDir, "latest.yml");
    const blockmap = `${setup}.blockmap`;
    return {
        setup,
        latestYml,
        blockmap: fs.existsSync(blockmap) ? blockmap : null
    };
}

module.exports = {
    markerPath,
    setAlternateOutputDir,
    clearAlternateOutputDir,
    resolveBuildOutputDir,
    resolveDistAbsolute,
    findSetupExe,
    findLatestYml,
    findUpdateArtifacts
};
