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
            void window.launchLatencyAPI.click({ traceId, type, clickTs });
        }
        return { traceId, clickTs };
    }

    function bindSession(traceId, sessionId) {
        if (!traceId || !sessionId || !window.launchLatencyAPI?.bind) return;
        void window.launchLatencyAPI.bind({ traceId, sessionId });
    }

    function mark(traceId, stage, ts = Date.now()) {
        if (!traceId || !stage || !window.launchLatencyAPI?.mark) return;
        void window.launchLatencyAPI.mark({ traceId, stage, ts });
    }

    window.LaunchLatency = {
        createTraceId,
        markClick,
        bindSession,
        mark
    };
})();
