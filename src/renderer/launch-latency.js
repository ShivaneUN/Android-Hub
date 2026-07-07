/**
 * Helpers renderer pour l'instrumentation latence (diagnostic).
 */
(function initLaunchLatencyRenderer() {
    function createTraceId() {
        return `lat-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }

    async function markClick(type) {
        const traceId = createTraceId();
        const clickTs = Date.now();
        if (window.launchLatencyAPI?.click) {
            await window.launchLatencyAPI.click({ traceId, type, clickTs });
        }
        return { traceId, clickTs };
    }

    async function bindSession(traceId, sessionId) {
        if (!traceId || !sessionId || !window.launchLatencyAPI?.bind) return;
        await window.launchLatencyAPI.bind({ traceId, sessionId });
    }

    async function mark(traceId, stage, ts = Date.now()) {
        if (!traceId || !stage || !window.launchLatencyAPI?.mark) return;
        await window.launchLatencyAPI.mark({ traceId, stage, ts });
    }

    window.LaunchLatency = {
        createTraceId,
        markClick,
        bindSession,
        mark
    };
})();
