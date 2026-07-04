/**
 * session-audio-player.js
 *
 * IPC audio packets -> WebCodecs AudioDecoder (ou PCM brut) -> Web Audio API.
 */

function createSessionAudioPlayer(sessionKey, options = {}) {
    const logPrefix = `[SessionAudio ${sessionKey}]`;
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    gainNode.gain.value = options.initialMuted ? 0 : 1;

    const state = {
        decoder: null,
        decoderReady: false,
        decoderInitializing: false,
        codecId: null,
        pendingConfig: null,
        packetQueue: [],
        firstPts: null,
        lastTimestampUs: -1,
        nextPlayTime: 0,
        contextReady: false,
        packetsPlayed: 0,
        packetsReceived: 0,
        pcmMode: false,
        pcmSampleRate: 48000,
        pcmChannels: 2
    };

    function normalizeBinary(data) {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
        return null;
    }

    async function ensureAudioContext() {
        if (state.contextReady && audioContext.state === "running") return;
        try {
            if (audioContext.state === "suspended") {
                await audioContext.resume();
            }
            state.contextReady = audioContext.state === "running";
        } catch (err) {
            console.warn(`${logPrefix} AudioContext resume:`, err?.message || err);
        }
    }

    function trimCodecId(codecId) {
        return String(codecId || "opus").replace(/\0/g, "").trim().toLowerCase();
    }

    function parseRawPcmConfig(configData) {
        if (!configData || configData.length < 8) {
            return { sampleRate: 48000, channels: 2 };
        }
        const view = new DataView(configData.buffer, configData.byteOffset, configData.byteLength);
        return {
            sampleRate: view.getUint32(0, true) || 48000,
            channels: view.getUint32(4, true) || 2
        };
    }

    function buildDecoderConfig(codecId, configData) {
        const id = trimCodecId(codecId);

        if (id === "raw") {
            const pcm = parseRawPcmConfig(configData);
            return {
                codec: "pcm-s16",
                sampleRate: pcm.sampleRate,
                numberOfChannels: pcm.channels
            };
        }

        if (id === "opus") {
            return {
                codec: "opus",
                sampleRate: 48000,
                numberOfChannels: 2
            };
        }

        if (id === "flac") {
            const config = {
                codec: "flac",
                sampleRate: 48000,
                numberOfChannels: 2
            };
            if (configData?.length) config.description = configData;
            return config;
        }

        const config = {
            codec: "mp4a.40.2",
            sampleRate: 48000,
            numberOfChannels: 2
        };
        if (configData?.length) config.description = configData;
        return config;
    }

    function toTimestampUs(rawPts) {
        if (rawPts === undefined || rawPts === null) {
            state.lastTimestampUs += 20000;
            return state.lastTimestampUs;
        }

        try {
            const pts = BigInt(rawPts);
            if (state.firstPts === null) state.firstPts = pts;
            let delta = pts - state.firstPts;
            if (delta < 0n) delta = 0n;
            const ts = Number(delta);
            if (!Number.isFinite(ts) || ts <= state.lastTimestampUs) {
                state.lastTimestampUs += 1;
                return state.lastTimestampUs;
            }
            state.lastTimestampUs = ts;
            return ts;
        } catch (_err) {
            state.lastTimestampUs += 20000;
            return state.lastTimestampUs;
        }
    }

    function schedulePcmPlayback(pcmData, sampleRate, channels) {
        const bytesPerSample = 2;
        const frameCount = Math.floor(pcmData.length / (bytesPerSample * channels));
        if (frameCount <= 0) return;

        const buffer = audioContext.createBuffer(channels, frameCount, sampleRate);
        const view = new DataView(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);

        for (let ch = 0; ch < channels; ch += 1) {
            const channelData = buffer.getChannelData(ch);
            for (let i = 0; i < frameCount; i += 1) {
                const offset = (i * channels + ch) * bytesPerSample;
                channelData[i] = view.getInt16(offset, true) / 32768;
            }
        }

        scheduleBufferPlayback(buffer, sampleRate);
    }

    function scheduleBufferPlayback(buffer, sampleRate) {
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(gainNode);

        const now = audioContext.currentTime;
        const minLead = 0.02;
        if (state.nextPlayTime < now + minLead || state.nextPlayTime > now + 0.5) {
            state.nextPlayTime = now + minLead;
        }
        source.start(state.nextPlayTime);
        state.nextPlayTime += buffer.duration;
        state.packetsPlayed += 1;

        if (state.packetsPlayed === 1) {
            console.log(`${logPrefix} Première frame audio (${sampleRate}Hz)`);
        }
    }

    function schedulePlayback(audioData) {
        const frames = audioData.numberOfFrames;
        const channels = audioData.numberOfChannels;
        const sampleRate = audioData.sampleRate;
        if (frames <= 0 || channels <= 0) {
            audioData.close();
            return;
        }

        const buffer = audioContext.createBuffer(channels, frames, sampleRate);
        for (let ch = 0; ch < channels; ch += 1) {
            const channelData = new Float32Array(frames);
            audioData.copyTo(channelData, { planeIndex: ch });
            buffer.copyToChannel(channelData, ch);
        }
        audioData.close();
        scheduleBufferPlayback(buffer, sampleRate);
    }

    async function configureDecoder(codecId, configData = null) {
        const id = trimCodecId(codecId);

        if (id === "raw") {
            const pcm = parseRawPcmConfig(configData);
            state.pcmMode = true;
            state.pcmSampleRate = pcm.sampleRate;
            state.pcmChannels = pcm.channels;
            state.decoderReady = true;
            state.codecId = id;
            console.log(`${logPrefix} Mode PCM (${pcm.sampleRate}Hz, ${pcm.channels}ch)`);
            return;
        }

        state.pcmMode = false;

        if (typeof AudioDecoder === "undefined") {
            console.warn(`${logPrefix} WebCodecs AudioDecoder indisponible`);
            return;
        }

        const decoderConfig = buildDecoderConfig(codecId, configData);
        if (!decoderConfig.codec) return;

        if (typeof AudioDecoder.isConfigSupported === "function") {
            try {
                const support = await AudioDecoder.isConfigSupported(decoderConfig);
                if (!support.supported) {
                    console.warn(`${logPrefix} Codec peut-etre non supporte:`, decoderConfig.codec);
                }
            } catch (err) {
                console.warn(`${logPrefix} isConfigSupported:`, err?.message || err);
            }
        }

        if (state.decoder && state.decoder.state !== "closed") {
            state.decoder.close();
        }

        state.decoder = new AudioDecoder({
            output: (frame) => {
                void ensureAudioContext().then(() => schedulePlayback(frame));
            },
            error: (err) => {
                console.error(`${logPrefix} Erreur decodeur:`, err);
            }
        });

        state.decoder.configure(decoderConfig);
        state.decoderReady = true;
        state.codecId = id;
        console.log(`${logPrefix} Decodeur configure (${id})`);
    }

    async function initDecoder(meta) {
        if (state.decoderInitializing) return;
        state.decoderInitializing = true;
        try {
            const codecId = trimCodecId(meta?.codecId);
            state.codecId = codecId;
            const configData = state.pendingConfig;
            await configureDecoder(codecId, configData);
            flushQueue();
        } catch (err) {
            console.error(`${logPrefix} Echec init decodeur:`, err);
            state.decoderReady = false;
        } finally {
            state.decoderInitializing = false;
        }
    }

    function decodePacket(packet) {
        if (!state.decoderReady) return;

        try {
            if (packet.isConfig) {
                const configData = normalizeBinary(packet.data);
                if (configData && configData.length > 0) {
                    state.pendingConfig = configData;
                    if (state.codecId) {
                        void configureDecoder(state.codecId, configData).then(() => flushQueue());
                    }
                }
                return;
            }

            const payload = normalizeBinary(packet.data);
            if (!payload || payload.length === 0) return;

            if (state.pcmMode) {
                void ensureAudioContext().then(() => {
                    schedulePcmPlayback(payload, state.pcmSampleRate, state.pcmChannels);
                });
                return;
            }

            if (!state.decoder || state.decoder.state === "closed") return;

            const chunk = new EncodedAudioChunk({
                type: "key",
                timestamp: toTimestampUs(packet.pts),
                data: payload
            });
            state.decoder.decode(chunk);
        } catch (err) {
            console.error(`${logPrefix} Erreur decode chunk:`, err);
        }
    }

    function enqueuePacket(packet) {
        state.packetQueue.push(packet);
        if (state.packetQueue.length > 120) state.packetQueue.shift();
    }

    function flushQueue() {
        if (!state.decoderReady) return;
        while (state.packetQueue.length > 0) {
            decodePacket(state.packetQueue.shift());
            if (state.pcmMode) continue;
            if (!state.decoder || state.decoder.state === "closed") break;
        }
    }

    function handleCodecMeta(meta) {
        void ensureAudioContext();
        console.log(`${logPrefix} Codec meta: ${meta?.codecId || "?"}`);
        initDecoder(meta).catch((err) => {
            console.error(`${logPrefix} Erreur init decodeur:`, err);
        });
    }

    function handlePacket(packet) {
        void ensureAudioContext();
        state.packetsReceived += 1;
        if (state.packetsReceived === 1) {
            console.log(`${logPrefix} Premier paquet audio (config=${Boolean(packet.isConfig)})`);
        }

        if (!state.decoderReady || state.decoderInitializing) {
            enqueuePacket(packet);
            if (state.codecId && !state.decoderInitializing) {
                initDecoder({ codecId: state.codecId }).catch(() => {});
            }
            return;
        }
        decodePacket(packet);
    }

    function reset() {
        if (state.decoder && state.decoder.state !== "closed") {
            state.decoder.close();
        }
        state.decoder = null;
        state.decoderReady = false;
        state.decoderInitializing = false;
        state.codecId = null;
        state.pendingConfig = null;
        state.packetQueue.length = 0;
        state.firstPts = null;
        state.lastTimestampUs = -1;
        state.nextPlayTime = 0;
        state.packetsPlayed = 0;
        state.packetsReceived = 0;
        state.pcmMode = false;
    }

    function setMuted(muted) {
        gainNode.gain.value = muted ? 0 : 1;
        if (!muted) {
            state.nextPlayTime = 0;
            void ensureAudioContext();
        }
    }

    return {
        handleCodecMeta,
        handlePacket,
        reset,
        setMuted,
        ensureAudioContext
    };
}
