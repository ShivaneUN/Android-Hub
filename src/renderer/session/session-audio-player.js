/**
 * session-audio-player.js — stub.
 *
 * Web Audio désactivé : le son PC passe par SessionAudioProcessManager
 * (exe "Android Hub - {device}" dans le mixeur). Ouvrir un AudioContext
 * ferait réapparaître Electron / "Android Hub" dans le mixeur Windows.
 */

function createSessionAudioPlayer(sessionKey, options = {}) {
    const logPrefix = `[SessionAudio ${sessionKey}]`;
    void options;

    async function ensureAudioContext() {}

    function handleCodecMeta(meta) {
        console.log(`${logPrefix} Codec meta ignoré (Web Audio off): ${meta?.codecId || "?"}`);
    }

    function handlePacket(_packet) {}

    function reset() {}

    function setMuted(_muted) {}

    return {
        handleCodecMeta,
        handlePacket,
        reset,
        setMuted,
        ensureAudioContext
    };
}
