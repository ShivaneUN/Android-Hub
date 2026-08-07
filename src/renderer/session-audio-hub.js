/**
 * Hub audio Web Audio (fenêtre principale) — DÉSACTIVÉ.
 *
 * Le son PC passe uniquement par SessionAudioProcessManager
 * (processus "Android Hub - {device}.exe" dans le mixeur Windows).
 * Garder un AudioContext ici créait une entrée inutile "Android Hub"
 * (processus Electron) sans volume pilotable.
 */
(function initSessionAudioHub() {
    window.__sessionAudioHub = {
        setActiveSession() {},
        removePlayer() {}
    };
})();
