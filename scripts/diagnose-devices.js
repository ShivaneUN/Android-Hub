/**
 * Diagnostic hors UI — liste ADB + registre unifié.
 * Usage: node scripts/diagnose-devices.js
 */
const path = require("path");
const { DeviceManager } = require("../src/main/managers/device-manager");
const { WifiDevicesManager } = require("../src/main/managers/wifi-devices-manager");
const { WifiAdbService } = require("../src/main/managers/wifi-adb-service");
const { DeviceRegistry } = require("../src/main/managers/device-registry");

const adbPath = path.join(__dirname, "..", "tools", "adb.exe");
const userDataPath = path.join(process.env.APPDATA || "", "android-hub");

async function main() {
    console.log("=== Android Hub — diagnostic appareils ===\n");
    console.log("adb:", adbPath);
    console.log("userData:", userDataPath);

    const dm = new DeviceManager(adbPath);
    const raw = await dm.getConnectedDevices();
    console.log("\n[DeviceManager.getConnectedDevices]", raw.length, "ligne(s)");
    for (const d of raw) {
        console.log(" -", d.serial, d.status, d.name);
    }

    const wifiMgr = new WifiDevicesManager(userDataPath);
    const wifiSvc = new WifiAdbService(adbPath, wifiMgr);
    const registry = new DeviceRegistry({
        deviceManager: dm,
        wifiDevicesManager: wifiMgr,
        wifiAdbService: wifiSvc
    });

    const unified = await registry.listUnifiedDevices();
    console.log("\n[DeviceRegistry.listUnifiedDevices]", unified.length, "entrée(s)");
    for (const d of unified) {
        console.log(
            " -",
            d.deviceId || "?",
            "| serial:", d.serial || "?",
            "| connected:", d.connected,
            "| status:", d.status,
            "| transport:", d.transport
        );
    }

    const connected = unified.filter((d) => d.connected !== false);
    console.log("\nConnectés (connected !== false):", connected.length);
    if (!connected.length && raw.length) {
        console.log("\n⚠️  ADB voit des appareils mais unified.connected=false pour tous.");
    }
}

main().catch((err) => {
    console.error("ERREUR:", err.message);
    process.exit(1);
});
