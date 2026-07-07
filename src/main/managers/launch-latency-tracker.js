/**
 * Mesure latence clic → première frame (instrumentation diagnostic).
 * Hors zones LOCK — logs uniquement, aucun effet sur le métier.
 */

const fs = require("fs");
const path = require("path");

const STAGE_ORDER = [
    "click",
    "registerViewStart",
    "browserViewReady",
    "streamInvoke",
    "dimsResolveBegin",
    "dimsResolve",
    "profilerBegin",
    "externalLaunchStart",
    "externalDisplayReady",
    "externalLaunchEnd",
    "waitDisplayStart",
    "waitDisplayEnd",
    "hubSocketStart",
    "adb-socket-connected",
    "codec-meta",
    "h264-first-packet",
    "firstFrame"
];

class LaunchLatencyTracker {
    constructor(userDataPath = null) {
        this.pendingByTraceId = new Map();
        this.tracesBySessionId = new Map();
        this.traceIdBySessionId = new Map();
        this.completedSamples = { A: [], B: [] };
        this.logFilePath = userDataPath
            ? path.join(userDataPath, "launch-latency.log")
            : null;
    }

    beginClick({
        traceId,
        type,
        clickTs,
        getDevicesPollOverlap = false,
        getDevicesPollStartedAt = null
    } = {}) {
        if (!traceId || !type) return;
        this.pendingByTraceId.set(traceId, {
            traceId,
            type: type === "B" ? "B" : "A",
            clickTs: Number(clickTs) || Date.now(),
            stages: { click: Number(clickTs) || Date.now() },
            getDevicesPollOverlap: Boolean(getDevicesPollOverlap),
            getDevicesPollStartedAt: Number.isFinite(getDevicesPollStartedAt)
                ? getDevicesPollStartedAt
                : null,
            annotation: {}
        });
    }

    bindSession(traceId, sessionId) {
        if (!traceId || !sessionId) return;
        const pending = this.pendingByTraceId.get(traceId);
        if (!pending) return;

        this.tracesBySessionId.set(sessionId, {
            ...pending,
            sessionId
        });
        this.traceIdBySessionId.set(sessionId, traceId);
        this.pendingByTraceId.delete(traceId);
    }

    _resolveTrace({ sessionId, traceId } = {}) {
        if (sessionId && this.tracesBySessionId.has(sessionId)) {
            return this.tracesBySessionId.get(sessionId);
        }
        if (traceId && this.pendingByTraceId.has(traceId)) {
            return this.pendingByTraceId.get(traceId);
        }
        if (sessionId) {
            const boundTraceId = this.traceIdBySessionId.get(sessionId);
            if (boundTraceId && this.pendingByTraceId.has(boundTraceId)) {
                return this.pendingByTraceId.get(boundTraceId);
            }
        }
        return null;
    }

    mark({ sessionId, traceId, stage, ts = Date.now(), annotation = null } = {}) {
        const trace = this._resolveTrace({ sessionId, traceId });
        if (!trace || !stage) return;

        if (!trace.stages[stage]) {
            trace.stages[stage] = ts;
        }

        if (annotation && typeof annotation === "object") {
            trace.annotation = { ...(trace.annotation || {}), ...annotation };
        }

        if (stage === "firstFrame" && trace.sessionId) {
            this._finalize(trace);
        }
    }

    _delta(trace, fromStage, toStage) {
        const from = trace.stages[fromStage];
        const to = trace.stages[toStage];
        if (!from || !to) return null;
        return Math.max(0, Math.round(to - from));
    }

    _deltaFromClick(trace, stage) {
        const click = trace.stages.click ?? trace.clickTs;
        const target = trace.stages[stage];
        if (!click || !target) return null;
        return Math.max(0, Math.round(target - click));
    }

    _buildMetrics(trace) {
        const total = this._deltaFromClick(trace, "firstFrame");
        const registerView = this._deltaFromClick(trace, "browserViewReady");
        const adbSocket = this._deltaFromClick(trace, "adb-socket-connected");
        const firstPacket = this._deltaFromClick(trace, "h264-first-packet");
        const decodeRender = this._delta(trace, "h264-first-packet", "firstFrame");

        const metrics = {
            type: trace.type,
            sessionId: trace.sessionId || null,
            traceId: trace.traceId,
            total,
            registerView,
            adbSocket,
            firstPacket,
            decodeRender
        };

        if (trace.type === "B") {
            metrics.externalDisplay = this._delta(trace, "externalLaunchStart", "externalDisplayReady")
                ?? this._delta(trace, "externalLaunchStart", "externalLaunchEnd");
            metrics.waitDisplayId = this._delta(trace, "waitDisplayStart", "waitDisplayEnd");
            metrics.hubSocket = this._delta(trace, "hubSocketStart", "h264-first-packet");
        }

        return metrics;
    }

    _formatSummary(trace) {
        const m = this._buildMetrics(trace);
        const fmt = (value) => (value === null || value === undefined ? "—" : `${value}`);

        if (trace.type === "B") {
            return `[LATENCE] Type B - Total: ${fmt(m.total)}ms | external-display: ${fmt(m.externalDisplay)}ms | waitDisplayId: ${fmt(m.waitDisplayId)}ms | hub-socket: ${fmt(m.hubSocket)}ms | registerView: ${fmt(m.registerView)}ms | first-packet: ${fmt(m.firstPacket)}ms | decode+render: ${fmt(m.decodeRender)}ms`;
        }

        return `[LATENCE] Type A - Total: ${fmt(m.total)}ms | registerView: ${fmt(m.registerView)}ms | adb-socket: ${fmt(m.adbSocket)}ms | first-packet: ${fmt(m.firstPacket)}ms | decode+render: ${fmt(m.decodeRender)}ms`;
    }

    _appendLog(line) {
        console.log(line);
        if (!this.logFilePath) return;
        try {
            fs.appendFileSync(this.logFilePath, `${new Date().toISOString()} ${line}\n`, "utf-8");
        } catch (err) {
            console.warn("[LATENCE] Impossible d'écrire launch-latency.log:", err.message);
        }
    }

    _printAverages(type) {
        const samples = this.completedSamples[type];
        if (!samples.length === 0) return;

        const avg = (key) => {
            const values = samples.map((s) => s[key]).filter((v) => typeof v === "number");
            if (!values.length) return null;
            return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
        };

        const fmt = (value) => (value === null ? "—" : `${value}`);

        if (type === "B") {
            this._appendLog(
                `[LATENCE] Moyenne Type B (n=${samples.length}) - Total: ${fmt(avg("total"))}ms | external-display: ${fmt(avg("externalDisplay"))}ms | waitDisplayId: ${fmt(avg("waitDisplayId"))}ms | hub-socket: ${fmt(avg("hubSocket"))}ms | registerView: ${fmt(avg("registerView"))}ms | first-packet: ${fmt(avg("firstPacket"))}ms | decode+render: ${fmt(avg("decodeRender"))}ms`
            );
            return;
        }

        this._appendLog(
            `[LATENCE] Moyenne Type A (n=${samples.length}) - Total: ${fmt(avg("total"))}ms | registerView: ${fmt(avg("registerView"))}ms | adb-socket: ${fmt(avg("adbSocket"))}ms | first-packet: ${fmt(avg("firstPacket"))}ms | decode+render: ${fmt(avg("decodeRender"))}ms`
        );
    }

    _finalize(trace) {
        const metrics = this._buildMetrics(trace);
        this._appendLog(this._formatSummary(trace));
        const stageOffsets = Object.fromEntries(
            STAGE_ORDER
                .filter((key) => trace.stages[key])
                .map((key) => [key, this._deltaFromClick(trace, key)])
        );
        const dimsBegin = trace.stages.dimsResolveBegin;
        const dimsEnd = trace.stages.dimsResolve;
        const dimsResolveDurationMs = (dimsBegin && dimsEnd)
            ? Math.max(0, Math.round(dimsEnd - dimsBegin))
            : null;

        const detailPayload = {
            stages: stageOffsets,
            dimsResolveDurationMs,
            getDevicesPollOverlap: trace.getDevicesPollOverlap ?? null,
            getDevicesPollStartedAt: trace.getDevicesPollStartedAt ?? null,
            ...(trace.annotation || {})
        };

        this._appendLog(`[LATENCE] Détail ${trace.type} ${trace.sessionId || trace.traceId}: ${JSON.stringify(detailPayload)}`);

        if (trace.type === "A" && trace.annotation?.dims) {
            const d = trace.annotation.dims;
            const fmt = (value) => (value === null || value === undefined ? "—" : `${value}`);
            this._appendLog(
                `[LATENCE-DIMS] ${trace.sessionId || trace.traceId} | total: ${fmt(d.totalMs)}ms | listUnified: ${fmt(d.listUnifiedMs)}ms | wmSize: ${fmt(d.wmSizeMs)}ms | cacheHit: ${d.cacheHit ? "yes" : "no"} | pollOverlap@click: ${trace.getDevicesPollOverlap ? "yes" : "no"}`
            );
        }

        const bucket = trace.type === "B" ? "B" : "A";
        this.completedSamples[bucket].push(metrics);

        if (this.completedSamples[bucket].length >= 3
            && this.completedSamples[bucket].length % 3 === 0) {
            this._printAverages(bucket);
        }

        if (trace.sessionId) {
            this.tracesBySessionId.delete(trace.sessionId);
            this.traceIdBySessionId.delete(trace.sessionId);
        }
        if (trace.traceId) {
            this.pendingByTraceId.delete(trace.traceId);
        }
    }

    getAverages() {
        return {
            A: [...this.completedSamples.A],
            B: [...this.completedSamples.B]
        };
    }
}

module.exports = { LaunchLatencyTracker };
