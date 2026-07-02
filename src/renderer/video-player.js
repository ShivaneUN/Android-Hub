/**
 * video-player.js
 *
 * Pipeline video:
 * IPC H.264 packets -> WebCodecs VideoDecoder -> Canvas.
 */

function createVideoPlayer(tabId, canvasElement) {
    const ctx = canvasElement.getContext("2d");

    const MAX_PACKET_QUEUE = 240;
    const SYNTHETIC_FRAME_US = 16667;

    const state = {
        started: false,
        frameCount: 0,
        decoder: null,
        decoderReady: false,
        decoderInitializing: false,
        codecMeta: null,
        pendingConfigData: null,
        packetQueue: [],
        streamFormat: "annexb",
        configuredStreamFormat: null,
        firstPts: null,
        lastTimestampUs: -1,
        syntheticTimestampUs: 0,
        firstFrameWatchdog: null,
        recoveryAttempted: false,
        serial: null,
        packageName: null,
        startOptions: {}
    };

    function resetRuntime() {
        if (state.firstFrameWatchdog) {
            clearTimeout(state.firstFrameWatchdog);
            state.firstFrameWatchdog = null;
        }

        if (state.decoder && state.decoder.state !== "closed") {
            state.decoder.close();
        }

        state.decoder = null;
        state.decoderReady = false;
        state.decoderInitializing = false;
        state.codecMeta = null;
        state.pendingConfigData = null;
        state.packetQueue.length = 0;
        state.streamFormat = "annexb";
        state.configuredStreamFormat = null;
        state.firstPts = null;
        state.lastTimestampUs = -1;
        state.syntheticTimestampUs = 0;
    }

    async function recoverFromBlackScreen() {
        if (!state.started || state.frameCount > 0 || state.recoveryAttempted) return;
        if (!state.serial) return;

        state.recoveryAttempted = true;

        const safeOptions = {
            ...state.startOptions,
            openScrcpyWindow: false,
            captureCompanionDisplay: false,
            newDisplay: state.startOptions.newDisplay || "1920x1080",
            startApp: state.startOptions.startApp || state.packageName,
            displayId: undefined,
            skipPackageLaunch: false
        };

        try {
            console.warn(`[VideoPlayer ${tabId}] Aucune frame rendue, redemarrage en mode safe.`);
            window.dispatchEvent(new CustomEvent("video:recovery", {
                detail: { tabId, reason: "no-first-frame" }
            }));

            await window.electronAPI.stopVideoStream(tabId);
            resetRuntime();

            const retry = await window.electronAPI.startVideoStream(
                state.serial,
                tabId,
                state.packageName,
                safeOptions
            );

            if (!retry?.success) {
                console.error(`[VideoPlayer ${tabId}] Echec reprise safe:`, retry?.error || "inconnu");
            }
        } catch (err) {
            console.error(`[VideoPlayer ${tabId}] Erreur reprise safe:`, err);
        }
    }

    function armFirstFrameWatchdog() {
        if (state.firstFrameWatchdog) {
            clearTimeout(state.firstFrameWatchdog);
        }

        state.firstFrameWatchdog = setTimeout(() => {
            state.firstFrameWatchdog = null;
            recoverFromBlackScreen();
        }, 8000);
    }

    function ensureCanvasSize(width, height) {
        if (canvasElement.width === width && canvasElement.height === height) return;
        canvasElement.width = width;
        canvasElement.height = height;
    }

    function getCodecCandidates(codecId) {
        if (codecId === "h264") {
            return ["avc1.640034", "avc1.4D4028", "avc1.42E01E"];
        }
        if (codecId === "h265" || codecId === "hevc") {
            return ["hev1.1.6.L93.B0", "hvc1.1.6.L93.B0"];
        }
        return ["avc1.640034", "avc1.42E01E"];
    }

    function detectH264StreamFormat(configData) {
        if (!configData || configData.length < 4) return "annexb";

        const b0 = configData[0];
        const b1 = configData[1];
        const b2 = configData[2];
        const b3 = configData[3];

        if ((b0 === 0x00 && b1 === 0x00 && b2 === 0x01) || (b0 === 0x00 && b1 === 0x00 && b2 === 0x00 && b3 === 0x01)) {
            return "annexb";
        }

        if (b0 === 0x01) {
            return "avc";
        }

        return "annexb";
    }

    async function selectDecoderConfig(meta, h264Format = "annexb", avcDescription = null) {
        const candidates = getCodecCandidates(meta.codecId);
        const base = {
            codedWidth: meta.width,
            codedHeight: meta.height,
            optimizeForLatency: true
        };

        for (const codec of candidates) {
            const config = { ...base, codec };

            if (meta.codecId === "h264") {
                config.avc = { format: h264Format };
                if (h264Format === "avc" && avcDescription && avcDescription.length > 0) {
                    config.description = avcDescription;
                }
            }

            try {
                if (typeof VideoDecoder.isConfigSupported === "function") {
                    const support = await VideoDecoder.isConfigSupported(config);
                    if (!support?.supported) {
                        continue;
                    }
                }
                return config;
            } catch (_err) {
                // Try next candidate.
            }
        }

        const fallback = { ...base, codec: candidates[0] };
        if (meta.codecId === "h264") {
            fallback.avc = { format: h264Format };
            if (h264Format === "avc" && avcDescription && avcDescription.length > 0) {
                fallback.description = avcDescription;
            }
        }
        return fallback;
    }

    function normalizeBinary(data) {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
        return null;
    }

    function nextSyntheticTimestamp() {
        state.syntheticTimestampUs += SYNTHETIC_FRAME_US;
        if (state.syntheticTimestampUs <= state.lastTimestampUs) {
            state.syntheticTimestampUs = state.lastTimestampUs + SYNTHETIC_FRAME_US;
        }
        state.lastTimestampUs = state.syntheticTimestampUs;
        return state.syntheticTimestampUs;
    }

    function toTimestampUs(rawPts) {
        if (rawPts === undefined || rawPts === null) {
            return nextSyntheticTimestamp();
        }

        try {
            const pts = BigInt(rawPts);
            if (state.firstPts === null) {
                state.firstPts = pts;
            }

            let delta = pts - state.firstPts;
            if (delta < 0n) delta = 0n;

            const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
            if (delta > maxSafe) {
                return nextSyntheticTimestamp();
            }

            let ts = Number(delta);
            if (!Number.isFinite(ts)) {
                return nextSyntheticTimestamp();
            }

            if (ts <= state.lastTimestampUs) {
                ts = state.lastTimestampUs + 1;
            }

            state.lastTimestampUs = ts;
            state.syntheticTimestampUs = ts;
            return ts;
        } catch (_err) {
            return nextSyntheticTimestamp();
        }
    }

    function enqueuePacket(packet) {
        state.packetQueue.push(packet);
        if (state.packetQueue.length > MAX_PACKET_QUEUE) {
            state.packetQueue.shift();
        }
    }

    async function configureDecoder(meta, format = "annexb", avcDescription = null) {
        const decoderConfig = await selectDecoderConfig(meta, format, avcDescription);

        state.decoder = new VideoDecoder({
            output: (frame) => {
                ctx.drawImage(frame, 0, 0, canvasElement.width, canvasElement.height);
                frame.close();
                state.frameCount += 1;

                if (state.frameCount === 1) {
                    if (state.firstFrameWatchdog) {
                        clearTimeout(state.firstFrameWatchdog);
                        state.firstFrameWatchdog = null;
                    }
                    window.dispatchEvent(new CustomEvent("video:first-frame", {
                        detail: { tabId }
                    }));
                }
            },
            error: (err) => {
                console.error(`[VideoPlayer ${tabId}] Erreur decodeur:`, err);
            }
        });

        state.decoder.configure(decoderConfig);
        state.decoderReady = true;
        state.configuredStreamFormat = format;
    }

    async function reconfigureForStreamFormatIfNeeded() {
        if (!state.codecMeta) return;
        if (state.streamFormat === state.configuredStreamFormat) return;
        if (state.decoderInitializing) return;

        state.decoderInitializing = true;

        try {
            const avcDescription = state.streamFormat === "avc" ? state.pendingConfigData : null;

            if (state.decoder && state.decoder.state !== "closed") {
                state.decoder.close();
            }
            state.decoder = null;
            state.decoderReady = false;

            await configureDecoder(state.codecMeta, state.streamFormat, avcDescription);
            flushQueue();
        } catch (err) {
            console.error(`[VideoPlayer ${tabId}] Echec reconfiguration decodeur (${state.streamFormat}):`, err);
        } finally {
            state.decoderInitializing = false;
        }
    }

    function decodePacket(packet) {
        if (!state.decoder || state.decoder.state === "closed" || !state.decoderReady) return;

        try {
            if (packet.isConfig) {
                const configData = normalizeBinary(packet.data);
                if (configData && configData.length > 0) {
                    state.pendingConfigData = configData;

                    const detectedFormat = detectH264StreamFormat(configData);
                    if (detectedFormat !== state.streamFormat) {
                        state.streamFormat = detectedFormat;
                        void reconfigureForStreamFormatIfNeeded();
                    }
                }
                return;
            }

            const payload = normalizeBinary(packet.data);
            if (!payload || payload.length === 0) return;

            let chunkData = payload;
            if (state.streamFormat === "annexb" && packet.isKeyFrame && state.pendingConfigData) {
                const merged = new Uint8Array(state.pendingConfigData.length + payload.length);
                merged.set(state.pendingConfigData, 0);
                merged.set(payload, state.pendingConfigData.length);
                chunkData = merged;
                state.pendingConfigData = null;
            }

            const chunk = new EncodedVideoChunk({
                type: packet.isKeyFrame ? "key" : "delta",
                timestamp: toTimestampUs(packet.pts),
                data: chunkData
            });

            state.decoder.decode(chunk);
        } catch (err) {
            console.error(`[VideoPlayer ${tabId}] Erreur decode chunk:`, err);
        }
    }

    function flushQueue() {
        if (!state.decoder || state.decoder.state === "closed" || !state.decoderReady) return;

        while (state.packetQueue.length > 0) {
            const packet = state.packetQueue.shift();
            decodePacket(packet);
            if (!state.decoder || state.decoder.state === "closed") break;
        }
    }

    async function initDecoder(meta) {
        if (state.decoder || state.decoderInitializing) return;

        state.decoderInitializing = true;
        state.codecMeta = meta;
        ensureCanvasSize(meta.width, meta.height);

        try {
            await configureDecoder(meta, state.streamFormat, null);
            flushQueue();
        } catch (err) {
            console.error(`[VideoPlayer ${tabId}] Echec init decodeur:`, err);
        } finally {
            state.decoderInitializing = false;
        }
    }

    async function onCodecMeta(eventData) {
        if (eventData.tabId !== tabId) return;
        await initDecoder(eventData);
    }

    function onVideoPacket(eventData) {
        if (eventData.tabId !== tabId) return;

        if (!state.decoderReady || !state.decoder || state.decoder.state === "closed" || state.decoderInitializing) {
            enqueuePacket(eventData);
            return;
        }

        decodePacket(eventData);
    }

    function onVideoError(eventData) {
        if (eventData.tabId !== tabId) return;
        console.error(`[VideoPlayer ${tabId}] Erreur stream:`, eventData.error);
    }

    window.electronAPI.onVideoCodecMeta(onCodecMeta);
    window.electronAPI.onVideoPacket(onVideoPacket);
    window.electronAPI.onVideoError(onVideoError);

    return {
        async start(serial, packageName, options = {}) {
            if (state.started) return;

            state.started = true;
            state.recoveryAttempted = false;
            state.serial = serial;
            state.packageName = packageName;
            state.startOptions = { ...options };
            state.frameCount = 0;
            armFirstFrameWatchdog();

            if (typeof window.VideoDecoder === "undefined" || typeof window.EncodedVideoChunk === "undefined") {
                const result = { success: false, error: "WebCodecs non disponible dans ce runtime" };
                console.error(`[VideoPlayer ${tabId}]`, result.error);
                state.started = false;
                return result;
            }

            const result = await window.electronAPI.startVideoStream(serial, tabId, packageName, options);
            if (!result.success) {
                console.error(`[VideoPlayer ${tabId}] Echec demarrage stream:`, result.error);
                state.started = false;
                if (state.firstFrameWatchdog) {
                    clearTimeout(state.firstFrameWatchdog);
                    state.firstFrameWatchdog = null;
                }
            }
            return result;
        },

        async stop() {
            if (!state.started) return;
            state.started = false;

            await window.electronAPI.stopVideoStream(tabId);
            resetRuntime();
        },

        getFrameCount() {
            return state.frameCount;
        }
    };
}
