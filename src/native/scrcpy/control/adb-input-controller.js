const { exec } = require("child_process");

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

const KEYCODE_MAP = {
    Enter: 66,
    Backspace: 67,
    Escape: 4,
    Tab: 61,
    Space: 62,
    ArrowUp: 19,
    ArrowDown: 20,
    ArrowLeft: 21,
    ArrowRight: 22,
    Home: 3,
    Back: 4,
    Menu: 1,
    Delete: 112,
    VolumeUp: 24,
    VolumeDown: 25,
    Power: 26,
};

async function getDeviceSize(adbPath, serial) {
    const stdout = await execPromise(`"${adbPath}" -s ${serial} shell wm size`);
    const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/i);
    if (!match) {
        throw new Error(`Impossible de lire la résolution de l'appareil : ${stdout}`);
    }
    return {
        width: Number(match[1]),
        height: Number(match[2])
    };
}

class AdbInputController {
    constructor(adbPath, serial) {
        this.adbPath = adbPath;
        this.serial = serial;
        this.deviceWidth = 0;
        this.deviceHeight = 0;
        this.streamWidth = 0;
        this.streamHeight = 0;
        this.orientation = "portrait";
    }

    async init() {
        const { width, height } = await getDeviceSize(this.adbPath, this.serial);
        this.deviceWidth = width;
        this.deviceHeight = height;
    }

    setStreamSize(width, height) {
        this.streamWidth = Number(width) || 0;
        this.streamHeight = Number(height) || 0;
    }

    setOrientation(orientation) {
        if (orientation === "landscape" || orientation === "portrait") {
            this.orientation = orientation;
        }
    }

    _runAdb(args) {
        return execPromise(`"${this.adbPath}" -s ${this.serial} ${args}`);
    }

    _normalizeCoordinate(normX, normY) {
        const clampedX = Math.min(Math.max(normX, 0), 1);
        const clampedY = Math.min(Math.max(normY, 0), 1);

        const streamWidth = this.streamWidth || this.deviceWidth;
        const streamHeight = this.streamHeight || this.deviceHeight;
        const streamX = Math.round(clampedX * (streamWidth - 1));
        const streamY = Math.round(clampedY * (streamHeight - 1));

        return this._normalizeStreamPixelCoordinate(streamX, streamY);
    }

    _normalizeStreamPixelCoordinate(streamX, streamY) {
        if (this.deviceWidth <= 0 || this.deviceHeight <= 0) {
            throw new Error("Taille physique du device inconnue");
        }

        const streamWidth = this.streamWidth || this.deviceWidth;
        const streamHeight = this.streamHeight || this.deviceHeight;

        const clampedX = Math.min(Math.max(streamX, 0), streamWidth - 1);
        const clampedY = Math.min(Math.max(streamY, 0), streamHeight - 1);

        let deviceX;
        let deviceY;
        const streamLandscape = streamWidth > streamHeight;
        const deviceLandscape = this.deviceWidth > this.deviceHeight;

        if (streamLandscape !== deviceLandscape) {
            if (streamLandscape && !deviceLandscape) {
                // Landscape stream from a portrait device (likely 90° rotation).
                deviceX = Math.round((streamHeight - 1 - clampedY) * this.deviceWidth / streamHeight);
                deviceY = Math.round(clampedX * this.deviceHeight / streamWidth);
            } else {
                // Portrait stream from a landscape device (likely 90° rotation).
                deviceX = Math.round(clampedY * this.deviceWidth / streamHeight);
                deviceY = Math.round((streamWidth - 1 - clampedX) * this.deviceHeight / streamWidth);
            }
        } else {
            deviceX = Math.round(clampedX * (this.deviceWidth - 1) / (streamWidth - 1));
            deviceY = Math.round(clampedY * (this.deviceHeight - 1) / (streamHeight - 1));
        }

        return {
            x: Math.min(Math.max(deviceX, 0), this.deviceWidth - 1),
            y: Math.min(Math.max(deviceY, 0), this.deviceHeight - 1)
        };
    }

    async sendTouch(type, normX, normY, isStreamPixel = false) {
        const { x, y } = isStreamPixel
            ? this._normalizeStreamPixelCoordinate(normX, normY)
            : this._normalizeCoordinate(normX, normY);

        if (type === "tap") {
            return this._runAdb(`shell input tap ${x} ${y}`);
        }

        if (type === "swipe") {
            const duration = 200;
            return this._runAdb(`shell input touchscreen swipe ${x} ${y} ${x} ${y} ${duration}`);
        }

        throw new Error(`Type de touch inconnu: ${type}`);
    }

    async sendScroll(startNormX, startNormY, endNormX, endNormY, isStreamPixel = false) {
        const start = isStreamPixel
            ? this._normalizeStreamPixelCoordinate(startNormX, startNormY)
            : this._normalizeCoordinate(startNormX, startNormY);
        const end = isStreamPixel
            ? this._normalizeStreamPixelCoordinate(endNormX, endNormY)
            : this._normalizeCoordinate(endNormX, endNormY);
        const duration = 150;
        return this._runAdb(`shell input swipe ${start.x} ${start.y} ${end.x} ${end.y} ${duration}`);
    }

    async sendKey(key) {
        if (key.length === 1) {
            const escaped = key.replace(/([$`"\\])/g, "\\$1");
            return this._runAdb(`shell input text \"${escaped}\"`);
        }

        const keycode = KEYCODE_MAP[key] ?? Number(key);
        if (!Number.isFinite(keycode)) {
            throw new Error(`Touche Android inconnue: ${key}`);
        }
        return this._runAdb(`shell input keyevent ${keycode}`);
    }
}

module.exports = { AdbInputController };
