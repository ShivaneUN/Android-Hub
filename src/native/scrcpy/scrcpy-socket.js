const net = require("net");
const { exec, spawn } = require("child_process");
const EventEmitter = require("events");

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
        this.controlSocket = null;
        this.serverProcess = null;
        this.newDisplayId = null;
    }

    /**
     * Lance scrcpy-server sur le téléphone et se connecte aux flux vidéo et contrôle.
     * serverJarPath : chemin local vers le fichier scrcpy-server (sur le PC) à pousser sur le device.
     */
    async start(serverJarPath, options = {}) {
        await this._pushServer(serverJarPath);
        await this._setupTunnel();
        this._startServerProcess(options);
        await this._connectSockets(options);
    }

    _runAdb(args) {
        return new Promise((resolve, reject) => {
            exec(`"${this.adbPath}" -s ${this.serial} ${args}`, { windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
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
        // Reverse tunnel : le téléphone se connecte vers nous (recommandé par le protocole)
        // adb reverse localabstract:scrcpy_<scid> tcp:<port>
        this.localPort = await this._findFreePort();

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

    _startServerProcess(options = {}) {
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
            "audio=false",
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

        if (options.control === false) {
            args.push("control=false");
        }

        if (options.displayId !== undefined && options.displayId !== null) {
            args.push(`display_id=${options.displayId}`);
        }

        if (options.newDisplay) {
            args.push(`new_display=${options.newDisplay}`);
        }

        if (options.orientation === 'landscape') {
            args.push('capture_orientation=@90');
        } else if (options.orientation === 'portrait') {
            args.push('capture_orientation=@0');
        }

        this.serverProcess = spawn(this.adbPath, args, { windowsHide: true });

        this.serverProcess.stdout.on("data", (data) => {
            const text = data.toString();
            const line = text.trim();
            console.log(`[scrcpy-server ${this.serial}]`, line);

            const match = line.match(/New display:.*\(id=(\d+)\)/);
            if (match) {
                this.newDisplayId = Number(match[1]);
                this.emit("new-display-id", { displayId: this.newDisplayId });
            }
        });

        this.serverProcess.stderr.on("data", (data) => {
            console.error(`[scrcpy-server ${this.serial} ERROR]`, data.toString().trim());
        });

        this.serverProcess.on("exit", (code) => {
            console.log(`[scrcpy-server ${this.serial}] processus terminé, code ${code}`);
            this.emit("closed");
        });
    }

    _connectSockets(options = {}) {
        return new Promise((resolve, reject) => {
            // On écoute en local sur le port choisi : le téléphone va s'y connecter (reverse tunnel)
            const server = net.createServer((socket) => {
                if (!this.videoSocket) {
                    console.log(`[ScrcpySocketClient] Connexion vidéo reçue pour ${this.serial}`);
                    this.videoSocket = socket;
                    this._attachVideoListeners();
                } else if (!this.controlSocket) {
                    console.log(`[ScrcpySocketClient] Connexion contrôle reçue pour ${this.serial}`);
                    this.controlSocket = socket;
                    this._attachControlListeners();
                } else {
                    console.log(`[ScrcpySocketClient] Connexion supplémentaire reçue pour ${this.serial}, fermeture.`);
                    socket.destroy();
                    return;
                }

                if (this.videoSocket && this.controlSocket) {
                    server.close();
                    resolve();
                }

                if (this.videoSocket && options.control === false) {
                    server.close();
                    resolve();
                }
            });

            server.on("error", (err) => {
                reject(err);
            });

            server.listen(this.localPort, "127.0.0.1", () => {
                console.log(`[ScrcpySocketClient] En attente de connexion sur le port ${this.localPort}...`);
            });

            // Timeout de sécurité si le téléphone ne se connecte jamais
            setTimeout(() => {
                if (!this.videoSocket || !this.controlSocket) {
                    server.close();
                    reject(new Error("Timeout : le serveur scrcpy ne s'est pas connecté à temps."));
                }
            }, 8000);
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
        if (this.videoSocket) {
            this.videoSocket.destroy();
            this.videoSocket = null;
        }
        if (this.serverProcess) {
            this.serverProcess.kill();
            this.serverProcess = null;
        }
        // Nettoyage du tunnel adb (best-effort, sans bloquer)
        exec(`"${this.adbPath}" -s ${this.serial} reverse --remove localabstract:${this.socketName}`, { windowsHide: true });
    }

    getNewDisplayId() {
        return Number.isInteger(this.newDisplayId) ? this.newDisplayId : null;
    }
}

module.exports = { ScrcpySocketClient };