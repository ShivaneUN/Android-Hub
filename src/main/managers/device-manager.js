const { exec } = require("child_process");
const {
    buildAppLabel,
    isUsableAppLabel,
    humanizePackageName
} = require("../../shared/app-display");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

const DEFAULT_COMMAND_TIMEOUT_MS = 12000;
const PACKAGE_LIST_TIMEOUT_MS = 15000;

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

function execWithTimeout(command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return Promise.race([
        execPromise(command),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timeout ADB (${timeoutMs}ms)`)), timeoutMs);
        })
    ]);
}

class DeviceManager {
    constructor(adbPath) {
        this.adbPath = adbPath;
        this._liveStatusCache = new Map();
        this._liveStatusTtlMs = 45000;
    }

    _fastDisplayName(labelFromPm, pkg) {
        if (isUsableAppLabel(labelFromPm)) {
            return labelFromPm.trim();
        }
        return humanizePackageName(pkg);
    }

    _parsePlainPackageLines(stdout, userId) {
        return stdout.split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith("package:"))
            .map((line) => line.replace(/^package:/, "").trim())
            .filter(Boolean)
            .map((pkg) => ({ package: pkg, userId, labelFromPm: null }));
    }

    _parsePackageListLine(line, userId) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("package:")) return null;

        const content = trimmed.slice("package:".length).trim();
        if (!content) return null;

        const separatorIndex = content.search(/\s/);
        if (separatorIndex === -1) {
            return { package: content, userId, labelFromPm: null };
        }

        const pkg = content.slice(0, separatorIndex).trim();
        const labelFromPm = content.slice(separatorIndex).trim() || null;
        if (!pkg) return null;

        return { package: pkg, userId, labelFromPm };
    }

    _parsePackageListOutput(stdout, userId) {
        const parsed = stdout.split(/\r?\n/)
            .map((line) => this._parsePackageListLine(line, userId))
            .filter(Boolean);

        if (parsed.length > 0) {
            return parsed;
        }

        return this._parsePlainPackageLines(stdout, userId);
    }

    async getInstalledPackagesByUser(serial, userId) {
        const plainCommand = `"${this.adbPath}" -s ${adbSerialArg(serial)} shell pm list packages -3 --user ${userId}`;

        try {
            const stdout = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell pm list packages -3 -l --user ${userId}`,
                PACKAGE_LIST_TIMEOUT_MS
            );
            const parsed = this._parsePackageListOutput(stdout, userId);
            if (parsed.length > 0) {
                return parsed;
            }
        } catch (err) {
            console.warn(`[DeviceManager] pm list -l user=${userId} fallback:`, err.message);
        }

        const stdout = await execWithTimeout(plainCommand, PACKAGE_LIST_TIMEOUT_MS);
        return this._parsePlainPackageLines(stdout, userId);
    }

    async getUserIds(serial) {
        try {
            const stdout = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell pm list users`,
                DEFAULT_COMMAND_TIMEOUT_MS
            );
            const ids = [];
            const regex = /UserInfo\{(\d+):/g;
            let match;
            while ((match = regex.exec(stdout)) !== null) {
                ids.push(Number(match[1]));
            }

            if (ids.length > 0) {
                return Array.from(new Set(ids)).sort((a, b) => a - b);
            }
        } catch (err) {
            console.warn("[DeviceManager] pm list users fallback:", err.message);
        }

        return [0];
    }

    async _fetchAllPackages(serial) {
        const userIds = await this.getUserIds(serial);
        const packagesByUser = await Promise.all(
            userIds.map(async (userId) => {
                try {
                    return await this.getInstalledPackagesByUser(serial, userId);
                } catch (err) {
                    console.warn(`[DeviceManager] packages user=${userId} failed:`, err.message);
                    return [];
                }
            })
        );
        return packagesByUser.flat();
    }

    _buildAppEntries(packages) {
        return packages.map(({ package: pkg, userId, labelFromPm }) => ({
            package: pkg,
            userId,
            appKey: `${pkg}@@${userId}`,
            displayName: this._fastDisplayName(labelFromPm, pkg)
        }));
    }

    _attachDuplicateLabels(appsWithNames) {
        const seenNames = new Map();
        appsWithNames.forEach((app) => {
            if (!seenNames.has(app.displayName)) {
                seenNames.set(app.displayName, []);
            }
            seenNames.get(app.displayName).push(app);
        });

        return appsWithNames.map((app) => {
            const duplicates = seenNames.get(app.displayName).map((entry) => ({
                package: entry.package,
                userId: entry.userId,
                appKey: entry.appKey
            }));
            const { labelName, variantType, displayName } = buildAppLabel(
                { ...app, isDuplicate: duplicates.length > 1 },
                duplicates
            );

            return {
                package: app.package,
                userId: app.userId,
                appKey: app.appKey,
                displayName,
                labelName,
                variantType,
                isDuplicate: duplicates.length > 1,
                duplicates
            };
        });
    }

    async getConnectedDevices() {
        const stdout = await execWithTimeout(`"${this.adbPath}" devices -l`, DEFAULT_COMMAND_TIMEOUT_MS);
        const lines = stdout.split("\n").slice(1).filter((line) => line.trim() !== "");

        return lines.map((line) => {
            const parts = line.trim().split(/\s+/);
            const serial = parts[0];
            const state = parts[1];
            let status = "orange";
            if (state === "device") status = "green";
            else if (state === "offline" || state === "unauthorized") status = "red";

            const modelMatch = line.match(/model:(\S+)/);
            const name = modelMatch ? modelMatch[1].replace(/_/g, " ") : serial;

            return {
                serial,
                status,
                name,
                connected: true
            };
        });
    }

    async getInstalledApps(serial) {
        const packages = await this._fetchAllPackages(serial);
        return packages.map((entry) => entry.package);
    }

    async getInstalledAppsWithDetails(serial) {
        if (!serial) {
            throw new Error("Serial appareil manquant");
        }

        console.log(`[DeviceManager] Chargement apps pour ${serial}...`);
        const packages = await this._fetchAllPackages(serial);
        console.log(`[DeviceManager] ${packages.length} packages detectes`);

        const appsWithNames = this._buildAppEntries(packages);
        const apps = this._attachDuplicateLabels(appsWithNames);
        console.log(`[DeviceManager] ${apps.length} apps pretes pour l'UI`);
        return apps;
    }

    async getDeviceInfo(serial) {
        const [sizeOutput, androidVersion] = await Promise.all([
            execWithTimeout(`"${this.adbPath}" -s ${adbSerialArg(serial)} shell wm size`, DEFAULT_COMMAND_TIMEOUT_MS),
            execWithTimeout(`"${this.adbPath}" -s ${adbSerialArg(serial)} shell getprop ro.build.version.release`, DEFAULT_COMMAND_TIMEOUT_MS)
        ]);

        const sizeMatch = sizeOutput.match(/Physical size:\s*(\d+)x(\d+)/i);
        if (!sizeMatch) {
            throw new Error(`Impossible de lire la resolution de l'appareil : ${sizeOutput}`);
        }

        return {
            width: Number(sizeMatch[1]),
            height: Number(sizeMatch[2]),
            androidVersion: androidVersion || "unknown"
        };
    }

    async getDeviceLiveStatus(serial) {
        if (!serial) {
            return { battery: null, wifiStatus: "Inconnu" };
        }

        const cached = this._liveStatusCache.get(serial);
        if (cached && Date.now() - cached.fetchedAt < this._liveStatusTtlMs) {
            return { battery: cached.battery, wifiStatus: cached.wifiStatus };
        }

        let battery = null;
        let wifiStatus = "Inconnu";

        try {
            const batteryOut = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell dumpsys battery`,
                6000
            );
            const levelMatch = batteryOut.match(/level:\s*(\d+)/i);
            if (levelMatch) {
                battery = Math.min(100, Math.max(0, Number(levelMatch[1])));
            }
        } catch (err) {
            console.warn(`[DeviceManager] battery status ${serial}:`, err.message);
        }

        try {
            const wifiOut = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} shell dumpsys wifi`,
                8000
            );
            if (/Wi-Fi is disabled/i.test(wifiOut)) {
                wifiStatus = "Désactivé";
            } else if (/Supplicant state:\s*COMPLETED/i.test(wifiOut) || /mNetworkInfo.*state:\s*CONNECTED/i.test(wifiOut)) {
                wifiStatus = "Connecté";
            } else if (/Wi-Fi is enabled/i.test(wifiOut)) {
                wifiStatus = "Activé";
            } else {
                wifiStatus = "Hors ligne";
            }
        } catch (err) {
            console.warn(`[DeviceManager] wifi status ${serial}:`, err.message);
        }

        this._liveStatusCache.set(serial, {
            battery,
            wifiStatus,
            fetchedAt: Date.now()
        });

        return { battery, wifiStatus };
    }

    async enrichDevicesWithStatus(devices) {
        if (!Array.isArray(devices) || devices.length === 0) return devices;

        const enriched = await Promise.all(
            devices.map(async (device) => {
                if (!device?.connected || !device.serial) return device;
                try {
                    const status = await this.getDeviceLiveStatus(device.serial);
                    return { ...device, ...status };
                } catch (_err) {
                    return { ...device, battery: null, wifiStatus: "Inconnu" };
                }
            })
        );

        return enriched;
    }
}

module.exports = { DeviceManager };
