const { exec } = require("child_process");
const { DEFAULT_WIFI_PORT } = require("./wifi-devices-manager");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

const WIFI_SERIAL_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/;
const DEFAULT_CONNECT_TIMEOUT_MS = 7000;
const STABLE_ID_CACHE_TTL_MS = 120000;

function execPromise(command, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(String(stderr || error.message).trim() || error.message));
                return;
            }
            resolve(String(stdout || "").trim());
        });
    });
}

function execWithTimeout(command, timeoutMs) {
    return Promise.race([
        execPromise(command, timeoutMs),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timeout ADB (${timeoutMs}ms)`)), timeoutMs);
        })
    ]);
}

class WifiAdbService {
    constructor(adbPath, wifiDevicesManager) {
        this.adbPath = adbPath;
        this.wifiDevicesManager = wifiDevicesManager;
        /** @type {Map<string, { value: string, fetchedAt: number }>} */
        this._stableIdCache = new Map();
    }

    isWifiSerial(serial) {
        return WIFI_SERIAL_PATTERN.test(String(serial || "").trim());
    }

    buildWifiSerial(ip, port = DEFAULT_WIFI_PORT) {
        return `${ip}:${port}`;
    }

    findConfigByWifiSerial(wifiSerial) {
        if (!this.wifiDevicesManager || !wifiSerial) return null;
        const normalized = String(wifiSerial).trim();
        return this.wifiDevicesManager.list().find((entry) => {
            if (!entry?.ip) return false;
            return this.buildWifiSerial(entry.ip, entry.port || DEFAULT_WIFI_PORT) === normalized;
        }) || null;
    }

    parseWifiSerial(wifiSerial) {
        if (!this.isWifiSerial(wifiSerial)) return null;
        const [ip, portStr] = String(wifiSerial).trim().split(":");
        if (!ip) return null;
        const port = Number.parseInt(portStr, 10);
        return { ip, port: Number.isInteger(port) ? port : DEFAULT_WIFI_PORT };
    }

    async getAndroidId(serial) {
        const key = String(serial || "").trim();
        if (!key) return null;

        try {
            const raw = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(key)} shell settings get secure android_id`,
                8000
            );
            const androidId = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
            if (androidId && androidId !== "null" && androidId !== "0") {
                return androidId;
            }
        } catch (err) {
            console.warn(`[WifiAdbService] getAndroidId ${key}:`, err.message);
        }

        return null;
    }

    async resolveStableDeviceId(serial) {
        const key = String(serial || "").trim();
        if (!key) return null;

        const fromSerial = await this.getStableDeviceId(key);
        if (fromSerial && !this.isWifiSerial(fromSerial)) {
            return fromSerial;
        }

        const androidId = await this.getAndroidId(key);
        if (androidId) {
            this._stableIdCache.set(key, { value: androidId, fetchedAt: Date.now() });
            return androidId;
        }

        return fromSerial;
    }

    async getStableDeviceId(serial) {
        const key = String(serial || "").trim();
        if (!key) return null;

        const cached = this._stableIdCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < STABLE_ID_CACHE_TTL_MS) {
            return cached.value;
        }

        try {
            const raw = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(key)} shell getprop ro.serialno`,
                8000
            );
            const stableId = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
            if (stableId && stableId !== "unknown") {
                this._stableIdCache.set(key, { value: stableId, fetchedAt: Date.now() });
                return stableId;
            }
        } catch (err) {
            console.warn(`[WifiAdbService] getStableDeviceId ${key}:`, err.message);
        }

        if (this.isWifiSerial(key)) {
            const configMatch = this.findConfigByWifiSerial(key);
            if (configMatch?.deviceId) {
                this._stableIdCache.set(key, { value: configMatch.deviceId, fetchedAt: Date.now() });
                return configMatch.deviceId;
            }
            return null;
        }

        this._stableIdCache.set(key, { value: key, fetchedAt: Date.now() });
        return key;
    }

    parseWlan0Ip(output) {
        const lines = String(output || "").split(/\r?\n/);
        const inet4Regex = /\binet\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\/|\s|$)/;

        let inWlan0Block = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^\d+:\s*wlan0:/i.test(trimmed) || /^wlan0:/i.test(trimmed)) {
                inWlan0Block = true;
                continue;
            }
            if (inWlan0Block && /^\d+:\s*[^:\s]+:/.test(trimmed)) {
                break;
            }
            if (inWlan0Block || /\bwlan0\b/i.test(line)) {
                const match = line.match(inet4Regex);
                if (match && !match[1].startsWith("127.")) {
                    return match[1];
                }
            }
        }

        for (const line of lines) {
            const match = line.match(inet4Regex);
            if (match && !match[1].startsWith("127.")) {
                return match[1];
            }
        }

        return null;
    }

    async fetchWlan0Ip(usbSerial) {
        const command = `"${this.adbPath}" -s ${adbSerialArg(usbSerial)} shell ip addr show wlan0`;
        const output = await execWithTimeout(command, 8000);
        console.log(`[WifiAdbService] fetchWlan0Ip raw (${usbSerial}):\n${JSON.stringify(output)}`);
        const ip = this.parseWlan0Ip(output);
        console.log(`[WifiAdbService] fetchWlan0Ip parsed (${usbSerial}): ${ip || "(null)"}`);
        return ip;
    }

    async enableTcpip(usbSerial, port = DEFAULT_WIFI_PORT) {
        await execWithTimeout(`"${this.adbPath}" -s ${adbSerialArg(usbSerial)} tcpip ${port}`, 10000);
    }

    async connect(ip, port = DEFAULT_WIFI_PORT, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
        const target = this.buildWifiSerial(ip, port);
        await execWithTimeout(`"${this.adbPath}" connect ${adbSerialArg(target)}`, timeoutMs);
        const state = await this.getAdbState(target);
        if (state !== "device") {
            throw new Error(`État ADB inattendu après connect: ${state || "inconnu"}`);
        }
        return target;
    }

    async disconnect(wifiSerial) {
        if (!wifiSerial) return;
        try {
            await execWithTimeout(`"${this.adbPath}" disconnect ${adbSerialArg(wifiSerial)}`, 5000);
        } catch (err) {
            console.warn(`[WifiAdbService] disconnect ${wifiSerial}:`, err.message);
        }
    }

    async getAdbState(serial) {
        try {
            const stdout = await execWithTimeout(
                `"${this.adbPath}" -s ${adbSerialArg(serial)} get-state`,
                5000
            );
            return stdout.trim().toLowerCase();
        } catch (_err) {
            return null;
        }
    }

    async setupFirstConnection(usbSerial, onProgress) {
        const emit = typeof onProgress === "function" ? onProgress : () => {};

        emit("ip", "Récupération de l'IP...");
        const ip = await this.fetchWlan0Ip(usbSerial);
        if (!ip) {
            throw new Error("IP introuvable, vérifie que le WiFi est activé sur le téléphone");
        }

        emit("tcpip", "Activation WiFi...");
        await this.enableTcpip(usbSerial, DEFAULT_WIFI_PORT);

        emit("connect", "Connexion...");
        const wifiSerial = await this.connect(ip, DEFAULT_WIFI_PORT);

        const deviceId = await this.getStableDeviceId(usbSerial) || await this.getStableDeviceId(wifiSerial);
        if (!deviceId) {
            throw new Error("Impossible de lire l'identifiant stable de l'appareil");
        }

        return { deviceId, ip, port: DEFAULT_WIFI_PORT, wifiSerial };
    }

    async reconnectSaved(deviceId, { usbSerial = null } = {}) {
        const entry = this.wifiDevicesManager.getByDeviceId(deviceId);
        if (!entry?.ip && !usbSerial) {
            throw new Error("Configuration WiFi introuvable.");
        }

        const port = entry?.port || DEFAULT_WIFI_PORT;
        let ip = entry?.ip;
        const now = new Date().toISOString();

        if (usbSerial) {
            ip = await this.fetchWlan0Ip(usbSerial);
            if (!ip) {
                throw new Error("IP introuvable, vérifie que le WiFi est activé sur le téléphone");
            }

            await this.enableTcpip(usbSerial, port);

            this.wifiDevicesManager.upsert({
                ...entry,
                deviceId,
                ip,
                port,
                wifiEnabled: true,
                usbSerialHint: usbSerial,
                lastSeen: now
            });
        } else if (!ip) {
            throw new Error("Configuration WiFi introuvable.");
        }

        return this.connect(ip, port);
    }
}

module.exports = { WifiAdbService, WIFI_SERIAL_PATTERN, DEFAULT_CONNECT_TIMEOUT_MS };
