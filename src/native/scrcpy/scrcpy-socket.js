const net = require("net");
const { exec, spawn } = require("child_process");
const EventEmitter = require("events");
const { resolveCaptureOrientationLock } = require("../../shared/stream-params");

// Chemin vers scrcpy-server (poussé puis exécuté sur le téléphone)
const DEVICE_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
const LOCAL_SOCKET_NAME_PREFIX = "scrcpy_";
const PACKET_FLAG_SESSION = 1n << 63n;
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
const PACKET_PTS_MASK = (1n << 61n) - 1n;

const SC_CONTROL_MSG_TYPE_INJECT_KEYCODE = 0;
const SC_CONTROL_MSG_TYPE_INJECT_TEXT = 1;
const SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2;
const SC_CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT = 3;
const SC_CONTROL_MSG_TYPE_BACK_OR_SCREEN_ON = 4;
const SC_CONTROL_MSG_TYPE_SET_DISPLAY_POWER = 10;

const SC_POINTER_ID_MOUSE = BigInt("0xFFFFFFFFFFFFFFFF");
const SC_POINTER_ID_GENERIC_FINGER = BigInt("0xFFFFFFFFFFFFFFFE");
const SC_POINTER_ID_VIRTUAL_FINGER = BigInt("0xFFFFFFFFFFFFFFFD");

const AMOTION_EVENT_ACTION_DOWN = 0;
const AMOTION_EVENT_ACTION_UP = 1;
const AMOTION_EVENT_ACTION_MOVE = 2;
const AMOTION_EVENT_ACTION_CANCEL = 3;
const AMOTION_EVENT_BUTTON_PRIMARY = 1;

/**
 * Génère un SCID aléatoire (31 bits), comme l'exige le protocole scrcpy.
 */
function generateScid() {
    return Math.floor(Math.random() * 0x7fffffff)
        .toString(16)
        .padStart(8, "0");
}

/**
 * Représente une connexion active à une instance scrcpy-server sur un appareil donné.
 * Émet les événements :
 *  - "connected"      : une fois le socket vidéo prêt à recevoir des données
 *  - "raw-packet"     : (buffer) à chaque paquet vidéo brut reçu (avec son en-tête de 12 octets)
 *  - "error"          : (err) en cas de problème
 *  - "closed"         : à la fermeture de la connexion
 */
class ScrcpySocketClient extends EventEmitter {
    constructor(adbPath, serial) {
        super();
        this.adbPath = adbPath;
        this.serial = serial;
        this.scid = generateScid();
        this.socketName = LOCAL_SOCKET_NAME_PREFIX + this.scid;
        this.localPort = null;
        this.videoSocket = null;
        this.audioSocket = null;
        this.controlSocket = null;
        this.serverProcess = null;
        this.newDisplayId = null;
        this._startOptions = {};
        this._incomingCount = 0;
        this._audioDisabledOnDevice = false;
        this._audioStreamActive = false;
        this._socket2FallbackTimer = null;
        this._controlFromSocket2Fallback = false;
        this._controlWaitExtended = false;
        this.videoStreamSize = null;
    }

    getVideoStreamSize() {
        if (this.videoStreamSize?.width > 0 && this.videoStreamSize?.height > 0) {
            return { ...this.videoStreamSize };
        }
        return null;
    }

    _isAudioEnabled(options = {}) {
        return options.audio === true;
    }

    _isControlEnabled(options = {}) {
        return options.control !== false;
    }

    _areSocketsReady(options = {}) {
        if (!this.videoSocket) return false;
        if (this._isControlEnabled(options) && !this.controlSocket) return false;
        return true;
    }

    _clearSocket2FallbackTimer() {
        if (this._socket2FallbackTimer) {
            clearTimeout(this._socket2FallbackTimer);
            this._socket2FallbackTimer = null;
        }
    }

    _scheduleSocket2ControlFallback(tryFinishIfReady) {
        this._clearSocket2FallbackTimer();
        if (!this._isAudioEnabled(this._startOptions) || !this._isControlEnabled(this._startOptions)) {
            return;
        }
        const audioSocket = this.audioSocket;
        this._socket2FallbackTimer = setTimeout(() => {
            this._socket2FallbackTimer = null;
            if (this.controlSocket || this._incomingCount >= 3) return;
            if (this._incomingCount !== 2) return;
            if (this.audioSocket !== audioSocket || !audioSocket) return;
            if (this._audioStreamActive || this._audioDisabledOnDevice) return;
            console.log(
                `[ScrcpySocketClient] Socket #2 → contrôle (2 connexions, pas d'audio) pour ${this.serial}`
            );
            audioSocket.removeAllListeners("data");
            audioSocket.removeAllListeners("error");
            audioSocket.removeAllListeners("close");
            this.audioSocket = null;
            this.controlSocket = audioSocket;
            this._controlFromSocket2Fallback = true;
            this._attachControlListeners();
            tryFinishIfReady();
        }, 3000);
    }

    _assignControlSocket(socket, tryFinishIfReady) {
        this._clearSocket2FallbackTimer();
        if (this.controlSocket) {
            if (this._incomingCount >= 3 && this._controlFromSocket2Fallback) {
                console.log(
                    `[ScrcpySocketClient] Remplacement contrôle fallback par socket #${this._incomingCount} pour ${this.serial}`
                );
                this.controlSocket.removeAllListeners("error");
                this.controlSocket.removeAllListeners("close");
                this.controlSocket.destroy();
                this.controlSocket = null;
                this._controlFromSocket2Fallback = false;
            } else {
                console.log(`[ScrcpySocketClient] Connexion #${this._incomingCount} ignorée pour ${this.serial}`);
                socket.destroy();
                return;
            }
        }
        console.log(`[ScrcpySocketClient] Connexion contrôle (#${this._incomingCount}) pour ${this.serial}`);
        this.controlSocket = socket;
        this._controlFromSocket2Fallback = false;
        this._attachControlListeners();
        tryFinishIfReady();
    }

    _assignAudioSocket(socket, tryFinishIfReady) {
        console.log(`[ScrcpySocketClient] Connexion audio (#${this._incomingCount}) pour ${this.serial}`);
        this.audioSocket = socket;
        this._attachAudioListeners({ initialBuffer: Buffer.alloc(0), tryFinishIfReady });
        this._scheduleSocket2ControlFallback(tryFinishIfReady);
        tryFinishIfReady();
    }

    _quotedSerial() {
        return `"${String(this.serial || "").replace(/"/g, '\\"')}"`;
    }

    /**
     * Lance scrcpy-server sur le téléphone et se connecte aux flux vidéo et contrôle.
     * serverJarPath : chemin local vers le fichier scrcpy-server (sur le PC) à pousser sur le device.
     */
    async start(serverJarPath, options = {}) {
        this._startOptions = { ...options };
        this._incomingCount = 0;
        this._audioDisabledOnDevice = false;
        this._audioStreamActive = false;
        this._controlFromSocket2Fallback = false;
        this._controlWaitExtended = false;
        this.videoStreamSize = null;
        this._clearSocket2FallbackTimer();
        await this._pushServer(serverJarPath);
        await this._setupTunnel();
        this._startServerProcess(options);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await this._connectSockets(options);
    }

    _runAdb(args) {
        return new Promise((resolve, reject) => {
            exec(`"${this.adbPath}" -s ${this._quotedSerial()} ${args}`, { windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`adb ${args} a échoué: ${stderr || error.message}`));
                    return;
                }
                resolve(stdout);
            });
        });
    }

    async _pushServer(serverJarPath) {
        await this._runAdb(`push "${serverJarPath}" ${DEVICE_SERVER_PATH}`);
    }

    async _setupTunnel() {
        this.localPort = await this._findFreePort();

        try {
            await this._runAdb(`reverse --remove localabstract:${this.socketName}`);
        } catch (_err) {
            // Tunnel absent, ignorer.
        }

        await this._runAdb(`reverse localabstract:${this.socketName} tcp:${this.localPort}`);
    }

    _findFreePort() {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.listen(0, "127.0.0.1", () => {
                const port = server.address().port;
                server.close(() => resolve(port));
            });
            server.on("error", reject);
        });
    }

    _parseNewDisplayId(text) {
        if (!text) return;
        const match = String(text).match(/New display:.*\(id=(\d+)\)/i);
        if (!match) return;

        const displayId = Number(match[1]);
        if (!Number.isInteger(displayId)) return;
        if (this.newDisplayId === displayId) return;

        this.newDisplayId = displayId;
        this.emit("new-display-id", { displayId });
    }

    _appendServerLogChunk(chunk, isStderr = false) {
        const text = chunk.toString();
        const combined = (isStderr ? this._serverStderr : this._serverStdout) + text;
        const lines = combined.split(/\r?\n/);
        const remainder = lines.pop() || "";

        if (isStderr) {
            this._serverStderr = remainder;
        } else {
            this._serverStdout = remainder;
        }

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (isStderr) {
                console.error(`[scrcpy-server ${this.serial} ERROR]`, trimmed);
            } else {
                console.log(`[scrcpy-server ${this.serial}]`, trimmed);
            }
            this._parseNewDisplayId(trimmed);
        }

        if (remainder.trim()) {
            this._parseNewDisplayId(remainder.trim());
        }
    }

    _startServerProcess(options = {}) {
        const audioEnabled = this._isAudioEnabled(options);
        const args = [
            "-s", this.serial,
            "shell",
            `CLASSPATH=${DEVICE_SERVER_PATH}`,
            "app_process",
            "/",
            "com.genymobile.scrcpy.Server",
            "4.0",                          // version, doit matcher le jar poussé
            `scid=${this.scid}`,
            "log_level=info",
            `audio=${audioEnabled}`,
            "send_device_meta=true",
            "send_frame_meta=true",
            "send_dummy_byte=true",
            "send_stream_meta=true",
            "tunnel_forward=false",
            `video_bit_rate=${options.bitRate || 8000000}`,
            `max_fps=${options.maxFps || 60}`,
            `max_size=${options.maxSize || 1920}`,
            `video_codec_options=i-frame-interval=${options.iFrameInterval || 1}`
        ];
        if (options.videoCodec === "h265") args.push("video_codec=h265");

        if (options.control === false) {
            args.push("control=false");
        }

        if (options.displayId !== undefined && options.displayId !== null) {
            args.push(`display_id=${options.displayId}`);
        } else if (options.newDisplay) {
            args.push(`new_display=${options.newDisplay}`);
        }

        // Orientation relative à l'orientation naturelle de l'appareil (voir stream-params.js).
        const lock = options.captureOrientationLock
            ?? resolveCaptureOrientationLock(
                options.orientation === "portrait" ? "portrait" : "landscape",
                options.deviceWidth,
                options.deviceHeight
            );
        if (lock) {
            args.push(`capture_orientation=${lock}`);
        }

        if (options.stayAwake) {
            args.push("stay_awake=true");
        }

        const spawnOptions = { windowsHide: true };
        if (process.platform === "win32") {
            spawnOptions.creationFlags = 0x08000000;
        }
        this.serverProcess = spawn(this.adbPath, args, spawnOptions);
        console.log(`[ScrcpySocketClient ${this.serial}] scrcpy-server args: audio=${audioEnabled}`, args.join(" "));
        this._serverStderr = "";
        this._serverStdout = "";

        this.serverProcess.stdout.on("data", (data) => {
            this._appendServerLogChunk(data, false);
        });

        this.serverProcess.stderr.on("data", (data) => {
            this._appendServerLogChunk(data, true);
        });

        this.serverProcess.on("exit", (code) => {
            console.log(`[scrcpy-server ${this.serial}] processus terminé, code ${code}`);
            this.emit("server-exit", { code, stderr: this._serverStderr });
            this.emit("closed");
        });
    }

    _connectSockets(options = {}) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutHandle = null;

            const finish = (err) => {
                if (settled) return;
                settled = true;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                server.close();
                if (err) reject(err);
                else resolve();
            };

            const onServerExit = ({ code, stderr }) => {
                finish(new Error(
                    `scrcpy-server interrompu (code ${code})${stderr ? `: ${stderr}` : ""}`
                ));
            };

            this.once("server-exit", onServerExit);

            const tryFinishIfReady = () => {
                if (this._areSocketsReady(options)) {
                    this.removeListener("server-exit", onServerExit);
                    finish();
                    return true;
                }
                return false;
            };

            const server = net.createServer((socket) => {
                const audioEnabled = this._isAudioEnabled(options);
                const controlEnabled = this._isControlEnabled(options);

                if (!audioEnabled) {
                    if (!this.videoSocket) {
                        console.log(`[ScrcpySocketClient] Connexion vidéo (#1) pour ${this.serial}`);
                        this.videoSocket = socket;
                        this._attachVideoListeners();
                    } else if (controlEnabled && !this.controlSocket) {
                        this._assignControlSocket(socket, tryFinishIfReady);
                        return;
                    } else {
                        console.log(
                            `[ScrcpySocketClient] Connexion superflue (#${this._incomingCount + 1}) pour ${this.serial}, fermeture.`
                        );
                        socket.destroy();
                        return;
                    }
                    tryFinishIfReady();
                    return;
                }

                this._incomingCount += 1;
                const socketIndex = this._incomingCount;

                if (socketIndex === 1) {
                    console.log(`[ScrcpySocketClient] Connexion vidéo (#1) pour ${this.serial}`);
                    this.videoSocket = socket;
                    this._attachVideoListeners();
                } else if (socketIndex === 2 && audioEnabled) {
                    this._assignAudioSocket(socket, tryFinishIfReady);
                    return;
                } else if (socketIndex === 2 && !audioEnabled && controlEnabled) {
                    this._assignControlSocket(socket, tryFinishIfReady);
                    return;
                } else if (socketIndex === 3 && audioEnabled && controlEnabled) {
                    this._assignControlSocket(socket, tryFinishIfReady);
                    return;
                } else if (controlEnabled && !this.controlSocket) {
                    this._assignControlSocket(socket, tryFinishIfReady);
                    return;
                } else {
                    console.log(
                        `[ScrcpySocketClient] Connexion #${socketIndex} superflue pour ${this.serial}, fermeture.`
                    );
                    socket.destroy();
                    return;
                }

                tryFinishIfReady();
            });

            server.on("error", (err) => {
                this.removeListener("server-exit", onServerExit);
                finish(err);
            });

            server.listen(this.localPort, "127.0.0.1", () => {
                console.log(`[ScrcpySocketClient] En attente de connexion sur le port ${this.localPort}...`);
            });

            timeoutHandle = setTimeout(() => {
                if (this.videoSocket && this.controlSocket) {
                    if (!this.audioSocket && !this._audioDisabledOnDevice && this._isAudioEnabled(options)) {
                        console.warn(`[ScrcpySocketClient] Audio indisponible pour ${this.serial}, poursuite sans audio.`);
                    }
                    this.removeListener("server-exit", onServerExit);
                    this._clearSocket2FallbackTimer();
                    finish();
                    return;
                }
                if (this.videoSocket && !this.controlSocket && this.audioSocket && this._isAudioEnabled(options)) {
                    if (this._audioStreamActive && !this._controlWaitExtended) {
                        this._controlWaitExtended = true;
                        console.warn(
                            `[ScrcpySocketClient] Audio actif, attente supplémentaire du socket contrôle pour ${this.serial}...`
                        );
                        timeoutHandle = setTimeout(() => {
                            timeoutHandle = null;
                            if (this.videoSocket && this.controlSocket) {
                                this.removeListener("server-exit", onServerExit);
                                this._clearSocket2FallbackTimer();
                                finish();
                                return;
                            }
                            if (this.videoSocket && !this.controlSocket && this.audioSocket && !this._audioStreamActive) {
                                const audioSocket = this.audioSocket;
                                audioSocket.removeAllListeners("data");
                                audioSocket.removeAllListeners("error");
                                audioSocket.removeAllListeners("close");
                                this.audioSocket = null;
                                this.controlSocket = audioSocket;
                                this._controlFromSocket2Fallback = true;
                                this._attachControlListeners();
                                this.removeListener("server-exit", onServerExit);
                                this._clearSocket2FallbackTimer();
                                finish();
                                return;
                            }
                            this.removeListener("server-exit", onServerExit);
                            this._clearSocket2FallbackTimer();
                            finish(new Error("Timeout : socket contrôle scrcpy non reçu."));
                        }, 15000);
                        return;
                    }
                    if (this._audioStreamActive) {
                        this.removeListener("server-exit", onServerExit);
                        this._clearSocket2FallbackTimer();
                        finish(new Error("Timeout : socket contrôle scrcpy non reçu (audio actif)."));
                        return;
                    }
                    const audioSocket = this.audioSocket;
                    audioSocket.removeAllListeners("data");
                    audioSocket.removeAllListeners("error");
                    audioSocket.removeAllListeners("close");
                    this.audioSocket = null;
                    this.controlSocket = audioSocket;
                    this._controlFromSocket2Fallback = true;
                    this._attachControlListeners();
                    this.removeListener("server-exit", onServerExit);
                    this._clearSocket2FallbackTimer();
                    finish();
                    return;
                }
                this.removeListener("server-exit", onServerExit);
                this._clearSocket2FallbackTimer();
                finish(new Error("Timeout : le serveur scrcpy ne s'est pas connecté à temps."));
            }, 12000);
        });
    }

    _attachVideoListeners() {
    let buffer = Buffer.alloc(0);
    let deviceNameConsumed = false;
    let codecIdConsumed = false;
    let codecId = null;
    const DEVICE_NAME_FIELD_LENGTH = 64;
    const CODEC_ID_LENGTH = 4;

    this.videoSocket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (!deviceNameConsumed) {
            if (buffer.length < DEVICE_NAME_FIELD_LENGTH) return;

            const deviceName = buffer
                .slice(0, DEVICE_NAME_FIELD_LENGTH)
                .toString("utf-8")
                .replace(/\0/g, "")
                .trim();

            console.log(`[ScrcpySocketClient] Device: "${deviceName}"`);

            buffer = buffer.slice(DEVICE_NAME_FIELD_LENGTH);
            deviceNameConsumed = true;
            this.emit("connected", { deviceName });
        }

        if (deviceNameConsumed && !codecIdConsumed) {
            if (buffer.length < CODEC_ID_LENGTH) return;

            codecId = buffer.slice(0, CODEC_ID_LENGTH).toString("utf-8").replace(/\0/g, "");
            console.log(`[ScrcpySocketClient] Codec: ${codecId}`);

            buffer = buffer.slice(CODEC_ID_LENGTH);
            codecIdConsumed = true;
        }

        if (codecIdConsumed) {
            buffer = this._extractPackets(buffer, codecId);
        }
    });

    this.videoSocket.on("error", (err) => {
        console.error(`[ScrcpySocketClient] Erreur socket vidéo:`, err.message);
        this.emit("error", err);
    });

    this.videoSocket.on("close", () => {
        console.log(`[ScrcpySocketClient] Socket vidéo fermé pour ${this.serial}`);
        this.emit("closed");
    });
}

    _attachControlListeners() {
        if (!this.controlSocket) return;

        this.controlSocket.on("error", (err) => {
            console.error(`[ScrcpySocketClient] Erreur socket contrôle:`, err.message);
            this.emit("error", err);
        });

        this.controlSocket.on("close", () => {
            console.log(`[ScrcpySocketClient] Socket contrôle fermée pour ${this.serial}`);
            this.controlSocket = null;
        });
    }

    _attachAudioListeners({ codecId = null, initialBuffer = Buffer.alloc(0), tryFinishIfReady = null } = {}) {
        if (!this.audioSocket) return;

        let buffer = Buffer.from(initialBuffer);
        let codecIdConsumed = Boolean(codecId);
        let audioPacketCount = 0;
        const CODEC_ID_LENGTH = 4;
        const HEADER_SIZE = 12;

        if (codecId) {
            console.log(`[ScrcpySocketClient] Audio codec: ${codecId}`);
            this.emit("audio-codec-meta", { codecId });
            if (buffer.length >= CODEC_ID_LENGTH) {
                buffer = buffer.slice(CODEC_ID_LENGTH);
            }
        }

        this.audioSocket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            if (!codecIdConsumed) {
                if (buffer.length < CODEC_ID_LENGTH) return;

                const codecHead = buffer.slice(0, CODEC_ID_LENGTH);
                if (
                    codecHead[0] === 0
                    && codecHead[1] === 0
                    && codecHead[2] === 0
                    && codecHead[3] === 0
                ) {
                    codecIdConsumed = true;
                    this._audioDisabledOnDevice = true;
                    this._clearSocket2FallbackTimer();
                    console.warn(
                        `[ScrcpySocketClient] Audio désactivé côté appareil pour ${this.serial} (Android 11+ requis)`
                    );
                    const disabledSocket = this.audioSocket;
                    this.audioSocket = null;
                    disabledSocket.removeAllListeners("data");
                    disabledSocket.removeAllListeners("error");
                    disabledSocket.removeAllListeners("close");
                    if (!this.controlSocket) {
                        console.log(
                            `[ScrcpySocketClient] Socket #2 → contrôle (audio absent sur appareil) pour ${this.serial}`
                        );
                        this.controlSocket = disabledSocket;
                        this._controlFromSocket2Fallback = true;
                        this._attachControlListeners();
                        if (typeof tryFinishIfReady === "function") {
                            tryFinishIfReady();
                        }
                    } else {
                        disabledSocket.destroy();
                    }
                    return;
                }

                const detectedCodec = codecHead.toString("utf-8").replace(/\0/g, "");
                if (!["opus", "aac", "flac", "raw"].includes(detectedCodec)) {
                    return;
                }

                buffer = buffer.slice(CODEC_ID_LENGTH);
                codecIdConsumed = true;
                this._audioStreamActive = true;
                this._clearSocket2FallbackTimer();
                console.log(`[ScrcpySocketClient] Audio codec: ${detectedCodec}`);
                this.emit("audio-codec-meta", { codecId: detectedCodec });
            }

            while (buffer.length >= HEADER_SIZE) {
                const ptsAndFlags = buffer.readBigUInt64BE(0);
                const packetSize = buffer.readUInt32BE(8);
                if (buffer.length < HEADER_SIZE + packetSize) break;

                const isConfig = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n;
                const isKeyFrame = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
                const pts = ptsAndFlags & PACKET_PTS_MASK;
                const payload = buffer.slice(HEADER_SIZE, HEADER_SIZE + packetSize);
                buffer = buffer.slice(HEADER_SIZE + packetSize);

                audioPacketCount += 1;
                this._audioStreamActive = true;
                if (audioPacketCount === 1 || audioPacketCount % 200 === 0) {
                    console.log(`[ScrcpySocketClient] Audio packet #${audioPacketCount} (${this.serial}) config=${isConfig} size=${packetSize}`);
                }

                this.emit("raw-audio-packet", {
                    pts,
                    isConfig,
                    isKeyFrame,
                    data: payload
                });
            }
        });

        this.audioSocket.on("error", (err) => {
            console.error(`[ScrcpySocketClient] Erreur socket audio:`, err.message);
            this.emit("error", err);
        });

        this.audioSocket.on("close", () => {
            console.log(`[ScrcpySocketClient] Socket audio fermée pour ${this.serial}`);
        });
    }

    sendControlMessage(buffer) {
        if (!this.controlSocket) {
            throw new Error("Contrôle scrcpy non connecté");
        }
        return new Promise((resolve, reject) => {
            this.controlSocket.write(buffer, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async setDisplayPower(on) {
        const buffer = Buffer.alloc(2);
        buffer.writeUInt8(SC_CONTROL_MSG_TYPE_SET_DISPLAY_POWER, 0);
        buffer.writeUInt8(on ? 1 : 0, 1);
        await this.sendControlMessage(buffer);
    }

    async sendTap(x, y, screenWidth, screenHeight, buttonMask = 1) {
        await this.sendTouchEvent(AMOTION_EVENT_ACTION_DOWN, x, y, screenWidth, screenHeight, buttonMask);
        return this.sendTouchEvent(AMOTION_EVENT_ACTION_UP, x, y, screenWidth, screenHeight, buttonMask);
    }

    async sendKeyCode(action, keycode, repeat = 0, metastate = 0) {
        const msg = {
            type: SC_CONTROL_MSG_TYPE_INJECT_KEYCODE,
            action,
            keycode,
            repeat,
            metastate
        };
        const payload = this._serializeControlMessage(msg);
        return this.sendControlMessage(payload);
    }

    /** Injection UTF-8 (accents, §, symboles) — protocole scrcpy INJECT_TEXT. */
    async sendInjectText(text) {
        if (!this.controlSocket) {
            throw new Error("Contrôle scrcpy non connecté");
        }
        const value = String(text ?? "");
        const utf8 = Buffer.from(value, "utf8");
        const maxLen = 300;
        if (utf8.length === 0) {
            return;
        }
        if (utf8.length > maxLen) {
            throw new Error(`Texte trop long (${utf8.length} > ${maxLen})`);
        }

        const buffer = Buffer.alloc(1 + 4 + utf8.length);
        buffer.writeUInt8(SC_CONTROL_MSG_TYPE_INJECT_TEXT, 0);
        buffer.writeUInt32BE(utf8.length, 1);
        utf8.copy(buffer, 5);
        return this.sendControlMessage(buffer);
    }

    _serializeControlMessage(msg) {
        const buffer = Buffer.alloc(32);
        buffer[0] = msg.type;

        switch (msg.type) {
            case SC_CONTROL_MSG_TYPE_INJECT_KEYCODE:
                buffer[1] = msg.action;
                buffer.writeUInt32BE(msg.keycode, 2);
                buffer.writeUInt32BE(msg.repeat || 0, 6);
                buffer.writeUInt32BE(msg.metastate || 0, 10);
                return buffer.slice(0, 14);
            case SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT:
                buffer[1] = msg.action;
                buffer.writeBigUInt64BE(msg.pointer_id, 2);
                buffer.writeInt32BE(msg.position.x, 10);
                buffer.writeInt32BE(msg.position.y, 14);
                buffer.writeUInt16BE(msg.position.screen_size_width, 18);
                buffer.writeUInt16BE(msg.position.screen_size_height, 20);
                buffer.writeUInt16BE(Math.round(msg.pressure * 65535), 22);
                buffer.writeUInt32BE(msg.action_button || 0, 24);
                buffer.writeUInt32BE(msg.buttons || 0, 28);
                return buffer.slice(0, 32);
            case SC_CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT:
                buffer.writeInt32BE(msg.position.x, 1);
                buffer.writeInt32BE(msg.position.y, 5);
                buffer.writeUInt16BE(msg.position.screen_size_width, 9);
                buffer.writeUInt16BE(msg.position.screen_size_height, 11);
                const hscrollNorm = Math.max(-1, Math.min(1, msg.hscroll / 16));
                const vscrollNorm = Math.max(-1, Math.min(1, msg.vscroll / 16));
                buffer.writeInt16BE(Math.round(hscrollNorm * 32767), 13);
                buffer.writeInt16BE(Math.round(vscrollNorm * 32767), 15);
                buffer.writeUInt32BE(msg.buttons || 0, 17);
                return buffer.slice(0, 21);
            default:
                throw new Error(`Control message type unsupported: ${msg.type}`);
        }
    }

    async sendTouchEvent(action, x, y, screenWidth, screenHeight, buttonMask = 1) {
        const msg = {
            type: SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT,
            action,
            pointer_id: SC_POINTER_ID_GENERIC_FINGER,
            position: {
                x,
                y,
                screen_size_width: screenWidth,
                screen_size_height: screenHeight
            },
            pressure: 1.0,
            action_button: buttonMask,
            buttons: buttonMask
        };
        const payload = this._serializeControlMessage(msg);
        return this.sendControlMessage(payload);
    }

    async sendScrollEvent(x, y, hscroll, vscroll, screenWidth, screenHeight, buttons = 1) {
        const msg = {
            type: SC_CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT,
            position: { x, y, screen_size_width: screenWidth, screen_size_height: screenHeight },
            hscroll,
            vscroll,
            buttons
        };
        const payload = this._serializeControlMessage(msg);
        return this.sendControlMessage(payload);
    }

    _extractPackets(buffer, codecId) {
        const HEADER_SIZE = 12;

        while (buffer.length >= HEADER_SIZE) {
            const header = buffer.readBigUInt64BE(0);

            if ((header & PACKET_FLAG_SESSION) !== 0n) {
                const width = buffer.readUInt32BE(4);
                const height = buffer.readUInt32BE(8);

                console.log(`[ScrcpySocketClient] Session vidéo: ${width}x${height}`);
                this.videoStreamSize = { width, height };
                this.emit("codec-meta", { codecId, width, height });

                buffer = buffer.slice(HEADER_SIZE);
                continue;
            }

            const ptsAndFlags = buffer.readBigUInt64BE(0);
            const packetSize = buffer.readUInt32BE(8);

            if (buffer.length < HEADER_SIZE + packetSize) {
                // paquet pas encore complet, on attend plus de données
                break;
            }

            const isConfig = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n;
            const isKeyFrame = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
            const pts = ptsAndFlags & PACKET_PTS_MASK;

            const payload = buffer.slice(HEADER_SIZE, HEADER_SIZE + packetSize);

            this.emit("raw-packet", {
                pts: pts,
                isConfig,
                isKeyFrame,
                data: payload
            });

            buffer = buffer.slice(HEADER_SIZE + packetSize);
        }

        return buffer;
    }

    stop() {
        if (this.controlSocket) {
            this.controlSocket.destroy();
            this.controlSocket = null;
        }
        if (this.audioSocket) {
            this.audioSocket.destroy();
            this.audioSocket = null;
        }
        if (this.videoSocket) {
            this.videoSocket.destroy();
            this.videoSocket = null;
        }
        if (this.serverProcess) {
            this.serverProcess.kill();
            this.serverProcess = null;
        }
        exec(`"${this.adbPath}" -s ${this._quotedSerial()} reverse --remove localabstract:${this.socketName}`, { windowsHide: true });
    }

    /**
     * Rebind USB↔WiFi sur la même instance (même scid/socketName).
     * Non branché — prêt pour l'orchestration future.
     * @param {string} newSerial
     * @param {object} [options] — options scrcpy (+ `serverJarPath` requis pour le push)
     */
    async rebind(newSerial, options = {}) {
        const serverJarPath = options.serverJarPath;
        if (!serverJarPath) {
            throw new Error("[ScrcpySocketClient][rebind] options.serverJarPath requis");
        }
        if (!newSerial) {
            throw new Error("[ScrcpySocketClient][rebind] newSerial manquant");
        }

        const scrcpyOptions = { ...this._startOptions, ...options };
        delete scrcpyOptions.serverJarPath;

        const oldSerial = this.serial;
        console.log(
            `[ScrcpySocketClient][rebind] cleanup ancien serial=${oldSerial} → newSerial=${newSerial}`
        );

        // Cleanup sur l'ANCIEN serial (même logique que stop(), avant de basculer this.serial).
        if (this.controlSocket) {
            this.controlSocket.destroy();
            this.controlSocket = null;
        }
        if (this.audioSocket) {
            this.audioSocket.destroy();
            this.audioSocket = null;
        }
        if (this.videoSocket) {
            this.videoSocket.destroy();
            this.videoSocket = null;
        }
        if (this.serverProcess) {
            this.serverProcess.kill();
            this.serverProcess = null;
        }
        exec(
            `"${this.adbPath}" -s ${this._quotedSerial()} reverse --remove localabstract:${this.socketName}`,
            { windowsHide: true }
        );

        this.serial = newSerial;

        // Mêmes resets que start().
        this._startOptions = { ...scrcpyOptions };
        this._incomingCount = 0;
        this._audioDisabledOnDevice = false;
        this._audioStreamActive = false;
        this._controlFromSocket2Fallback = false;
        this._controlWaitExtended = false;
        this.videoStreamSize = null;
        this._clearSocket2FallbackTimer();

        console.log(
            `[ScrcpySocketClient][rebind] relaunch push/tunnel/server/sockets sur ${this.serial}`
        );
        await this._pushServer(serverJarPath);
        await this._setupTunnel();
        this._startServerProcess(scrcpyOptions);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await this._connectSockets(scrcpyOptions);
        console.log(`[ScrcpySocketClient][rebind] terminé pour ${this.serial}`);
    }

    getNewDisplayId() {
        return Number.isInteger(this.newDisplayId) ? this.newDisplayId : null;
    }

    getConnectionState() {
        return {
            incomingCount: this._incomingCount,
            hasVideo: Boolean(this.videoSocket),
            hasAudio: Boolean(this.audioSocket),
            hasControl: Boolean(this.controlSocket),
            controlFromFallback: Boolean(this._controlFromSocket2Fallback),
            audioDisabled: Boolean(this._audioDisabledOnDevice),
            audioStreamActive: Boolean(this._audioStreamActive)
        };
    }
}

module.exports = { ScrcpySocketClient };