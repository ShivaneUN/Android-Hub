/**
 * Pont renderer ↔ main pour redémarrer les flux vidéo avec de nouveaux paramètres.
 */
(function initSessionStreamBridge() {
    /** @type {Map<string, { type: string, restart: Function, stop?: Function }>} */
    const handles = new Map();

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function registerSessionStreamHandle(sessionId, handle) {
        if (!sessionId || typeof handle?.restart !== "function") return;
        handles.set(sessionId, handle);
    }

    function unregisterSessionStreamHandle(sessionId) {
        handles.delete(sessionId);
    }

    async function restartTypeA({ sessionId, serial, packageName, scrcpyOptions }) {
        const handle = handles.get(sessionId);
        if (!handle) {
            return { success: false, error: "Flux vidéo introuvable pour cette session" };
        }

        try {
            if (typeof handle.stop === "function") {
                await handle.stop();
            }
            await sleep(400);
            const result = await handle.restart(serial, packageName, scrcpyOptions);
            if (!result?.success) {
                return { success: false, error: result?.error || "Échec du redémarrage du flux" };
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message || "Erreur redémarrage Type A" };
        }
    }

    async function onRestartRequest(payload) {
        if (!payload?.sessionId || !payload?.requestId) {
            return;
        }

        let result = { success: false, error: "Type de session non supporté" };

        if (payload.type === "A") {
            result = await restartTypeA(payload);
        }

        if (window.sessionAPI?.reportRestartStreamResult) {
            window.sessionAPI.reportRestartStreamResult({
                requestId: payload.requestId,
                success: result.success,
                error: result.error || null
            });
        }
    }

    window.__sessionStreamBridge = {
        registerSessionStreamHandle,
        unregisterSessionStreamHandle,
        restartTypeA
    };

    if (window.sessionAPI?.onRestartStreamRequest) {
        window.sessionAPI.onRestartStreamRequest((payload) => {
            onRestartRequest(payload).catch((err) => {
                if (window.sessionAPI?.reportRestartStreamResult && payload?.requestId) {
                    window.sessionAPI.reportRestartStreamResult({
                        requestId: payload.requestId,
                        success: false,
                        error: err.message
                    });
                }
            });
        });
    }
})();
