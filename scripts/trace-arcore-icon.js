const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
    AppIconExtractor,
    findBestIconFile,
    findAdaptiveIconRaster
} = require("../src/main/managers/app-icon-extractor");

const adb = path.join(__dirname, "..", "tools", "adb.exe");
const serial = process.argv[2] || "e176518f";
const pkg = process.argv[3] || "com.google.ar.core";
const userId = Number(process.argv[4] || 0);

function walkLauncherFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkLauncherFiles(fullPath, out);
        } else if (/ic_launcher|launcher/i.test(entry.name)) {
            out.push(fullPath);
        }
    }
    return out;
}

async function main() {
    const ext = new AppIconExtractor(adb);
    const apks = await ext.getAllApkPathsOnDevice(serial, pkg, userId);
    console.log("device:", serial, "package:", pkg, "userId:", userId);
    console.log("APK paths:", apks);

    for (let i = 0; i < apks.length; i += 1) {
        const remote = apks[i];
        const apkLocal = path.join(__dirname, `trace-${i}.apk`);
        const extractDir = path.join(__dirname, `trace-${i}.extract`);
        console.log(`\n=== APK ${i + 1}/${apks.length}: ${path.basename(remote)} ===`);
        try {
            await ext.pullApk(serial, remote, apkLocal);
            console.log("pulled bytes:", fs.statSync(apkLocal).size);

            fs.mkdirSync(extractDir, { recursive: true });
            execSync(`tar -xf "${apkLocal}" -C "${extractDir}"`, { stdio: "inherit" });

            const legacy = findBestIconFile(extractDir);
            const adaptive = findAdaptiveIconRaster(extractDir);
            console.log("legacy match:", legacy || "(none)");
            console.log("adaptive match:", adaptive || "(none)");
            if (legacy) console.log("legacy size:", fs.statSync(legacy).size);
            if (adaptive) console.log("adaptive size:", fs.statSync(adaptive).size);

            const launcherFiles = walkLauncherFiles(path.join(extractDir, "res"));
            console.log("launcher-related files:", launcherFiles.length);
            for (const file of launcherFiles.slice(0, 25)) {
                console.log(" ", file.replace(extractDir, ""));
            }
        } catch (err) {
            console.log("ERROR:", err.message);
        } finally {
            if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
            if (fs.existsSync(apkLocal)) fs.unlinkSync(apkLocal);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
