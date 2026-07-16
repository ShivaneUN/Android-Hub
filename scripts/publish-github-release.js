#!/usr/bin/env node
/**
 * Publication GitHub Releases fiable pour electron-updater.
 * - Build NSIS + génération latest.yml (electron-builder, publish never)
 * - Upload garanti : latest.yml, Setup.exe, .blockmap via API GitHub
 * - Vérification finale que latest.yml est bien sur la release
 *
 * Usage :
 *   npm run build:release
 *   node scripts/publish-github-release.js --upload-only   (dist déjà buildé)
 */
const { execSync, execFileSync } = require("child_process");
const { createReadStream } = require("fs");
const fs = require("fs");
const path = require("path");

const { resolveDistAbsolute, findUpdateArtifacts } = require("./build-output-dir");
const { loadEnv } = require("./load-env");

const ROOT = path.join(__dirname, "..");
loadEnv(ROOT);
const GITHUB_OWNER = "ShivaneUN";
const GITHUB_REPO = "Android-Hub";
const REQUIRED_ASSETS = ["latest.yml"];

function run(cmd, env = process.env) {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true, windowsHide: true, env });
}

function getToken() {
    const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
    if (!token) {
        const envPath = path.join(ROOT, ".env");
        console.error("\nERREUR: GH_TOKEN manquant.");
        console.error(`Créez ${envPath} (voir .env.example) avec :`);
        console.error("  GH_TOKEN=ghp_...");
        console.error("Ou en session PowerShell : $env:GH_TOKEN = \"ghp_...\"\n");
        process.exit(1);
    }
    return token;
}

function runGit(args, { capture = false } = {}) {
    const options = { cwd: ROOT, windowsHide: true };
    if (capture) {
        options.encoding = "utf8";
        return execFileSync("git", args, options).trim();
    }
    console.log(`> git ${args.join(" ")}`);
    execFileSync("git", args, { ...options, stdio: "inherit" });
}

function tagExistsLocally(tag) {
    try {
        runGit(["rev-parse", `refs/tags/${tag}`], { capture: true });
        return true;
    } catch (_err) {
        return false;
    }
}

function tagExistsOnOrigin(tag) {
    try {
        const out = runGit(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { capture: true });
        return out.length > 0;
    } catch (_err) {
        return false;
    }
}

async function githubApi(token, apiPath, { method = "GET", body = null } = {}) {
    const response = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub API ${method} ${apiPath} → ${response.status}\n${text}`);
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
}

async function getReleaseByTag(token, tag) {
    return githubApi(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${encodeURIComponent(tag)}`);
}

async function listReleaseAssets(token, releaseId) {
    const all = [];
    let page = 1;

    while (true) {
        const batch = await githubApi(
            token,
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${releaseId}/assets?per_page=100&page=${page}`
        ) || [];

        all.push(...batch);
        if (batch.length < 100) {
            break;
        }
        page += 1;
    }

    return all;
}

function normalizeAssetName(name) {
    return String(name).trim().replace(/\s+/g, ".");
}

function assetNamesMatch(left, right) {
    return normalizeAssetName(left) === normalizeAssetName(right);
}

function readSetupNameFromLatestYml(latestYmlPath) {
    const content = fs.readFileSync(latestYmlPath, "utf8");
    const match = content.match(/^path:\s*(.+)$/m);
    return match ? match[1].trim() : null;
}

function resolveUploadName(filePath, latestYmlPath) {
    const base = path.basename(filePath);
    if (!base.endsWith(".exe") || !latestYmlPath) {
        return base;
    }

    const fromYml = readSetupNameFromLatestYml(latestYmlPath);
    return fromYml || base;
}

async function waitForAssetRemoved(token, releaseId, name, maxAttempts = 12) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const assets = await listReleaseAssets(token, releaseId);
        if (!assets.some((asset) => assetNamesMatch(asset.name, name))) {
            return true;
        }
        await sleep(500);
    }

    return false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteReleaseAssetByName(token, releaseId, name) {
    const assets = await listReleaseAssets(token, releaseId);
    const matches = assets.filter((asset) => assetNamesMatch(asset.name, name));

    for (const asset of matches) {
        console.log(`Suppression de l'asset existant ${asset.name} (id ${asset.id})…`);
        await githubApi(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/${asset.id}`, {
            method: "DELETE"
        });
    }

    if (matches.length === 0) {
        return;
    }

    const removed = await waitForAssetRemoved(token, releaseId, name);
    if (!removed) {
        throw new Error(`L'asset ${name} est toujours présent sur la release après suppression.`);
    }
}

async function uploadReleaseAsset(token, releaseId, filePath, uploadName) {
    const name = uploadName || path.basename(filePath);
    const size = fs.statSync(filePath).size;
    const contentType = name.endsWith(".yml") ? "application/x-yaml" : "application/octet-stream";
    const url = new URL(`https://uploads.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${releaseId}/assets`);
    url.searchParams.set("name", name);

    console.log(`Upload ${name} (${(size / 1024 / 1024).toFixed(1)} Mo)…`);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        await deleteReleaseAssetByName(token, releaseId, name);

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": contentType,
                "Content-Length": String(size)
            },
            body: createReadStream(filePath),
            duplex: "half"
        });

        if (response.ok) {
            return response.json();
        }

        const text = await response.text();
        const alreadyExists = response.status === 422 && text.includes("already_exists");

        if (alreadyExists && attempt < 3) {
            console.log(`Asset ${name} encore présent — nouvelle tentative (${attempt + 1}/3)…`);
            await sleep(1000);
            continue;
        }

        throw new Error(`Upload ${name} échoué → ${response.status}\n${text}`);
    }

    throw new Error(`Upload ${name} échoué après plusieurs tentatives.`);
}

async function deleteReleaseByTag(token, tag) {
    const release = await getReleaseByTag(token, tag);
    if (!release) {
        return false;
    }

    console.log(`Release GitHub ${tag} déjà présente (id ${release.id}) — suppression pour republication…`);
    await githubApi(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${release.id}`, { method: "DELETE" });
    console.log(`Release ${tag} supprimée (le tag git est conservé).`);
    return true;
}

async function createRelease(token, tag, version) {
    const existing = await getReleaseByTag(token, tag);
    if (existing) {
        return existing;
    }

    console.log(`Création de la release GitHub ${tag}…`);
    return githubApi(token, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`, {
        method: "POST",
        body: {
            tag_name: tag,
            name: tag,
            draft: false,
            prerelease: false,
            body: `Android Hub v${version}`
        }
    });
}

function collectArtifacts(version) {
    const distRoot = resolveDistAbsolute();
    const artifacts = findUpdateArtifacts(distRoot, version);

    if (!fs.existsSync(artifacts.setup)) {
        throw new Error(`Installateur introuvable : ${artifacts.setup}`);
    }
    if (!fs.existsSync(artifacts.latestYml)) {
        throw new Error(
            `latest.yml introuvable dans ${distRoot}.\n`
            + "Relancez le build avec electron-builder.publish.config.js (publishAutoUpdate activé)."
        );
    }

    const files = [artifacts.latestYml, artifacts.setup];
    if (artifacts.blockmap) {
        files.push(artifacts.blockmap);
    }

    console.log("\nArtefacts locaux :");
    for (const file of files) {
        console.log(`  - ${path.relative(ROOT, file)}`);
    }

    return files;
}

async function uploadArtifacts(token, tag, version) {
    const files = collectArtifacts(version);
    const release = await createRelease(token, tag, version);
    const latestYmlPath = files.find((file) => path.basename(file) === "latest.yml") || null;

    for (const file of files) {
        const uploadName = resolveUploadName(file, latestYmlPath);
        await uploadReleaseAsset(token, release.id, file, uploadName);
    }

    const assets = await listReleaseAssets(token, release.id);
    const names = new Set(assets.map((a) => a.name));

    for (const required of REQUIRED_ASSETS) {
        if (!names.has(required)) {
            throw new Error(`Vérification échouée : ${required} absent de la release ${tag}.`);
        }
    }

    console.log(`\nVérification OK — latest.yml présent sur la release.`);
    console.log(`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag}\n`);
}

async function ensureGitTag(tag) {
    if (!tagExistsLocally(tag)) {
        console.log(`Création du tag local ${tag}…`);
        runGit(["tag", "-a", tag, "-m", `Release ${tag}`]);
    } else {
        console.log(`Tag local ${tag} déjà présent.`);
    }

    if (!tagExistsOnOrigin(tag)) {
        console.log(`Push du tag ${tag} vers origin…`);
        runGit(["push", "origin", tag]);
    } else {
        console.log(`Tag ${tag} déjà présent sur origin.`);
    }
}

async function runBuildWithRetry(env) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            if (attempt > 1) {
                console.log(`Nouvelle tentative de build (${attempt}/${maxAttempts})…`);
            }

            run("node scripts/clean-dist-unpack.js");
            run("node scripts/generate-update-feed.js");
            run(
                "electron-builder --win --config electron-builder.publish.config.js --publish never",
                env
            );
            return;
        } catch (err) {
            if (attempt === maxAttempts) {
                throw err;
            }

            console.warn("\nBuild échoué — nouvelle tentative après nettoyage…");
            console.warn("Si app.asar reste verrouillé: fermez Android Hub et l'explorateur sur dist\\.\n");
        }
    }
}

async function main() {
    const uploadOnly = process.argv.includes("--upload-only");
    const token = getToken();
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const tag = `v${pkg.version}`;

    console.log(`\n=== Publication GitHub Releases — ${tag} ===\n`);

    if (!uploadOnly) {
        await ensureGitTag(tag);
        await deleteReleaseByTag(token, tag);

        const buildEnv = {
            ...process.env,
            GH_TOKEN: token,
            EP_GH_IGNORE_TIME: "true"
        };

        await runBuildWithRetry(buildEnv);
    } else {
        console.log("Mode --upload-only : pas de rebuild, upload depuis dist/.\n");
    }

    await uploadArtifacts(token, tag, pkg.version);
    console.log(`OK — release ${tag} complète (Setup + latest.yml + blockmap).\n`);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
