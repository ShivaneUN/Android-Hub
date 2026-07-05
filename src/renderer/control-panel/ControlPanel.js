/**
 * Panneau de contrôle — entièrement autonome (ne dépend pas du chargement externe de StreamParams).
 */
(function initControlPanel() {
    const FALLBACK_OPTIONS = {
        resolutions: [
            { width: 1920, height: 1080, label: "FULL HD" },
            { width: 1600, height: 900, label: "1600×900" },
            { width: 1280, height: 720, label: "HD" },
            { width: 960, height: 540, label: "qHD" }
        ],
        fps: [120, 60, 30],
        dpi: [
            { value: 420, label: "Natif" },
            { value: 320, label: "320" },
            { value: 280, label: "280" },
            { value: 240, label: "Normal" },
            { value: 200, label: "200" },
            { value: 160, label: "Moyen" },
            { value: 120, label: "Très gros" }
        ],
        bitRateMbps: [1, 2, 4, 6, 8, 12, 16, 24],
        iFrameInterval: [
            { value: 1, label: "Rapide" },
            { value: 2, label: "2 s" },
            { value: 3, label: "3 s" },
            { value: 5, label: "5 s" },
            { value: 10, label: "Lent" }
        ]
    };

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
                return `${n.width}×${n.height} · ${n.dpi} dpi · ${n.maxFps} fps · ${n.bitRateMbps} Mbps · GOP ${n.iFrameInterval}s`;
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
            els.sessionMeta.textContent = "Aucune instance sélectionnée — choisissez une session ci-dessus";
            return;
        }
        const session = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
        const label = session?.label || state.selectedSessionId;
        const type = session?.type || state.sessionType || "?";
        els.sessionMeta.textContent = `${label} · Type ${type}`;
    }

    function updateAppliedDisplay() {
        if (!els.currentValues) return;
        if (state.appliedParams && state.selectedSessionId) {
            els.currentValues.textContent = SP.formatParamsSummary(state.appliedParams);
        } else {
            els.currentValues.textContent = "Sélectionnez une instance pour afficher ses paramètres actifs";
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
            "Résolution",
            OPT.resolutions.map((r) => ({
                value: `${r.width}x${r.height}`,
                label: r.label === "1600×900" ? "1600×900" : `${r.width}×${r.height}\n(${r.label})`
            }))
        );

        segmentGroups.fps = createSegmentGroup(
            els.paramGroups,
            "fps",
            "FPS",
            OPT.fps.map((v) => ({ value: String(v), label: String(v) }))
        );

        segmentGroups.dpi = createSegmentGroup(
            els.paramGroups,
            "dpi",
            "DPI",
            OPT.dpi.map((d) => ({ value: String(d.value), label: `${d.value}\n${d.label}` }))
        );

        segmentGroups.bitrate = createSegmentGroup(
            els.paramGroups,
            "bitrate",
            "Bitrate (Mbps)",
            OPT.bitRateMbps.map((v) => ({ value: String(v), label: String(v) }))
        );

        segmentGroups.gop = createSegmentGroup(
            els.paramGroups,
            "gop",
            "I-frame Interval (GOP)",
            OPT.iFrameInterval.map((g) => ({
                value: String(g.value),
                label: g.value === 1 ? "1 s\n(Rapide)" : g.value === 10 ? "10 s\n(Lent)" : `${g.value} s`
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
            empty.textContent = "Aucune instance détectée — les paramètres restent modifiables";
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
                <span class="control-session-type">Type ${session.type}</span>
                <span class="control-session-label">${session.label || session.sessionId}</span>
                ${session.active ? '<span class="control-session-badge">Active</span>' : ""}
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
            setStatus(result?.error || "Impossible de charger les paramètres", "error");
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
            setStatus("Sélectionnez une instance avant d'appliquer les paramètres.", "error");
            return;
        }

        const validation = SP.validateParams(readDraftParams());
        if (!validation.valid) {
            setStatus(validation.errors.join(" · "), "error");
            return;
        }

        if (!window.sessionAPI?.applyStreamParams) {
            setStatus("API backend indisponible.", "error");
            return;
        }

        setLoading(true);
        setStatus("Application des paramètres…");

        try {
            const result = await window.sessionAPI.applyStreamParams(
                state.selectedSessionId,
                validation.params
            );

            if (!result?.success) {
                setStatus(result?.error || "Échec de l'application", "error");
                return;
            }

            state.appliedParams = SP.normalizeParams(result.params);
            state.draftParams = SP.cloneParams(state.appliedParams);
            updateAppliedDisplay();
            syncSegmentUI();
            setStatus(result.message || "Paramètres appliqués avec succès.", "success");
        } catch (err) {
            setStatus(err.message || "Erreur inattendue", "error");
        } finally {
            setLoading(false);
        }
    }

    function cancelChanges() {
        if (state.appliedParams && state.selectedSessionId) {
            state.draftParams = SP.cloneParams(state.appliedParams);
            setStatus("Modifications annulées — valeurs de la session rechargées.");
        } else {
            state.draftParams = SP.cloneParams(DEFAULT_PARAMS);
            setStatus("Modifications annulées — valeurs par défaut rechargées.");
        }
        syncSegmentUI();
        updateDirtyState();
    }

    async function resetToOriginal() {
        if (!state.selectedSessionId) {
            setStatus("Sélectionnez une instance avant de réinitialiser.", "error");
            return;
        }

        const confirmed = window.confirm(
            "Réinitialiser les paramètres de cette session à leurs valeurs d'origine ?\n\nLe flux sera redémarré."
        );
        if (!confirmed) return;

        setLoading(true);
        setStatus("Réinitialisation en cours…");

        try {
            const result = await window.sessionAPI.resetStreamParams(state.selectedSessionId);
            if (!result?.success) {
                setStatus(result?.error || "Échec de la réinitialisation", "error");
                return;
            }

            await loadSessionParams(state.selectedSessionId);
            setStatus("Paramètres d'origine restaurés.", "success");
        } catch (err) {
            setStatus(err.message || "Erreur inattendue", "error");
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
        OPT = SP.CONTROL_OPTIONS || FALLBACK_OPTIONS;
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
            setStatus("Erreur d'initialisation du panneau.", "error");
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

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
