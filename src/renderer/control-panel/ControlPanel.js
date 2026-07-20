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
            ],
            videoCodec: [
                { value: "h264", label: t("controlPanel.videoCodec.h264") },
                { value: "h265", label: t("controlPanel.videoCodec.h265") }
            ]
        };
    }

    const DEFAULT_PARAMS = {
        width: 1920,
        height: 1080,
        dpi: 240,
        maxFps: 60,
        bitRateMbps: 8,
        iFrameInterval: 1,
        videoCodec: "h264"
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
                const codecValues = FALLBACK_OPTIONS.videoCodec.map((c) => c.value);
                return {
                    width: res.width,
                    height: res.height,
                    dpi: snap(base.dpi, FALLBACK_OPTIONS.dpi.map((d) => d.value)),
                    maxFps: snap(base.maxFps, FALLBACK_OPTIONS.fps),
                    bitRateMbps: snap(base.bitRateMbps, FALLBACK_OPTIONS.bitRateMbps),
                    iFrameInterval: snap(base.iFrameInterval, FALLBACK_OPTIONS.iFrameInterval.map((g) => g.value)),
                    videoCodec: codecValues.includes(base.videoCodec) ? base.videoCodec : DEFAULT_PARAMS.videoCodec
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
        uiReady: false,
        presets: [],
        defaultPresetId: null,
        selectedPresetId: null
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
        segmentGroups.videoCodec?.setActive(String(p.videoCodec || "h264"));
    }

    function syncVideoCodecLock() {
        const locked = state.sessions.length > 0;
        segmentGroups.videoCodec?.setDisabled(
            locked,
            t("controlPanel.videoCodec.lockedHint")
        );
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
        if (draft.videoCodec !== reference.videoCodec) dirtyKeys.add("videoCodec");

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
        if (!active) {
            updateDirtyState();
        } else {
            if (els.btnApply) els.btnApply.disabled = true;
            if (els.btnCancel) els.btnCancel.disabled = true;
            if (els.btnReset) els.btnReset.disabled = true;
        }
        syncPresetControls();
    }

    function syncPresetControls() {
        const busy = state.isApplying;
        if (els.presetSelect) els.presetSelect.disabled = busy;
        if (els.presetNameInput) els.presetNameInput.disabled = busy;
        if (els.btnSavePreset) els.btnSavePreset.disabled = busy;
        if (els.btnApplyAll) {
            els.btnApplyAll.disabled = busy
                || typeof window.displayPresetsAPI?.updateDefaultFromParams !== "function";
        }
        syncPresetDefaultCheckbox();
    }

    function syncPresetDefaultCheckbox() {
        if (!els.presetSetDefault) return;
        const presetId = els.presetSelect?.value || "";
        const isDefault = Boolean(presetId) && presetId === state.defaultPresetId;
        els.presetSetDefault.checked = isDefault;
        els.presetSetDefault.disabled = !presetId || state.isApplying || isDefault;
    }

    function renderPresetSelect() {
        if (!els.presetSelect) return;

        const previous = els.presetSelect.value;
        els.presetSelect.innerHTML = "";

        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = t("controlPanel.presets.none");
        els.presetSelect.appendChild(emptyOption);

        state.presets.forEach((preset) => {
            const option = document.createElement("option");
            option.value = preset.id;
            const defaultMark = preset.id === state.defaultPresetId ? " ★" : "";
            option.textContent = `${preset.name}${defaultMark}`;
            els.presetSelect.appendChild(option);
        });

        const targetId = (previous && state.presets.some((preset) => preset.id === previous))
            ? previous
            : (state.selectedPresetId || "");
        els.presetSelect.value = targetId;
        syncPresetControls();
    }

    async function loadPresets() {
        if (!window.displayPresetsAPI?.list) {
            state.presets = [];
            state.defaultPresetId = null;
            renderPresetSelect();
            return;
        }

        try {
            const result = await window.displayPresetsAPI.list();
            if (!result?.success) {
                setStatus(t("controlPanel.presets.loadFailed"), "error");
                return;
            }
            state.presets = result.presets || [];
            state.defaultPresetId = result.defaultPreset || null;
            renderPresetSelect();
        } catch (err) {
            setStatus(err.message || t("controlPanel.presets.loadFailed"), "error");
        }
    }

    async function applyPresetToDraft(presetId) {
        if (!presetId || !window.displayPresetsAPI?.resolveParams) return;

        const result = await window.displayPresetsAPI.resolveParams(presetId);
        if (!result?.success || !result.params) {
            setStatus(t("controlPanel.presets.loadFailed"), "error");
            return;
        }

        state.draftParams = SP.cloneParams(result.params);
        syncSegmentUI();
        updateDirtyState();
    }

    async function onPresetSelectChange() {
        const presetId = els.presetSelect?.value || "";
        state.selectedPresetId = presetId || null;
        syncPresetDefaultCheckbox();
        if (!presetId) return;
        await applyPresetToDraft(presetId);
    }

    async function saveCurrentPreset() {
        if (!window.displayPresetsAPI?.save) {
            setStatus(t("controlPanel.validation.apiUnavailable"), "error");
            return;
        }

        const name = els.presetNameInput?.value?.trim() || "";
        if (!name) {
            setStatus(t("controlPanel.presets.nameEmpty"), "error");
            els.presetNameInput?.focus();
            return;
        }

        const draft = readDraftParams();

        setLoading(true);
        setStatus(t("controlPanel.validation.applying"));

        try {
            const result = await window.displayPresetsAPI.save({
                name,
                params: {
                    width: draft.width,
                    height: draft.height,
                    maxFps: draft.maxFps,
                    bitRateMbps: draft.bitRateMbps,
                    videoCodec: draft.videoCodec
                }
            });

            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.presets.saveFailed"), "error");
                return;
            }

            if (els.presetNameInput) els.presetNameInput.value = "";
            state.selectedPresetId = result.preset?.id || null;
            await loadPresets();
            if (state.selectedPresetId && els.presetSelect) {
                els.presetSelect.value = state.selectedPresetId;
            }
            syncPresetControls();
            setStatus(
                t("controlPanel.presets.saved", { name: result.preset?.name || name }),
                "success"
            );
        } catch (err) {
            setStatus(err.message || t("controlPanel.presets.saveFailed"), "error");
        } finally {
            setLoading(false);
        }
    }

    async function setSelectedPresetAsDefault() {
        const presetId = els.presetSelect?.value;
        if (!presetId || presetId === state.defaultPresetId) return;
        if (!window.displayPresetsAPI?.setDefault) {
            setStatus(t("controlPanel.validation.apiUnavailable"), "error");
            return;
        }

        setLoading(true);

        try {
            const result = await window.displayPresetsAPI.setDefault(presetId);
            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.presets.defaultSetFailed"), "error");
                return;
            }

            state.defaultPresetId = result.defaultPreset;
            const preset = state.presets.find((item) => item.id === presetId);
            await loadPresets();
            if (els.presetSelect) els.presetSelect.value = presetId;
            setStatus(
                t("controlPanel.presets.defaultSet", { name: preset?.name || presetId }),
                "success"
            );
        } catch (err) {
            setStatus(err.message || t("controlPanel.presets.defaultSetFailed"), "error");
        } finally {
            setLoading(false);
        }
    }

    async function applyToAllInstances() {
        if (!window.displayPresetsAPI?.updateDefaultFromParams) {
            setStatus(t("controlPanel.presets.applyAllUnavailable"), "error");
            return;
        }

        const validation = SP.validateParams(readDraftParams());
        if (!validation.valid) {
            setStatus(validation.errors.join(" · "), "error");
            return;
        }

        const draft = validation.params;
        setStatus(t("controlPanel.presets.applyingAll"));

        try {
            const result = await window.displayPresetsAPI.updateDefaultFromParams({
                width: draft.width,
                height: draft.height,
                maxFps: draft.maxFps,
                bitRateMbps: draft.bitRateMbps,
                videoCodec: draft.videoCodec
            });

            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.presets.applyAllFailed"), "error");
                return;
            }

            state.defaultPresetId = result.defaultPreset || state.defaultPresetId;
            state.selectedPresetId = result.defaultPreset || state.selectedPresetId;
            await loadPresets();
            if (els.presetSelect && result.defaultPreset) {
                els.presetSelect.value = result.defaultPreset;
            }
            syncPresetControls();
            setStatus(result.message || t("controlPanel.presets.appliedAll"), "success");
        } catch (err) {
            setStatus(err.message || t("controlPanel.presets.applyAllFailed"), "error");
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

    function createSegmentGroup(container, groupKey, label, options, tipText = "") {
        const wrap = document.createElement("div");
        wrap.className = "control-param-group";
        wrap.dataset.group = groupKey;

        const title = document.createElement("div");
        title.className = "control-param-label";

        const labelText = document.createElement("span");
        labelText.className = "control-param-label-text";
        labelText.textContent = label;
        title.appendChild(labelText);

        if (tipText) {
            const help = document.createElement("button");
            help.type = "button";
            help.className = "control-param-help";
            help.textContent = "?";
            help.dataset.tip = tipText;
            help.setAttribute("aria-label", tipText);
            help.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            title.appendChild(help);
        }

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
                if (row.classList.contains("is-disabled")) return;
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
                } else if (groupKey === "videoCodec") {
                    setDraftParam("videoCodec", opt.value);
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
            },
            setDisabled(disabled, disabledTitle = "") {
                row.classList.toggle("is-disabled", Boolean(disabled));
                const hint = disabled ? disabledTitle : "";
                wrap.title = hint;
                row.title = hint;
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
            })),
            t("controlPanel.tips.resolution")
        );

        segmentGroups.fps = createSegmentGroup(
            els.paramGroups,
            "fps",
            t("controlPanel.fps"),
            OPT.fps.map((v) => ({ value: String(v), label: String(v) })),
            t("controlPanel.tips.fps")
        );

        segmentGroups.dpi = createSegmentGroup(
            els.paramGroups,
            "dpi",
            t("controlPanel.dpi.label"),
            OPT.dpi.map((d) => ({ value: String(d.value), label: `${d.value}\n${d.label}` })),
            t("controlPanel.tips.dpi")
        );

        segmentGroups.bitrate = createSegmentGroup(
            els.paramGroups,
            "bitrate",
            t("controlPanel.bitrate"),
            OPT.bitRateMbps.map((v) => ({ value: String(v), label: String(v) })),
            t("controlPanel.tips.bitrate")
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
            })),
            t("controlPanel.tips.gop")
        );

        const codecOptions = OPT.videoCodec || [
            { value: "h264" },
            { value: "h265" }
        ];
        segmentGroups.videoCodec = createSegmentGroup(
            els.paramGroups,
            "videoCodec",
            t("controlPanel.videoCodec.label"),
            codecOptions.map((c) => ({
                value: String(c.value),
                label: t(`controlPanel.videoCodec.${c.value}`)
            })),
            t("controlPanel.tips.videoCodec")
        );

        syncSegmentUI();
        syncVideoCodecLock();
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
        syncVideoCodecLock();

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
        if (els.presetSelect && !els.presetSelect._bound) {
            els.presetSelect._bound = true;
            els.presetSelect.addEventListener("change", () => {
                onPresetSelectChange().catch(console.error);
            });
        }
        if (els.presetSetDefault && !els.presetSetDefault._bound) {
            els.presetSetDefault._bound = true;
            els.presetSetDefault.addEventListener("change", () => {
                if (els.presetSetDefault.checked) {
                    setSelectedPresetAsDefault().catch(console.error);
                } else {
                    syncPresetDefaultCheckbox();
                }
            });
        }
        if (els.btnSavePreset && !els.btnSavePreset._bound) {
            els.btnSavePreset._bound = true;
            els.btnSavePreset.addEventListener("click", () => saveCurrentPreset().catch(console.error));
        }
        if (els.presetNameInput && !els.presetNameInput._bound) {
            els.presetNameInput._bound = true;
            els.presetNameInput.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    saveCurrentPreset().catch(console.error);
                }
            });
        }
        if (els.btnApplyAll && !els.btnApplyAll._bound) {
            els.btnApplyAll._bound = true;
            els.btnApplyAll.addEventListener("click", () => applyToAllInstances().catch(console.error));
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
            window.displayPresetsAPI?.onUpdated?.(() => {
                loadPresets().catch(console.error);
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
        els.presetSelect = $("control-preset-select");
        els.presetNameInput = $("control-preset-name-input");
        els.presetSetDefault = $("control-preset-set-default");
        els.btnSavePreset = $("control-btn-save-preset");
        els.btnApplyAll = $("control-btn-apply-all");
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

    async function ensureUIAsync() {
        if (!ensureUI()) return false;
        await loadPresets();
        return true;
    }

    window.openControlPanel = async function openControlPanel(options = {}) {
        if (!options.inChildWindow && !/hub-modal-window\.html$/i.test(location.pathname.replace(/\\/g, "/"))) {
            if (window.openSettingsPanel) {
                await window.openSettingsPanel({ tab: "control" });
            } else if (window.hubModalAPI) {
                await window.hubModalAPI.open({ panel: "settings", tab: "control" });
            }
            return;
        }

        if (!(await ensureUIAsync())) {
            setStatus(t("controlPanel.validation.unexpectedError"), "error");
            return;
        }

        await refreshSessions();
    };

    window.refreshControlPanel = refreshSessions;

    function boot() {
        try {
            ensureUI();
            loadPresets().catch(console.error);
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
        renderPresetSelect();
        updateSessionMeta();
        updateAppliedDisplay();
        renderSessionList();
        globalThis.HubI18n?.applyDomI18n?.(document.getElementById("panel-settings") || document);
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
