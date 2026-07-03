const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId");
const type = params.get("type");
const deviceId = params.get("deviceId") || "";
const canvas = document.getElementById("video-canvas");

const KEYCODE_MAP = {
    Enter: true,
    Backspace: true,
    Escape: true,
    Tab: true,
    ArrowUp: true,
    ArrowDown: true,
    ArrowLeft: true,
    ArrowRight: true,
    Home: true,
    Back: true,
    Menu: true,
    Delete: true,
    VolumeUp: true,
    VolumeDown: true,
    Power: true
};

function attachRightClickBackHandler(canvasEl, sendBackKey) {
    if (!canvasEl || typeof sendBackKey !== "function") return;

    canvasEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void sendBackKey();
    });
}

function normalizePointerPosition(canvasEl, event) {
    const rect = canvasEl.getBoundingClientRect();
    const localX = typeof event.offsetX === "number" ? event.offsetX : event.clientX - rect.left;
    const localY = typeof event.offsetY === "number" ? event.offsetY : event.clientY - rect.top;

    const renderedWidth = rect.width;
    const renderedHeight = rect.height;
    const streamX = Math.round(localX * (canvasEl.width / renderedWidth));
    const streamY = Math.round(localY * (canvasEl.height / renderedHeight));

    return {
        streamX: Math.min(Math.max(streamX, 0), canvasEl.width - 1),
        streamY: Math.min(Math.max(streamY, 0), canvasEl.height - 1),
        canvasWidth: canvasEl.width,
        canvasHeight: canvasEl.height
    };
}

function initTypeAVideoPlayer(tabId, canvasElement) {
    const ctx = canvasElement.getContext("2d");
    const MAX_PACKET_QUEUE = 240;
    const SYNTHETIC_FRAME_US = 16667;

    const state = {
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
        syntheticTimestampUs: 0
    };

    function ensureCanvasSize(width, height) {
        if (canvasElement.width === width && canvasElement.height === height) return;
        canvasElement.width = width;
        canvasElement.height = height;
    }

    function getCodecCandidates(codecId) {
        if (codecId === "h264") return ["avc1.640034", "avc1.4D4028", "avc1.42E01E"];
        if (codecId === "h265" || codecId === "hevc") return ["hev1.1.6.L93.B0", "hvc1.1.6.L93.B0"];
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
        if (b0 === 0x01) return "avc";
        return "annexb";
    }

    async function selectDecoderConfig(meta, h264Format = "annexb", avcDescription = null) {
        const candidates = getCodecCandidates(meta.codecId);
        const base = { codedWidth: meta.width, codedHeight: meta.height, optimizeForLatency: true };

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
                    if (!support?.supported) continue;
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
        if (rawPts === undefined || rawPts === null) return nextSyntheticTimestamp();
        try {
            const pts = BigInt(rawPts);
            if (state.firstPts === null) state.firstPts = pts;
            let delta = pts - state.firstPts;
            if (delta < 0n) delta = 0n;
            const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
            if (delta > maxSafe) return nextSyntheticTimestamp();
            let ts = Number(delta);
            if (!Number.isFinite(ts)) return nextSyntheticTimestamp();
            if (ts <= state.lastTimestampUs) ts = state.lastTimestampUs + 1;
            state.lastTimestampUs = ts;
            state.syntheticTimestampUs = ts;
            return ts;
        } catch (_err) {
            return nextSyntheticTimestamp();
        }
    }

    function enqueuePacket(packet) {
        state.packetQueue.push(packet);
        if (state.packetQueue.length > MAX_PACKET_QUEUE) state.packetQueue.shift();
    }

    async function configureDecoder(meta, format = "annexb", avcDescription = null) {
        const decoderConfig = await selectDecoderConfig(meta, format, avcDescription);
        state.decoder = new VideoDecoder({
            output: (frame) => {
                ctx.drawImage(frame, 0, 0, canvasElement.width, canvasElement.height);
                frame.close();
                state.frameCount += 1;
            },
            error: (err) => {
                console.error(`[SessionView ${tabId}] Erreur decodeur:`, err);
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
            if (state.decoder && state.decoder.state !== "closed") state.decoder.close();
            state.decoder = null;
            state.decoderReady = false;
            await configureDecoder(state.codecMeta, state.streamFormat, avcDescription);
            flushQueue();
        } catch (err) {
            console.error(`[SessionView ${tabId}] Echec reconfiguration decodeur:`, err);
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
            console.error(`[SessionView ${tabId}] Erreur decode chunk:`, err);
        }
    }

    function flushQueue() {
        if (!state.decoder || state.decoder.state === "closed" || !state.decoderReady) return;
        while (state.packetQueue.length > 0) {
            decodePacket(state.packetQueue.shift());
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
            console.error(`[SessionView ${tabId}] Echec init decodeur:`, err);
        } finally {
            state.decoderInitializing = false;
        }
    }

    window.videoAPI.onVideoCodecMeta((eventData) => {
        if (eventData.tabId !== tabId) return;
        initDecoder(eventData).catch((err) => {
            console.error(`[SessionView ${tabId}] Erreur init decodeur:`, err);
        });
    });

    window.videoAPI.onVideoPacket((eventData) => {
        if (eventData.tabId !== tabId) return;
        if (!state.decoderReady || !state.decoder || state.decoder.state === "closed" || state.decoderInitializing) {
            enqueuePacket(eventData);
            return;
        }
        decodePacket(eventData);
    });

    window.videoAPI.onVideoError((eventData) => {
        if (eventData.tabId !== tabId) return;
        console.error(`[SessionView ${tabId}] Erreur stream:`, eventData.error);
    });

    function resetDecoderState() {
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
        state.frameCount = 0;
    }

    if (window.videoAPI.onStreamRestarting) {
        window.videoAPI.onStreamRestarting((data) => {
            if (data?.sessionId !== tabId) return;
            resetDecoderState();
        });
    }

    return {
        getFrameCount() {
            return state.frameCount;
        },
        capturePreviewFrame(quality = 0.55) {
            if (state.frameCount === 0 || canvasElement.width === 0 || canvasElement.height === 0) {
                return null;
            }
            try {
                return canvasElement.toDataURL("image/jpeg", quality);
            } catch (_err) {
                return null;
            }
        }
    };
}

function initTypeBVideoPipeline(sessionIdParam, canvasElement) {
    const ctx = canvasElement.getContext("2d");
    const state = {
        started: false,
        decoder: null,
        decoderReady: false,
        pendingConfig: null,
        frameCount: 0,
        queue: [],
        firstPts: null,
        lastTs: -1,
        format: "annexb"
    };

    function normalizeBinary(data) {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
        return null;
    }

    function detectH264Format(configData) {
        if (!configData || configData.length < 4) return "annexb";
        if (configData[0] === 0x01) return "avc";
        return "annexb";
    }

    function toTs(rawPts) {
        if (rawPts === undefined || rawPts === null) {
            state.lastTs = state.lastTs + 16667;
            return state.lastTs;
        }
        try {
            const pts = BigInt(rawPts);
            if (state.firstPts === null) state.firstPts = pts;
            let delta = pts - state.firstPts;
            if (delta < 0n) delta = 0n;
            const ts = Number(delta);
            if (!Number.isFinite(ts) || ts <= state.lastTs) {
                state.lastTs = state.lastTs + 1;
                return state.lastTs;
            }
            state.lastTs = ts;
            return ts;
        } catch (_err) {
            state.lastTs = state.lastTs + 16667;
            return state.lastTs;
        }
    }

    async function initDecoder(meta) {
        if (state.decoderReady || state.decoder) return;
        canvasElement.width = meta.width;
        canvasElement.height = meta.height;
        const decoderConfig = {
            codec: meta.codecId === "h265" || meta.codecId === "hevc" ? "hev1.1.6.L93.B0" : "avc1.640034",
            codedWidth: meta.width,
            codedHeight: meta.height,
            optimizeForLatency: true
        };
        if (meta.codecId === "h264") {
            decoderConfig.avc = { format: state.format };
            if (state.format === "avc" && state.pendingConfig) {
                decoderConfig.description = state.pendingConfig;
            }
        }
        state.decoder = new VideoDecoder({
            output: (frame) => {
                ctx.drawImage(frame, 0, 0, canvasElement.width, canvasElement.height);
                frame.close();
                state.frameCount += 1;
            },
            error: (err) => {
                console.error(`[SessionView ${sessionIdParam}] Erreur decodeur:`, err);
            }
        });
        state.decoder.configure(decoderConfig);
        state.decoderReady = true;
        flushQueue();
    }

    function decodePacket(packet) {
        if (!state.decoder || !state.decoderReady || state.decoder.state === "closed") return;
        try {
            if (packet.isConfig) {
                const cfg = normalizeBinary(packet.data);
                if (cfg && cfg.length > 0) {
                    state.pendingConfig = cfg;
                    const detectedFormat = detectH264Format(cfg);
                    if (detectedFormat !== state.format) {
                        state.format = detectedFormat;
                        if (state.decoder && state.decoder.state !== "closed") state.decoder.close();
                        state.decoder = null;
                        state.decoderReady = false;
                    }
                }
                return;
            }
            const payload = normalizeBinary(packet.data);
            if (!payload || payload.length === 0) return;
            let chunkData = payload;
            if (state.format === "annexb" && packet.isKeyFrame && state.pendingConfig) {
                const merged = new Uint8Array(state.pendingConfig.length + payload.length);
                merged.set(state.pendingConfig, 0);
                merged.set(payload, state.pendingConfig.length);
                chunkData = merged;
                state.pendingConfig = null;
            }
            const chunk = new EncodedVideoChunk({
                type: packet.isKeyFrame ? "key" : "delta",
                timestamp: toTs(packet.pts),
                data: chunkData
            });
            state.decoder.decode(chunk);
        } catch (err) {
            console.error(`[SessionView ${sessionIdParam}] Erreur decode packet:`, err);
        }
    }

    function flushQueue() {
        while (state.queue.length > 0 && state.decoderReady && state.decoder && state.decoder.state !== "closed") {
            decodePacket(state.queue.shift());
        }
    }

    window.videoAPI.onNewInstanceVideoCodecMeta((data) => {
        if (!data || data.sessionId !== sessionIdParam) return;
        initDecoder(data).catch((err) => {
            console.error(`[SessionView ${sessionIdParam}] Erreur init decodeur:`, err);
        });
    });

    window.videoAPI.onNewInstanceVideoPacket((data) => {
        if (!data || data.sessionId !== sessionIdParam) return;
        if (!state.decoderReady || !state.decoder || state.decoder.state === "closed") {
            state.queue.push(data);
            if (state.queue.length > 240) state.queue.shift();
            return;
        }
        decodePacket(data);
    });

    window.videoAPI.onNewInstanceVideoError((data) => {
        if (!data || data.sessionId !== sessionIdParam) return;
        console.error(`[SessionView ${sessionIdParam}] Erreur stream:`, data.error);
    });

    function resetDecoderState() {
        if (state.decoder && state.decoder.state !== "closed") {
            state.decoder.close();
        }
        state.decoder = null;
        state.decoderReady = false;
        state.pendingConfig = null;
        state.queue.length = 0;
        state.frameCount = 0;
        state.firstPts = null;
        state.lastTs = -1;
        state.format = "annexb";
        state.started = false;
    }

    if (window.videoAPI.onStreamRestarting) {
        window.videoAPI.onStreamRestarting((data) => {
            if (data?.sessionId !== sessionIdParam) return;
            resetDecoderState();
        });
    }

    return {
        getFrameCount() {
            return state.frameCount;
        },
        capturePreviewFrame(quality = 0.55) {
            if (state.frameCount === 0 || canvasElement.width === 0 || canvasElement.height === 0) {
                return null;
            }
            try {
                return canvasElement.toDataURL("image/jpeg", quality);
            } catch (_err) {
                return null;
            }
        }
    };
}

function initTypeAInputHandlers(canvasEl, tabId, serial, orientation = "portrait") {
    if (!canvasEl || !tabId || !serial) {
        console.warn(`[SessionView ${tabId}] input Type A ignoré — deviceId/serial manquant`);
        return;
    }

    let isDragging = false;
    let activePointerId = null;
    let lastMoveSentAt = 0;
    let lastSentCoords = null;
    let pendingInput = Promise.resolve();

    async function sendTouchAction(event, action) {
        const coords = normalizePointerPosition(canvasEl, event);
        await window.videoAPI.sendInput({
            tabId,
            sessionId: tabId,
            deviceId: serial,
            type: "touch",
            action,
            x: coords.streamX,
            y: coords.streamY,
            isStreamPixel: true,
            orientation,
            streamWidth: coords.canvasWidth,
            streamHeight: coords.canvasHeight
        });
    }

    function queueTouchAction(event, action) {
        pendingInput = pendingInput
            .catch(() => undefined)
            .then(() => sendTouchAction(event, action));
    }

    function clearPointerListeners() {
        canvasEl.removeEventListener("pointermove", onPointerMove);
        canvasEl.removeEventListener("pointerup", onPointerUp);
        canvasEl.removeEventListener("pointercancel", onPointerCancel);
    }

    function onPointerDown(event) {
        if (event.pointerType !== "mouse" && event.pointerType !== "touch" && event.pointerType !== "pen") return;
        if (event.button !== 0) return;
        event.preventDefault();
        if (window.videoAPI?.activateSession) {
            void window.videoAPI.activateSession(tabId);
        }
        isDragging = true;
        activePointerId = event.pointerId;
        lastMoveSentAt = 0;
        lastSentCoords = normalizePointerPosition(canvasEl, event);
        if (canvasEl.setPointerCapture) canvasEl.setPointerCapture(event.pointerId);
        canvasEl.focus();
        canvasEl.addEventListener("pointermove", onPointerMove, { passive: false });
        canvasEl.addEventListener("pointerup", onPointerUp);
        canvasEl.addEventListener("pointercancel", onPointerCancel);
        queueTouchAction(event, "down");
    }

    async function onPointerUp(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        if (canvasEl.releasePointerCapture) canvasEl.releasePointerCapture(event.pointerId);
        clearPointerListeners();
        await queueTouchAction(event, "up");
        lastSentCoords = null;
    }

    function onPointerMove(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        event.preventDefault();
        const now = Date.now();
        const coords = normalizePointerPosition(canvasEl, event);
        const movedEnough = !lastSentCoords
            || Math.abs(coords.streamX - lastSentCoords.streamX) >= 2
            || Math.abs(coords.streamY - lastSentCoords.streamY) >= 2;
        if (!movedEnough && now - lastMoveSentAt < 16) return;
        lastMoveSentAt = now;
        lastSentCoords = coords;
        queueTouchAction(event, "move");
    }

    function onPointerCancel(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        clearPointerListeners();
        queueTouchAction(event, "up");
        lastSentCoords = null;
    }

    async function onKeyDown(event) {
        if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA")) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
        if (key.length === 1 || KEYCODE_MAP[key]) {
            event.preventDefault();
            event.stopPropagation();
            await window.videoAPI.sendInput({ tabId, sessionId: tabId, deviceId: serial, type: "key", key });
        }
    }

    canvasEl.tabIndex = 0;
    canvasEl.style.outline = "none";
    canvasEl.style.touchAction = "none";
    canvasEl.style.userSelect = "none";
    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("click", () => canvasEl.focus());
    document.addEventListener("keydown", onKeyDown, true);
    attachRightClickBackHandler(canvasEl, () => {
        if (window.videoAPI?.activateSession) {
            void window.videoAPI.activateSession(tabId);
        }
        return window.videoAPI.sendInput({ tabId, sessionId: tabId, deviceId: serial, type: "key", key: "Back" });
    });
}

function initTypeBInputHandlers(canvasEl, sessionIdParam) {
    if (!canvasEl || !sessionIdParam) return;

    let isDragging = false;
    let activePointerId = null;
    let lastMoveSentAt = 0;
    let lastSentCoords = null;
    let pendingInput = Promise.resolve();

    async function sendTouchAction(event, action) {
        const coords = normalizePointerPosition(canvasEl, event);
        const result = await window.videoAPI.newInstanceSendInput({
            sessionId: sessionIdParam,
            type: "touch",
            action,
            x: coords.streamX,
            y: coords.streamY,
            isStreamPixel: true,
            streamWidth: coords.canvasWidth,
            streamHeight: coords.canvasHeight
        });
        if (result && result.success === false) {
            throw new Error(result.error || "Echec envoi touch");
        }
    }

    function queueTouchAction(event, action) {
        pendingInput = pendingInput
            .catch((err) => {
                console.warn(`[SessionView ${sessionIdParam}] Erreur input touch:`, err?.message || err);
            })
            .then(() => sendTouchAction(event, action));
    }

    function clearPointerListeners() {
        canvasEl.removeEventListener("pointermove", onPointerMove);
        canvasEl.removeEventListener("pointerup", onPointerUp);
        canvasEl.removeEventListener("pointercancel", onPointerCancel);
    }

    function onPointerDown(event) {
        if (event.pointerType !== "mouse" && event.pointerType !== "touch" && event.pointerType !== "pen") return;
        if (event.button !== 0) return;
        event.preventDefault();
        if (window.videoAPI?.activateSession) {
            void window.videoAPI.activateSession(sessionIdParam);
        }
        isDragging = true;
        activePointerId = event.pointerId;
        lastMoveSentAt = 0;
        lastSentCoords = normalizePointerPosition(canvasEl, event);
        if (canvasEl.setPointerCapture) canvasEl.setPointerCapture(event.pointerId);
        canvasEl.focus();
        canvasEl.addEventListener("pointermove", onPointerMove, { passive: false });
        canvasEl.addEventListener("pointerup", onPointerUp);
        canvasEl.addEventListener("pointercancel", onPointerCancel);
        queueTouchAction(event, "down");
    }

    async function onPointerUp(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        if (canvasEl.releasePointerCapture) canvasEl.releasePointerCapture(event.pointerId);
        clearPointerListeners();
        await queueTouchAction(event, "up");
        lastSentCoords = null;
    }

    function onPointerMove(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        event.preventDefault();
        const now = Date.now();
        const coords = normalizePointerPosition(canvasEl, event);
        const movedEnough = !lastSentCoords
            || Math.abs(coords.streamX - lastSentCoords.streamX) >= 2
            || Math.abs(coords.streamY - lastSentCoords.streamY) >= 2;
        if (!movedEnough && now - lastMoveSentAt < 16) return;
        lastMoveSentAt = now;
        lastSentCoords = coords;
        queueTouchAction(event, "move");
    }

    function onPointerCancel(event) {
        if (!isDragging || event.pointerId !== activePointerId) return;
        isDragging = false;
        activePointerId = null;
        clearPointerListeners();
        queueTouchAction(event, "up");
        lastSentCoords = null;
    }

    async function onKeyDown(event) {
        if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA")) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
        if (key.length === 1 || KEYCODE_MAP[key]) {
            event.preventDefault();
            event.stopPropagation();
            try {
                const result = await window.videoAPI.newInstanceSendInput({ sessionId: sessionIdParam, type: "key", key });
                if (result && result.success === false) {
                    console.warn(`[SessionView ${sessionIdParam}] Erreur input key:`, result.error);
                }
            } catch (err) {
                console.warn(`[SessionView ${sessionIdParam}] Erreur input key:`, err?.message || err);
            }
        }
    }

    canvasEl.tabIndex = 0;
    canvasEl.style.outline = "none";
    canvasEl.style.touchAction = "none";
    canvasEl.style.userSelect = "none";
    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("click", () => canvasEl.focus());
    document.addEventListener("keydown", onKeyDown, true);
    attachRightClickBackHandler(canvasEl, async () => {
        if (window.videoAPI?.activateSession) {
            void window.videoAPI.activateSession(sessionIdParam);
        }
        try {
            const result = await window.videoAPI.newInstanceSendInput({
                sessionId: sessionIdParam,
                type: "key",
                key: "Back"
            });
            if (result && result.success === false) {
                console.warn(`[SessionView ${sessionIdParam}] Erreur input Back (clic droit):`, result.error);
            }
        } catch (err) {
            console.warn(`[SessionView ${sessionIdParam}] Erreur input Back (clic droit):`, err?.message || err);
        }
    });
}

async function resolveSessionDeviceId(fallbackDeviceId) {
    if (fallbackDeviceId) return fallbackDeviceId;
    if (!sessionId || !window.videoAPI?.getInputContext) return "";

    try {
        const ctx = await window.videoAPI.getInputContext(sessionId);
        if (ctx?.success && ctx.deviceId) {
            return ctx.deviceId;
        }
    } catch (err) {
        console.warn(`[SessionView ${sessionId}] lecture deviceId:`, err?.message || err);
    }
    return "";
}

async function bootstrapSessionView() {
    const sessionType = type ? String(type).toUpperCase() : "";

    if (!sessionId || !sessionType) {
        console.error("[SessionView] sessionId ou type manquant dans query string");
        return;
    }

    if (sessionType === "B") {
        window.__sessionVideoHandle = initTypeBVideoPipeline(sessionId, canvas);
        initTypeBInputHandlers(canvas, sessionId);
        return;
    }

    const resolvedDeviceId = await resolveSessionDeviceId(deviceId);
    window.__sessionVideoHandle = initTypeAVideoPlayer(sessionId, canvas);
    initTypeAInputHandlers(canvas, sessionId, resolvedDeviceId, "portrait");
}

bootstrapSessionView();
