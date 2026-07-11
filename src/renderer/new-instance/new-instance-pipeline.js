function createNewInstanceVideoPipeline(sessionId, canvasElement) {
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

    function resetDecoder() {
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
                if (state.frameCount === 1) {
                    window.dispatchEvent(new CustomEvent("new-instance:first-frame", {
                        detail: { sessionId }
                    }));
                }
            },
            error: (err) => {
                console.error(`[NewInstancePipeline ${sessionId}] Erreur decodeur:`, err);
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
                        if (state.decoder && state.decoder.state !== "closed") {
                            state.decoder.close();
                        }
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
            console.error(`[NewInstancePipeline ${sessionId}] Erreur decode packet:`, err);
        }
    }

    function flushQueue() {
        while (state.queue.length > 0 && state.decoderReady && state.decoder && state.decoder.state !== "closed") {
            decodePacket(state.queue.shift());
        }
    }

    let unsubscribeStreamRestarting = null;
    if (window.sessionAPI?.onStreamRestarting) {
        unsubscribeStreamRestarting = window.sessionAPI.onStreamRestarting((data) => {
            if (data?.sessionId !== sessionId) return;
            resetDecoder();
            state.started = true;
        });
    }

    return {
        async start() {
            if (state.started) return { success: true };
            state.started = true;
            return await window.electronAPI.newInstanceStart({ sessionId });
        },
        async stop() {
            if (!state.started) return;
            state.started = false;
            await window.electronAPI.newInstanceStop({ sessionId });
            resetDecoder();
        },
        getFrameCount() {
            return state.frameCount;
        },

        dispose() {
            if (typeof unsubscribeStreamRestarting === "function") {
                unsubscribeStreamRestarting();
                unsubscribeStreamRestarting = null;
            }
        }
    };
}

window.createNewInstanceVideoPipeline = createNewInstanceVideoPipeline;
