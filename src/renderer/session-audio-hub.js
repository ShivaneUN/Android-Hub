/**
 * Hub audio central (fenêtre principale).
 * La lecture se fait ici — pas dans BrowserView — pour éviter le blocage autoplay.
 */
(function initSessionAudioHub() {
    if (typeof createSessionAudioPlayer !== "function") {
        console.warn("[SessionAudioHub] createSessionAudioPlayer indisponible");
        return;
    }

    /** @type {Map<string, ReturnType<typeof createSessionAudioPlayer>>} */
    const players = new Map();
    let activeSessionId = null;
    let globalMuted = false;

    function resolveSessionId(data) {
        return data?.sessionId || data?.tabId || null;
    }

    function getOrCreatePlayer(sessionId) {
        if (!players.has(sessionId)) {
            const muted = globalMuted || (activeSessionId && sessionId !== activeSessionId);
            players.set(sessionId, createSessionAudioPlayer(sessionId, { initialMuted: Boolean(muted) }));
            if (!activeSessionId) {
                activeSessionId = sessionId;
                syncMuteState();
            }
        }
        return players.get(sessionId);
    }

    function syncMuteState() {
        for (const [sessionId, player] of players) {
            const muted = globalMuted || sessionId !== activeSessionId;
            player.setMuted(muted);
        }
    }

    function setActiveSession(sessionId) {
        if (!sessionId) return;
        activeSessionId = sessionId;
        syncMuteState();
        void getOrCreatePlayer(sessionId).ensureAudioContext();
    }

    function removePlayer(sessionId) {
        const player = players.get(sessionId);
        if (player) {
            player.reset();
            players.delete(sessionId);
        }
        if (activeSessionId === sessionId) {
            activeSessionId = players.size > 0 ? players.keys().next().value : null;
        }
        syncMuteState();
    }

    function handleCodecMeta(data) {
        const sessionId = resolveSessionId(data);
        if (!sessionId) return;
        if (!activeSessionId || players.size <= 1) {
            setActiveSession(sessionId);
        }
        getOrCreatePlayer(sessionId).handleCodecMeta(data);
    }

    function handlePacket(data) {
        const sessionId = resolveSessionId(data);
        if (!sessionId) return;
        getOrCreatePlayer(sessionId).handlePacket(data);
    }

    async function initGlobalMuteState() {
        if (!window.audioAPI?.getGlobalState) return;
        try {
            const state = await window.audioAPI.getGlobalState();
            globalMuted = Boolean(state?.globalMuted);
            syncMuteState();
        } catch (_err) {
            globalMuted = false;
        }
    }

    window.electronAPI?.onAudioCodecMeta?.((data) => handleCodecMeta(data));
    window.electronAPI?.onAudioPacket?.((data) => handlePacket(data));
    window.electronAPI?.onNewInstanceAudioCodecMeta?.((data) => handleCodecMeta(data));
    window.electronAPI?.onNewInstanceAudioPacket?.((data) => handlePacket(data));

    window.sessionAPI?.onSessionActivated?.((data) => {
        setActiveSession(data?.sessionId || null);
    });

    window.sessionAPI?.onStreamRestarting?.((data) => {
        const sessionId = data?.sessionId;
        if (!sessionId) return;
        const player = players.get(sessionId);
        if (player) player.reset();
    });

    window.audioAPI?.onGlobalStateChanged?.((data) => {
        globalMuted = Boolean(data?.globalMuted);
        syncMuteState();
    });

    document.addEventListener("pointerdown", () => {
        for (const player of players.values()) {
            void player.ensureAudioContext();
        }
    }, { capture: true });

    void initGlobalMuteState();
    void ensureAudioContextOnBoot();

    async function ensureAudioContextOnBoot() {
        await initGlobalMuteState();
        if (activeSessionId) {
            const player = players.get(activeSessionId);
            if (player) await player.ensureAudioContext();
        }
    }

    window.__sessionAudioHub = { setActiveSession, removePlayer };
})();
