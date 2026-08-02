const { exec, spawn } = require("child_process");
const { adbSerialArg } = require("../../../shared/adb-serial-arg");

const CREATE_NO_WINDOW = 0x08000000;
const MOTION_ACK_TIMEOUT_MS = 2000;
const MOTION_ACK_PATTERN = /^__ACK_(\d+)__$/;

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

function spawnAdbShell(adbPath, serial, shellTokens) {
    return new Promise((resolve, reject) => {
        const args = ["-s", serial, "shell", ...shellTokens];
        const options = { windowsHide: true };
        if (process.platform === "win32") {
            options.creationFlags = CREATE_NO_WINDOW;
        }

        const child = spawn(adbPath, args, options);
        let stderr = "";

        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `adb shell exit ${code}`));
                return;
            }
            resolve("");
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

/** `input text` interprète % — doubler uniquement pour un pourcentage littéral. */
function prepareLiteralInputText(text) {
    return String(text).replace(/%/g, "%%");
}

/** Guillemets simples : caractère ASCII littéral pour `input text`. */
function quoteForDeviceShell(literalText) {
    return `'${literalText.replace(/'/g, "'\\''")}'`;
}

/** UTF-8 multi-octets via printf sur le shell Android (é, è, §, …). */
function formatAdbUtf8TextArg(text) {
    const bytes = Buffer.from(String(text), "utf8");
    let octal = "";
    for (const b of bytes) {
        octal += `\\${b.toString(8).padStart(3, "0")}`;
    }
    return `$(printf '${octal}')`;
}

function isAsciiOnlyText(text) {
    for (const ch of String(text)) {
        if (ch.codePointAt(0) > 0x7f) {
            return false;
        }
    }
    return true;
}

function shellQuote(value) {
    return adbSerialArg(value);
}

async function getDeviceSize(adbPath, serial) {
    const stdout = await execPromise(`"${adbPath}" -s ${shellQuote(serial)} shell wm size`);
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
        this.captureRotation = 0;
        this.displayId = null;
        this._activeTouch = null;
        this._activeTouchStart = null;
        this._activeTouchAt = 0;
        this._persistentShell = null;
        this._ackCounter = 0;
        this._pendingAcks = [];
        this._stdoutBuffer = "";
    }

    _isPersistentShellAlive() {
        return Boolean(
            this._persistentShell
            && !this._persistentShell.killed
            && this._persistentShell.exitCode === null
        );
    }

    _rejectPendingAcks(error) {
        const pending = this._pendingAcks.splice(0, this._pendingAcks.length);
        for (const entry of pending) {
            if (entry.timer) clearTimeout(entry.timer);
            try {
                entry.reject(error);
            } catch (_err) {
                // noop
            }
        }
    }

    _handleStdoutChunk(chunk) {
        this._stdoutBuffer += chunk.toString();
        let newlineIndex = this._stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const rawLine = this._stdoutBuffer.slice(0, newlineIndex);
            this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1);
            const line = rawLine.replace(/\r$/, "").trim();
            const match = MOTION_ACK_PATTERN.exec(line);
            if (match) {
                const entry = this._pendingAcks.shift();
                if (entry) {
                    if (entry.timer) clearTimeout(entry.timer);
                    entry.resolve();
                }
            }
            newlineIndex = this._stdoutBuffer.indexOf("\n");
        }
    }

    _getOrCreatePersistentShell() {
        if (this._isPersistentShellAlive()) {
            return this._persistentShell;
        }

        this._persistentShell = null;
        this._stdoutBuffer = "";

        const args = ["-s", this.serial, "shell"];
        const options = { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
        if (process.platform === "win32") {
            options.creationFlags = CREATE_NO_WINDOW;
        }

        const child = spawn(this.adbPath, args, options);
        this._persistentShell = child;

        const onUnexpectedExit = (reason, detail) => {
            if (this._persistentShell !== child) return;
            const suffix = detail ? `: ${detail}` : "";
            console.warn(`[AdbInputController] shell persistant ${reason} (${this.serial})${suffix}`);
            this._persistentShell = null;
            this._stdoutBuffer = "";
            this._rejectPendingAcks(new Error("shell closed"));
        };

        child.on("error", (err) => onUnexpectedExit("error", err.message));
        child.on("close", (code) => onUnexpectedExit("close", `code ${code}`));
        child.stdout?.on("data", (chunk) => this._handleStdoutChunk(chunk));
        child.stderr?.on("data", () => {});

        return child;
    }

    _writeToShellStdin(shell, line) {
        return new Promise((resolve, reject) => {
            if (!shell?.stdin || shell.stdin.destroyed) {
                reject(new Error("shell stdin unavailable"));
                return;
            }
            shell.stdin.write(line, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    _clearPersistentShell() {
        if (!this._persistentShell) {
            this._rejectPendingAcks(new Error("shell closed"));
            this._stdoutBuffer = "";
            return;
        }
        const shell = this._persistentShell;
        this._persistentShell = null;
        this._stdoutBuffer = "";
        this._rejectPendingAcks(new Error("shell closed"));
        try {
            shell.removeAllListeners();
            shell.stdout?.removeAllListeners();
            shell.stderr?.removeAllListeners();
            shell.stdin?.removeAllListeners();
        } catch (_err) {
            // noop
        }
        try {
            if (!shell.killed && shell.exitCode === null) {
                shell.kill();
            }
        } catch (_err) {
            // noop
        }
    }

    _waitForAck(id) {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const entry = {
            id,
            resolve: null,
            reject: null,
            timer: null
        };
        entry.resolve = () => {
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = null;
            resolve();
        };
        entry.reject = (err) => {
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = null;
            reject(err);
        };
        entry.timer = setTimeout(() => {
            const index = this._pendingAcks.indexOf(entry);
            if (index !== -1) {
                this._pendingAcks.splice(index, 1);
            }
            entry.reject(new Error(`motion ack timeout (${MOTION_ACK_TIMEOUT_MS}ms)`));
        }, MOTION_ACK_TIMEOUT_MS);
        this._pendingAcks.push(entry);
        return { promise, entry };
    }

    _cancelPendingAck(entry, error) {
        if (!entry) return;
        const index = this._pendingAcks.indexOf(entry);
        if (index !== -1) {
            this._pendingAcks.splice(index, 1);
        }
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        try {
            entry.reject(error);
        } catch (_err) {
            // noop
        }
    }

    async _writePersistentMotionEvent(action, x, y) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const id = ++this._ackCounter;
                const line = `${this._buildInputShellCommand("motionevent", action, x, y)}; echo __ACK_${id}__\n`;
                const shell = this._getOrCreatePersistentShell();
                const { promise: ackPromise, entry } = this._waitForAck(id);
                try {
                    await this._writeToShellStdin(shell, line);
                } catch (writeErr) {
                    this._cancelPendingAck(entry, writeErr);
                    void ackPromise.catch(() => {});
                    throw writeErr;
                }
                await ackPromise;
                return;
            } catch (err) {
                this._clearPersistentShell();
                if (attempt === 1) {
                    throw err;
                }
            }
        }
    }

    dispose() {
        if (!this._persistentShell) {
            this._rejectPendingAcks(new Error("shell closed"));
            this._stdoutBuffer = "";
            return;
        }
        const shell = this._persistentShell;
        this._persistentShell = null;
        this._stdoutBuffer = "";
        this._rejectPendingAcks(new Error("shell closed"));
        try {
            shell.removeAllListeners();
            shell.stdout?.removeAllListeners();
            shell.stderr?.removeAllListeners();
            shell.stdin?.removeAllListeners();
        } catch (_err) {
            // noop
        }
        try {
            if (!shell.killed && shell.exitCode === null) {
                shell.kill();
            }
        } catch (_err) {
            // noop
        }
    }

    async init(preresolvedDims = null) {
        if (preresolvedDims?.width > 0 && preresolvedDims?.height > 0) {
            this.deviceWidth = Number(preresolvedDims.width);
            this.deviceHeight = Number(preresolvedDims.height);
            return;
        }
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

    setCaptureRotation(degrees) {
        const value = Number(degrees);
        this.captureRotation = Number.isFinite(value) ? value : 0;
    }

    setDisplayId(displayId) {
        this.displayId = Number.isInteger(displayId) ? displayId : null;
    }

    _buildInputShellCommand(...parts) {
        let cmd = "input";
        if (Number.isInteger(this.displayId)) {
            cmd += ` -d ${this.displayId}`;
        }
        if (parts.length > 0) {
            cmd += ` ${parts.join(" ")}`;
        }
        return cmd;
    }

    _runAdbShellCommand(command) {
        return spawnAdbShell(this.adbPath, this.serial, [command]);
    }

    _runAdb(args) {
        return execPromise(`"${this.adbPath}" -s ${shellQuote(this.serial)} ${args}`);
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
        if (Number.isInteger(this.displayId)) {
            const streamWidth = this.streamWidth || this.deviceWidth;
            const streamHeight = this.streamHeight || this.deviceHeight;
            if (streamWidth <= 0 || streamHeight <= 0) {
                throw new Error("Taille du flux inconnue pour le display virtuel");
            }
            return {
                x: Math.min(Math.max(Math.round(streamX), 0), streamWidth - 1),
                y: Math.min(Math.max(Math.round(streamY), 0), streamHeight - 1)
            };
        }

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
                if (this.captureRotation === 270) {
                    deviceX = Math.round(clampedY * this.deviceWidth / streamHeight);
                    deviceY = Math.round((streamWidth - 1 - clampedX) * this.deviceHeight / streamWidth);
                } else {
                    deviceX = Math.round((streamHeight - 1 - clampedY) * this.deviceWidth / streamHeight);
                    deviceY = Math.round(clampedX * this.deviceHeight / streamWidth);
                }
            } else {
                // Portrait stream from a landscape device (rotation verrouillée).
                if (this.captureRotation === 270) {
                    deviceX = Math.round((streamHeight - 1 - clampedY) * this.deviceWidth / streamHeight);
                    deviceY = Math.round(clampedX * this.deviceHeight / streamWidth);
                } else {
                    deviceX = Math.round(clampedY * this.deviceWidth / streamHeight);
                    deviceY = Math.round((streamWidth - 1 - clampedX) * this.deviceHeight / streamWidth);
                }
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

        if (type === "down") {
            this._activeTouchStart = { x, y };
            this._activeTouch = { x, y };
            this._activeTouchAt = Date.now();
            return this._writePersistentMotionEvent("DOWN", x, y);
        }

        if (type === "move") {
            this._activeTouch = { x, y };
            return this._writePersistentMotionEvent("MOVE", x, y);
        }

        if (type === "up") {
            this._activeTouch = null;
            this._activeTouchStart = null;
            this._activeTouchAt = 0;
            return this._writePersistentMotionEvent("UP", x, y);
        }

        if (type === "tap") {
            return this._runAdbShellCommand(this._buildInputShellCommand("tap", x, y));
        }

        if (type === "swipe") {
            const duration = 200;
            return this._runAdbShellCommand(
                this._buildInputShellCommand("swipe", x, y, x, y, duration)
            );
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
        return this._runAdbShellCommand(
            this._buildInputShellCommand("swipe", start.x, start.y, end.x, end.y, duration)
        );
    }

    async sendKey(key) {
        if (key === " ") {
            return this._runAdbShellCommand(this._buildInputShellCommand("keyevent", 62));
        }

        if (key.length === 1) {
            const textArg = isAsciiOnlyText(key)
                ? quoteForDeviceShell(prepareLiteralInputText(key))
                : formatAdbUtf8TextArg(key);
            return this._runAdbShellCommand(
                this._buildInputShellCommand("text", textArg)
            );
        }

        const keycode = KEYCODE_MAP[key] ?? Number(key);
        if (!Number.isFinite(keycode)) {
            throw new Error(`Touche Android inconnue: ${key}`);
        }
        return this._runAdbShellCommand(this._buildInputShellCommand("keyevent", keycode));
    }
}

module.exports = { AdbInputController, KEYCODE_MAP };
