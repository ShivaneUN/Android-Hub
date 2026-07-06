/**
 * Panneau de contrôle — entièrement autonome (ne dépend pas du chargement externe de StreamParams).
 */
(function initControlPanel() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    function getFallbackOptions() {
        return {
            resolutions: [
                { width: 1920, height: 1080, label: t("controlPanel.resolution.fullHd") },
                { width: 1600, height: 900, label: "1600×900" },
                { width: 1280, height: 720, label: t("controlPanel.resolution.hd") },
                { width: 960, height: 540, label: t("controlPanel.resolution.qhd") }
            ],
            fps: [120, 60, 30],
            dpi: [
                { value: 420, label: t("controlPanel.dpi.native") },
                { value: 320, label: "320" },
                { value: 280, label: "280" },
                { value: 240, label: t("controlPanel.dpi.normal") },
                { value: 200, label: "200" },
                { value: 160, label: t("controlPanel.dpi.medium") },
                { value: 120, label: t("controlPanel.dpi.veryLarge") }
            ],
            bitRateMbps: [1, 2, 4, 6, 8, 12, 16, 24],
            iFrameInterval: [
                { value: 1, label: t("controlPanel.gop.fast") },
                { value: 2, label: t("controlPanel.gop.seconds", { value: 2 }) },
                { value: 3, label: t("controlPanel.gop.seconds", { value: 3 }) },
                { value: 5, label: t("controlPanel.gop.seconds", { value: 5 }) },
                { value: 10, label: t("controlPanel.gop.slow") }
            ]
        };
    }

    const DEFAULT_PARAMS = {
        width: 1920,
        height: 1080,
        dpi: 240,
        maxFps: 60,
        bitRateMbps: 8,
        iFrameInterval: 1
    };

    function getSP() {
        const ext = globalThis.StreamParams;
        const FALLBACK_OPTIONS = getFallbackOptions();
        if (ext?.CONTROL_OPTIONS && ext?.normalizeParams) return ext;
        return {
            CONTROL_OPTIONS: FALLBACK_OPTIONS,
            DEFAULT_STREAM_PARAMS: DEFAULT_PARAMS,
            cloneParams: (p) => ({ ...DEFAULT_PARAMS, ...p }),
            normalizeParams: (p) => {
                const base = { ...DEFAULT_PARAMS, ...p };
                const res = FALLBACK_OPTIONS.resolutions.find(
                    (r) => r.width === base.width && r.height === base.height
                ) || FALLBACK_OPTIONS.resolutions[0];
                const snap = (val, list) => list.reduce((a, b) =>
                    Math.abs(b - val) < Math.abs(a - val) ? b : a);
                return {
                    width: res.width,
                    height: res.height,
                    dpi: snap(base.dpi, FALLBACK_OPTIONS.dpi.map((d) => d.value)),
                    maxFps: snap(base.maxFps, FALLBACK_OPTIONS.fps),
                    bitRateMbps: snap(base.bitRateMbps, FALLBACK_OPTIONS.bitRateMbps),
                    iFrameInterval: snap(base.iFrameInterval, FALLBACK_OPTIONS.iFrameInterval.map((g) => g.value))
                };
            },
            validateParams: (p) => ({ valid: true, params: p, errors: [] }),
            paramsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
            formatParamsSummary: (p) => {
                const n = { ...DEFAULT_PARAMS, ...p };
                return t("controlPanel.validation.paramsSummary", {
                    width: n.width,
                    height: n.height,
                    dpi: n.dpi,
                    fps: n.maxFps,
                    bitrate: n.bitRateMbps,
                    gop: n.iFrameInterval
                });
            }
        };
    }

    let SP = getSP();
    let OPT = SP.CONTROL_OPTIONS;

    const state = {
        sessions: [],
        selectedSessionId: null,
        sessionType: null,
        appliedParams: null,
        draftParams: SP.cloneParams(SP.DEFAULT_STREAM_PARAMS || DEFAULT_PARAMS),
        isApplying: false,
        uiReady: false
    };

    const els = {};
    const segmentGroups = {};

    function $(id) {
        return document.getElementById(id);
    }

    function readDraftParams() {
        return SP.normalizeParams(state.draftParams || DEFAULT_PARAMS);
    }

    function getReferenceParams() {
        return state.appliedParams
            ? SP.normalizeParams(state.appliedParams)
            : SP.cloneParams(DEFAULT_PARAMS);
    }

    function setDraftParam(key, value) {
        if (key === "resolution") {
            state.draftParams.width = value.width;
            state.draftParams.height = value.height;
        } else {
            state.draftParams[key] = value;
        }
        state.draftParams = SP.normalizeParams(state.draftParams);
        syncSegmentUI();
        updateDirtyState();
    }

    function syncSegmentUI() {
        const p = readDraftParams();
        segmentGroups.resolution?.setActive(`${p.width}x${p.height}`);
        segmentGroups.fps?.setActive(String(p.maxFps));
        segmentGroups.dpi?.setActive(String(p.dpi));
        segmentGroups.bitrate?.setActive(String(p.bitRateMbps));
        segmentGroups.gop?.setActive(String(p.iFrameInterval));
    }

    function updateDirtyState() {
        if (!els.btnApply) return;
        const draft = readDraftParams();
        state.draftParams = draft;
        const reference = getReferenceParams();

        const dirtyKeys = new Set();
        if (draft.width !== reference.width || draft.height !== reference.height) dirtyKeys.add("resolution");
        if (draft.maxFps !== reference.maxFps) dirtyKeys.add("fps");
        if (draft.dpi !== reference.dpi) dirtyKeys.add("dpi");
        if (draft.bitRateMbps !== reference.bitRateMbps) dirtyKeys.add("bitrate");
        if (draft.iFrameInterval !== reference.iFrameInterval) dirtyKeys.add("gop");

        Object.entries(segmentGroups).forEach(([key, group]) => {
            group?.setDirty(dirtyKeys.has(key));
        });

        const hasChanges = !SP.paramsEqual(draft, reference);
        els.btnApply.disabled = !hasChanges || state.isApplying;
        els.btnCancel.disabled = !hasChanges || state.isApplying;
        els.btnReset.disabled = state.isApplying;
    }

    function setStatus(message, type = "info") {
        if (!els.statusMessage) return;
        els.statusMessage.textContent = message || "";
        els.statusMessage.className = "control-status";
        if (type === "success") els.statusMessage.classList.add("is-success");
        if (type === "error") els.statusMessage.classList.add("is-error");
    }

    function setLoading(active) {
        state.isApplying = active;
        if (els.loadingOverlay) {
            els.loadingOverlay.classList.toggle("hidden", !active);
        }
        if (!active) updateDirtyState();
        else {
            if (els.btnApply) els.btnApply.disabled = true;
            if (els.btnCancel) els.btnCancel.disabled = true;
            if (els.btnReset) els.btnReset.disabled = true;
        }
    }

    function updateSessionMeta() {
        if (!els.sessionMeta) return;
        if (!state.selectedSessionId) {
            els.sessionMeta.textContent = t("controlPanel.noSessionSelectedHint");
            return;
        }
        const session = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
        const label = session?.label || state.selectedSessionId;
        const type = session?.type || state.sessionType || "?";
        els.sessionMeta.textContent = t("controlPanel.sessionMeta", { label, type });
    }

    function updateAppliedDisplay() {
        if (!els.currentValues) return;
        if (state.appliedParams && state.selectedSessionId) {
            els.currentValues.textContent = SP.formatParamsSummary(state.appliedParams);
        } else {
            els.currentValues.textContent = t("controlPanel.selectSessionHint");
        }
    }

    function createSegmentGroup(container, groupKey, label, options) {
        const wrap = document.createElement("div");
        wrap.className = "control-param-group";
        wrap.dataset.group = groupKey;

        const title = document.createElement("div");
        title.className = "control-param-label";
        title.textContent = label;
        wrap.appendChild(title);

        const row = document.createElement("div");
        row.className = "control-segment-row";

        const buttons = [];

        options.forEach((opt) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "control-segment-btn";
            btn.dataset.value = opt.value;
            btn.textContent = opt.label;

            btn.addEventListener("click", () => {
                if (state.isApplying) return;
                if (groupKey === "resolution") {
                    const [w, h] = opt.value.split("x").map(Number);
                    setDraftParam("resolution", { width: w, height: h });
                } else if (groupKey === "fps") {
                    setDraftParam("maxFps", Number(opt.value));
                } else if (groupKey === "dpi") {
                    setDraftParam("dpi", Number(opt.value));
                } else if (groupKey === "bitrate") {
                    setDraftParam("bitRateMbps", Number(opt.value));
                } else if (groupKey === "gop") {
                    setDraftParam("iFrameInterval", Number(opt.value));
                }
            });

            row.appendChild(btn);
            buttons.push(btn);
        });

        wrap.appendChild(row);
        container.appendChild(wrap);

        return {
            setActive(value) {
                buttons.forEach((b) => {
                    b.classList.toggle("active", b.dataset.value === String(value));
                });
            },
            setDirty(isDirty) {
                wrap.classList.toggle("is-dirty", isDirty);
            }
        };
    }

    function buildParamGroups() {
        if (!els.paramGroups) return;
        els.paramGroups.innerHTML = "";
        Object.keys(segmentGroups).forEach((k) => delete segmentGroups[k]);

        segmentGroups.resolution = createSegmentGroup(
            els.paramGroups,
            "resolution",
            t("controlPanel.resolution.label"),
            OPT.resolutions.map((r) => ({
                value: `${r.width}x${r.height}`,
                label: r.label === "1600×900" ? "1600×900" : `${r.width}×${r.height}\n(${r.label})`
            }))
        );

        segmentGroups.fps = createSegmentGroup(
            els.paramGroups,
            "fps",
            t("controlPanel.fps"),
            OPT.fps.map((v) => ({ value: String(v), label: String(v) }))
        );

        segmentGroups.dpi = createSegmentGroup(
            els.paramGroups,
            "dpi",
            t("controlPanel.dpi.label"),
            OPT.dpi.map((d) => ({ value: String(d.value), label: `${d.value}\n${d.label}` }))
        );

        segmentGroups.bitrate = createSegmentGroup(
            els.paramGroups,
            "bitrate",
            t("controlPanel.bitrate"),
            OPT.bitRateMbps.map((v) => ({ value: String(v), label: String(v) }))
        );

        segmentGroups.gop = createSegmentGroup(
            els.paramGroups,
            "gop",
            t("controlPanel.gop.label"),
            OPT.iFrameInterval.map((g) => ({
                value: String(g.value),
                label: g.value === 1
                    ? `1 s\n(${t("controlPanel.gop.fast")})`
                    : g.value === 10
                        ? `10 s\n(${t("controlPanel.gop.slow")})`
                        : t("controlPanel.gop.seconds", { value: g.value })
            }))
        );

        syncSegmentUI();
    }

    function sessionsFromTabBar() {
        const tabs = document.querySelectorAll("#tabs-bar .scrcpy-tab");
        if (!tabs.length) return [];
        return Array.from(tabs).map((tab) => {
            const labelEl = tab.querySelector(".tab-label");
            const raw = labelEl?.textContent?.replace(/\s+/g, " ").trim() || tab.dataset.tabId;
            const badge = labelEl?.querySelector(".session-type-badge");
            const label = badge ? raw.replace(badge.textContent, "").trim() : raw;
            return {
                sessionId: tab.dataset.tabId,
                type: tab.dataset.sessionType || "A",
                label: label || tab.dataset.tabId,
                active: tab.classList.contains("active")
            };
        });
    }

    async function fetchSessions() {
        let list = [];
        try {
            if (window.sessionAPI?.list) {
                list = await window.sessionAPI.list();
            }
        } catch (err) {
            console.warn("[ControlPanel] sessionAPI.list erreur:", err);
        }
        if (list.length > 0) return list;
        return sessionsFromTabBar();
    }

    function renderSessionList() {
        if (!els.sessionList) return;
        els.sessionList.innerHTML = "";

        const previewHook = window.videoPreviewHook;

        if (!state.sessions.length) {
            const empty = document.createElement("p");
            empty.className = "control-empty";
            empty.textContent = t("controlPanel.noSessions");
            els.sessionList.appendChild(empty);
            updateSessionMeta();
            return;
        }

        state.sessions.forEach((session) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "control-session-item";
            if (session.sessionId === state.selectedSessionId) item.classList.add("active");
            if (session.active) item.classList.add("is-focused");

            item.innerHTML = `
                <span class="control-session-type">${t("controlPanel.sessionType", { type: session.type })}</span>
                <span class="control-session-label">${session.label || session.sessionId}</span>
                ${session.active ? `<span class="control-session-badge">${t("controlPanel.active")}</span>` : ""}
            `;

            item.addEventListener("click", () => {
                selectSession(session.sessionId).catch(console.error);
            });

            if (previewHook?.attach) {
                previewHook.attach(item, session.sessionId);
            }

            els.sessionList.appendChild(item);
        });

        updateSessionMeta();
    }

    async function loadSessionParams(sessionId) {
        if (!window.sessionAPI?.getStreamParams) {
            state.selectedSessionId = sessionId;
            state.appliedParams = SP.normalizeParams(DEFAULT_PARAMS);
            state.draftParams = SP.cloneParams(state.appliedParams);
            updateSessionMeta();
            updateAppliedDisplay();
            syncSegmentUI();
            updateDirtyState();
            return;
        }

        const result = await window.sessionAPI.getStreamParams(sessionId);
        if (!result?.success) {
            setStatus(result?.error || t("controlPanel.validation.loadFailed"), "error");
            return;
        }

        state.selectedSessionId = sessionId;
        state.sessionType = result.type;
        state.appliedParams = SP.normalizeParams(result.params);
        state.draftParams = SP.cloneParams(state.appliedParams);

        updateSessionMeta();
        updateAppliedDisplay();
        syncSegmentUI();
        updateDirtyState();
    }

    async function selectSession(sessionId) {
        state.selectedSessionId = sessionId;
        renderSessionList();
        await loadSessionParams(sessionId);
        setStatus("");
    }

    async function refreshSessions() {
        const previousSelection = state.selectedSessionId;
        state.sessions = await fetchSessions();

        if (state.sessions.length === 0) {
            state.selectedSessionId = null;
            state.appliedParams = null;
            renderSessionList();
            updateAppliedDisplay();
            updateDirtyState();
            return;
        }

        const stillExists = previousSelection
            && state.sessions.some((s) => s.sessionId === previousSelection);

        const active = state.sessions.find((s) => s.active);
        const targetId = stillExists
            ? previousSelection
            : (active?.sessionId || state.sessions[0].sessionId);

        await selectSession(targetId);
        renderSessionList();
    }

    async function applyChanges() {
        if (!state.selectedSessionId) {
            setStatus(t("controlPanel.validation.selectBeforeApply"), "error");
            return;
        }

        const validation = SP.validateParams(readDraftParams());
        if (!validation.valid) {
            setStatus(validation.errors.join(" · "), "error");
            return;
        }

        if (!window.sessionAPI?.applyStreamParams) {
            setStatus(t("controlPanel.validation.apiUnavailable"), "error");
            return;
        }

        setLoading(true);
        setStatus(t("controlPanel.validation.applying"));

        try {
            const result = await window.sessionAPI.applyStreamParams(
                state.selectedSessionId,
                validation.params
            );

            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.validation.applyFailed"), "error");
                return;
            }

            state.appliedParams = SP.normalizeParams(result.params);
            state.draftParams = SP.cloneParams(state.appliedParams);
            updateAppliedDisplay();
            syncSegmentUI();
            setStatus(result.message || t("controlPanel.validation.applied"), "success");
        } catch (err) {
            setStatus(err.message || t("controlPanel.validation.unexpectedError"), "error");
        } finally {
            setLoading(false);
        }
    }

    function cancelChanges() {
        if (state.appliedParams && state.selectedSessionId) {
            state.draftParams = SP.cloneParams(state.appliedParams);
            setStatus(t("controlPanel.validation.cancelWithSession"));
        } else {
            state.draftParams = SP.cloneParams(DEFAULT_PARAMS);
            setStatus(t("controlPanel.validation.cancelDefault"));
        }
        syncSegmentUI();
        updateDirtyState();
    }

    async function resetToOriginal() {
        if (!state.selectedSessionId) {
            setStatus(t("controlPanel.validation.selectBeforeReset"), "error");
            return;
        }

        const confirmed = window.confirm(t("controlPanel.validation.resetConfirm"));
        if (!confirmed) return;

        setLoading(true);
        setStatus(t("controlPanel.validation.resetting"));

        try {
            const result = await window.sessionAPI.resetStreamParams(state.selectedSessionId);
            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.validation.resetFailed"), "error");
                return;
            }

            await loadSessionParams(state.selectedSessionId);
            setStatus(t("controlPanel.validation.resetDone"), "success");
        } catch (err) {
            setStatus(err.message || t("controlPanel.validation.unexpectedError"), "error");
        } finally {
            setLoading(false);
        }
    }

    function bindEvents() {
        if (els.btnApply && !els.btnApply._bound) {
            els.btnApply._bound = true;
            els.btnApply.addEventListener("click", () => applyChanges().catch(console.error));
        }
        if (els.btnCancel && !els.btnCancel._bound) {
            els.btnCancel._bound = true;
            els.btnCancel.addEventListener("click", cancelChanges);
        }
        if (els.btnReset && !els.btnReset._bound) {
            els.btnReset._bound = true;
            els.btnReset.addEventListener("click", () => resetToOriginal().catch(console.error));
        }

        if (!window.__controlPanelEventsBound) {
            window.__controlPanelEventsBound = true;
            window.sessionAPI?.onSessionListChanged?.(() => {
                refreshSessions().catch(console.error);
            });
            window.sessionAPI?.onSessionActivated?.(() => {
                refreshSessions().catch(console.error);
            });
            window.addEventListener("custom-names-updated", () => {
                refreshSessions().catch(console.error);
            });
        }
    }

    function cacheElements() {
        els.sessionList = $("control-session-list");
        els.paramGroups = $("control-param-groups");
        els.sessionMeta = $("control-session-meta");
        els.currentValues = $("control-current-values");
        els.btnApply = $("control-btn-apply");
        els.btnCancel = $("control-btn-cancel");
        els.btnReset = $("control-btn-reset");
        els.statusMessage = $("control-status-message");
        els.loadingOverlay = $("control-loading-overlay");
    }

    function ensureUI() {
        SP = getSP();
        OPT = SP.CONTROL_OPTIONS || getFallbackOptions();
        cacheElements();
        if (!els.paramGroups) {
            console.error("[ControlPanel] #control-param-groups introuvable");
            return false;
        }
        buildParamGroups();
        bindEvents();
        state.uiReady = true;
        updateSessionMeta();
        updateAppliedDisplay();
        updateDirtyState();
        return true;
    }

    window.openControlPanel = async function openControlPanel(options = {}) {
        if (!options.inChildWindow && !/hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"))) {
            if (window.hubModalAPI) {
                await window.hubModalAPI.open({ panel: "control" });
            }
            return;
        }

        if (!ensureUI()) {
            setStatus(t("controlPanel.validation.unexpectedError"), "error");
            return;
        }

        await refreshSessions();
    };

    window.refreshControlPanel = refreshSessions;

    function boot() {
        try {
            ensureUI();
            renderSessionList();
        } catch (err) {
            console.error("[ControlPanel] Erreur initialisation:", err);
        }
    }

    globalThis.HubI18n?.onChange?.(() => {
        if (!state.uiReady) return;
        SP = getSP();
        OPT = SP.CONTROL_OPTIONS || getFallbackOptions();
        buildParamGroups();
        updateSessionMeta();
        updateAppliedDisplay();
        renderSessionList();
        globalThis.HubI18n?.applyDomI18n?.(document.getElementById("panel-control") || document);
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
