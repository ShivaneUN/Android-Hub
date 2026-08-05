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
        presetTransport: "usb",
        defaultPresetUsbId: null,
        defaultPresetWifiId: null,
        defaultPresetId: null,
        selectedPresetId: null,
        ignorePresetUpdatedDraftReload: false
    };

    const els = {};
    const segmentGroups = {};

    function $(id) {
        return document.getElementById(id);
    }

    function getActiveDefaultPresetId() {
        return state.presetTransport === "wifi"
            ? state.defaultPresetWifiId
            : state.defaultPresetUsbId;
    }

    function syncTransportUi() {
        const wifi = state.presetTransport === "wifi";
        document.querySelectorAll("[data-preset-transport]").forEach((btn) => {
            const active = btn.getAttribute("data-preset-transport") === state.presetTransport;
            btn.classList.toggle("is-active", active);
            btn.setAttribute("aria-pressed", active ? "true" : "false");
            btn.disabled = state.isApplying;
        });
        if (els.presetSetDefaultLabel) {
            els.presetSetDefaultLabel.setAttribute(
                "data-i18n",
                wifi ? "controlPanel.presets.setDefaultWifi" : "controlPanel.presets.setDefaultUsb"
            );
            els.presetSetDefaultLabel.textContent = wifi
                ? t("controlPanel.presets.setDefaultWifi")
                : t("controlPanel.presets.setDefaultUsb");
        }
        if (els.presetApplyAllHint) {
            els.presetApplyAllHint.setAttribute(
                "data-i18n",
                wifi ? "controlPanel.presets.applyAllHintWifi" : "controlPanel.presets.applyAllHintUsb"
            );
            els.presetApplyAllHint.textContent = wifi
                ? t("controlPanel.presets.applyAllHintWifi")
                : t("controlPanel.presets.applyAllHintUsb");
        }
        if (els.btnResetFactory) {
            els.btnResetFactory.setAttribute(
                "data-i18n",
                wifi ? "controlPanel.presets.resetFactoryWifi" : "controlPanel.presets.resetFactoryUsb"
            );
            els.btnResetFactory.textContent = wifi
                ? t("controlPanel.presets.resetFactoryWifi")
                : t("controlPanel.presets.resetFactoryUsb");
        }
    }

    async function setPresetTransport(transport) {
        const next = transport === "wifi" ? "wifi" : "usb";
        if (state.presetTransport === next) return;
        state.presetTransport = next;
        state.defaultPresetId = getActiveDefaultPresetId();
        syncTransportUi();
        renderPresetSelect();
        syncPresetControls();
        if (!state.selectedSessionId) {
            await loadDefaultDraftFromPreset();
        }
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
        if (isPerformanceModeOn()) updateCurrentPresetLabel();
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
        if (els.btnResetFactory) {
            els.btnResetFactory.disabled = busy
                || typeof window.displayPresetsAPI?.resetTransportToFactory !== "function";
        }
        if (els.btnDeletePreset) {
            const presetId = els.presetSelect?.value || "";
            const canDelete = Boolean(presetId)
                && state.presets.length > 1
                && typeof window.displayPresetsAPI?.delete === "function";
            els.btnDeletePreset.disabled = busy || !canDelete;
        }
        syncPresetDefaultCheckbox();
        updateCurrentPresetLabel();
    }

    function syncPresetDefaultCheckbox() {
        if (!els.presetSetDefault) return;
        const presetId = els.presetSelect?.value || "";
        const activeDefaultId = getActiveDefaultPresetId();
        const isDefault = Boolean(presetId) && presetId === activeDefaultId;
        els.presetSetDefault.checked = isDefault;
        els.presetSetDefault.disabled = !presetId || state.isApplying || isDefault;
    }

    function getDefaultPreset(transport = state.presetTransport) {
        const id = transport === "wifi" ? state.defaultPresetWifiId : state.defaultPresetUsbId;
        return state.presets.find((preset) => preset.id === id) || null;
    }

    function getPerformanceResolution() {
        const res = SP.PERFORMANCE_STREAM_RESOLUTION;
        if (res?.width && res?.height) return { width: res.width, height: res.height };
        return { width: 960, height: 540 };
    }

    function isPerformanceModeOn() {
        return window.HubPerformance?.getPrefs?.()?.performanceMode === true;
    }

    function applyPerformanceResolutionToDraft({ markApplied = false } = {}) {
        const res = getPerformanceResolution();
        state.draftParams = SP.normalizeParams({
            ...readDraftParams(),
            width: res.width,
            height: res.height
        });
        if (markApplied || !state.selectedSessionId) {
            state.appliedParams = SP.cloneParams(state.draftParams);
        }
        syncSegmentUI();
        updateDirtyState();
        updateAppliedDisplay();
        updateCurrentPresetLabel();
    }

    function updateCurrentPresetLabel(prefsOverride = null) {
        if (!els.presetCurrent) return;
        const modeOn = prefsOverride
            ? prefsOverride.performanceMode === true
            : isPerformanceModeOn();
        if (modeOn) {
            const res = getPerformanceResolution();
            const draft = readDraftParams();
            const resolution = `${draft.width || res.width}×${draft.height || res.height}`;
            els.presetCurrent.textContent = t("controlPanel.presets.performanceActive", {
                resolution
            });
            els.presetCurrent.classList.add("is-perf-mode");
            return;
        }
        els.presetCurrent.classList.remove("is-perf-mode");
        const usbPreset = getDefaultPreset("usb");
        const wifiPreset = getDefaultPreset("wifi");
        const usbName = usbPreset?.name || "—";
        const wifiName = wifiPreset?.name || "—";
        els.presetCurrent.textContent = t("controlPanel.presets.currentBoth", {
            usb: usbName,
            wifi: wifiName
        });
    }

    async function onPerformancePrefsChanged(prefs = {}) {
        const modeOn = prefs.performanceMode === true;
        if (!modeOn) {
            await loadPresets();
            if (!state.selectedSessionId) {
                await loadDefaultDraftFromPreset();
            }
            updateCurrentPresetLabel(prefs);
            if (els.statusMessage?.dataset?.perfMode === "1") {
                setStatus("");
                if (els.statusMessage) delete els.statusMessage.dataset.perfMode;
            }
            return;
        }

        await loadPresets();
        applyPerformanceResolutionToDraft({ markApplied: !state.selectedSessionId });
        updateCurrentPresetLabel(prefs);
        const res = getPerformanceResolution();
        setStatus(
            t("controlPanel.presets.performanceActive", {
                resolution: `${res.width}×${res.height}`
            }),
            "success"
        );
        if (els.statusMessage) els.statusMessage.dataset.perfMode = "1";
    }

    function renderPresetSelect() {
        if (!els.presetSelect) return;

        const previous = els.presetSelect.value;
        const keepSelectedId = state.selectedPresetId;
        els.presetSelect.innerHTML = "";

        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = t("controlPanel.presets.none");
        els.presetSelect.appendChild(emptyOption);

        const activeDefaultId = getActiveDefaultPresetId();
        state.presets.forEach((preset) => {
            const option = document.createElement("option");
            option.value = preset.id;
            const marks = [];
            if (preset.id === state.defaultPresetUsbId) marks.push("USB");
            if (preset.id === state.defaultPresetWifiId) marks.push("Wi‑Fi");
            const defaultMark = marks.length ? ` ★${marks.join("/")}` : "";
            const activeMark = preset.id === activeDefaultId && !marks.length ? " ★" : "";
            option.textContent = `${preset.name}${defaultMark || activeMark}`;
            els.presetSelect.appendChild(option);
        });

        let targetId = "";
        if (keepSelectedId && state.presets.some((preset) => preset.id === keepSelectedId)) {
            targetId = keepSelectedId;
        } else if (previous && state.presets.some((preset) => preset.id === previous)) {
            targetId = previous;
        } else if (activeDefaultId && state.presets.some((preset) => preset.id === activeDefaultId)) {
            targetId = activeDefaultId;
        }

        els.presetSelect.value = targetId;
        state.selectedPresetId = targetId || null;
        syncTransportUi();
        syncPresetControls();
    }

    async function loadPresets() {
        if (!window.displayPresetsAPI?.list) {
            state.presets = [];
            state.defaultPresetUsbId = null;
            state.defaultPresetWifiId = null;
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
            state.defaultPresetUsbId = result.defaultPresetUsb || result.defaultPreset || null;
            state.defaultPresetWifiId = result.defaultPresetWifi || null;
            state.defaultPresetId = getActiveDefaultPresetId();
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

        // Toujours les valeurs brutes du preset sauvegardé (jamais l'overlay perf).
        const params = SP.normalizeParams(result.params);
        state.draftParams = SP.cloneParams(params);
        if (!state.selectedSessionId) {
            state.appliedParams = SP.cloneParams(params);
        }
        syncSegmentUI();
        updateDirtyState();
        updateAppliedDisplay();
        updateCurrentPresetLabel();
        setStatus(
            t("controlPanel.presets.loaded", {
                name: state.presets.find((item) => item.id === presetId)?.name || presetId,
                resolution: `${params.width}×${params.height}`
            }),
            "info"
        );
    }

    async function onPresetSelectChange() {
        const presetId = els.presetSelect?.value || "";
        state.selectedPresetId = presetId || null;
        syncPresetDefaultCheckbox();
        if (!presetId) return;
        await applyPresetToDraft(presetId);
    }

    async function saveCurrentPreset() {
        if (state.isApplying) return;
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

        state.ignorePresetUpdatedDraftReload = true;
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

            const newId = result.preset?.id || null;
            if (els.presetNameInput) els.presetNameInput.value = "";
            state.selectedPresetId = newId;
            await loadPresets();
            if (newId && els.presetSelect) {
                els.presetSelect.value = newId;
                state.selectedPresetId = newId;
            }
            if (newId) {
                await applyPresetToDraft(newId);
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
            window.setTimeout(() => {
                state.ignorePresetUpdatedDraftReload = false;
            }, 250);
        }
    }

    async function setSelectedPresetAsDefault() {
        const presetId = els.presetSelect?.value;
        const activeDefaultId = getActiveDefaultPresetId();
        if (!presetId || presetId === activeDefaultId) return;
        if (!window.displayPresetsAPI?.setDefault) {
            setStatus(t("controlPanel.validation.apiUnavailable"), "error");
            return;
        }

        setLoading(true);

        try {
            const result = await window.displayPresetsAPI.setDefault(presetId, state.presetTransport);
            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.presets.defaultSetFailed"), "error");
                return;
            }

            state.defaultPresetUsbId = result.defaultPresetUsb || state.defaultPresetUsbId;
            state.defaultPresetWifiId = result.defaultPresetWifi || state.defaultPresetWifiId;
            state.defaultPresetId = getActiveDefaultPresetId();
            const preset = state.presets.find((item) => item.id === presetId);
            await loadPresets();
            if (els.presetSelect) els.presetSelect.value = presetId;
            setStatus(
                t(
                    state.presetTransport === "wifi"
                        ? "controlPanel.presets.defaultSetWifi"
                        : "controlPanel.presets.defaultSetUsb",
                    { name: preset?.name || presetId }
                ),
                "success"
            );
        } catch (err) {
            setStatus(err.message || t("controlPanel.presets.defaultSetFailed"), "error");
        } finally {
            setLoading(false);
        }
    }

    async function deleteSelectedPreset() {
        const presetId = els.presetSelect?.value || state.selectedPresetId || "";
        if (!presetId) {
            setStatus(t("controlPanel.presets.deleteNone"), "error");
            return;
        }
        if (!window.displayPresetsAPI?.delete) {
            setStatus(t("controlPanel.validation.apiUnavailable"), "error");
            return;
        }
        if (state.presets.length <= 1) {
            setStatus(t("controlPanel.presets.deleteLast"), "error");
            return;
        }

        const preset = state.presets.find((item) => item.id === presetId);
        const name = preset?.name || presetId;
        if (!window.confirm(t("controlPanel.presets.deleteConfirm", { name }))) {
            return;
        }

        setLoading(true);
        try {
            const result = await window.displayPresetsAPI.delete(presetId);
            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.presets.deleteFailed"), "error");
                return;
            }

            state.defaultPresetUsbId = result.defaultPresetUsb || state.defaultPresetUsbId;
            state.defaultPresetWifiId = result.defaultPresetWifi || state.defaultPresetWifiId;
            state.defaultPresetId = getActiveDefaultPresetId();
            state.selectedPresetId = getActiveDefaultPresetId() || null;
            await loadPresets();
            if (els.presetSelect && state.selectedPresetId) {
                els.presetSelect.value = state.selectedPresetId;
                await applyPresetToDraft(state.selectedPresetId);
            }
            syncPresetControls();
            if (!state.selectedSessionId) {
                await loadDefaultDraftFromPreset();
            }
            setStatus(t("controlPanel.presets.deleted", { name }), "success");
        } catch (err) {
            setStatus(err.message || t("controlPanel.presets.deleteFailed"), "error");
        } finally {
            setLoading(false);
        }
    }

    async function resetTransportFactory() {
        if (!window.displayPresetsAPI?.resetTransportToFactory) {
            setStatus(t("controlPanel.presets.resetFactoryUnavailable"), "error");
            return;
        }

        const wifi = state.presetTransport === "wifi";
        const confirmed = window.confirm(
            wifi
                ? t("controlPanel.presets.resetFactoryConfirmWifi")
                : t("controlPanel.presets.resetFactoryConfirmUsb")
        );
        if (!confirmed) return;

        setLoading(true);
        try {
            const result = await window.displayPresetsAPI.resetTransportToFactory(state.presetTransport);
            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.presets.resetFactoryFailed"), "error");
                return;
            }

            state.defaultPresetUsbId = result.defaultPresetUsb || state.defaultPresetUsbId;
            state.defaultPresetWifiId = result.defaultPresetWifi || state.defaultPresetWifiId;
            state.defaultPresetId = getActiveDefaultPresetId();
            state.selectedPresetId = result.preset?.id || getActiveDefaultPresetId();
            await loadPresets();
            if (els.presetSelect && state.selectedPresetId) {
                els.presetSelect.value = state.selectedPresetId;
            }
            if (!state.selectedSessionId) {
                await loadDefaultDraftFromPreset();
            } else if (state.selectedPresetId) {
                await applyPresetToDraft(state.selectedPresetId);
            }
            syncPresetControls();
            setStatus(
                result.message || (
                    wifi
                        ? t("controlPanel.presets.resetFactoryDoneWifi")
                        : t("controlPanel.presets.resetFactoryDoneUsb")
                ),
                "success"
            );
        } catch (err) {
            setStatus(err.message || t("controlPanel.presets.resetFactoryFailed"), "error");
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
        const selectedId = els.presetSelect?.value || state.selectedPresetId || "";
        const activeDefaultId = getActiveDefaultPresetId();
        setStatus(t("controlPanel.presets.applyingAll"));

        try {
            // updateDefaultFromParams mute TOUJOURS le preset déjà marqué défaut (USB ou Wi‑Fi).
            // Si un autre preset est sélectionné, le promouvoir d'abord — sinon on
            // écrase le mauvais preset (ex. "Full HD" reçoit les valeurs H265).
            if (selectedId && selectedId !== activeDefaultId) {
                if (!window.displayPresetsAPI?.setDefault) {
                    setStatus(t("controlPanel.validation.apiUnavailable"), "error");
                    return;
                }
                const setResult = await window.displayPresetsAPI.setDefault(
                    selectedId,
                    state.presetTransport
                );
                if (!setResult?.success) {
                    setStatus(setResult?.error || t("controlPanel.presets.defaultSetFailed"), "error");
                    return;
                }
                state.defaultPresetUsbId = setResult.defaultPresetUsb || state.defaultPresetUsbId;
                state.defaultPresetWifiId = setResult.defaultPresetWifi || state.defaultPresetWifiId;
                state.defaultPresetId = getActiveDefaultPresetId();
            }

            const result = await window.displayPresetsAPI.updateDefaultFromParams({
                width: draft.width,
                height: draft.height,
                maxFps: draft.maxFps,
                bitRateMbps: draft.bitRateMbps,
                videoCodec: draft.videoCodec
            }, state.presetTransport);

            if (!result?.success) {
                setStatus(result?.error || t("controlPanel.presets.applyAllFailed"), "error");
                return;
            }

            const focusId = selectedId || result.defaultPreset || getActiveDefaultPresetId();
            state.defaultPresetUsbId = result.defaultPresetUsb || state.defaultPresetUsbId;
            state.defaultPresetWifiId = result.defaultPresetWifi || state.defaultPresetWifiId;
            state.defaultPresetId = getActiveDefaultPresetId();
            state.selectedPresetId = focusId || null;
            await loadPresets();
            if (els.presetSelect && focusId) {
                els.presetSelect.value = focusId;
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

    async function loadDefaultDraftFromPreset() {
        try {
            if (!window.displayPresetsAPI?.getDefault) return false;
            const result = await window.displayPresetsAPI.getDefault(state.presetTransport);
            if (!result?.success) return false;

            // Valeurs brutes du preset (sans overlay perf) pour l'éditeur.
            let params = result.params;
            const presetId = result.defaultPreset || getActiveDefaultPresetId();
            if (presetId && window.displayPresetsAPI.resolveParams) {
                const raw = await window.displayPresetsAPI.resolveParams(presetId);
                if (raw?.success && raw.params) params = raw.params;
            }
            if (!params) return false;

            params = SP.normalizeParams(params);
            state.draftParams = SP.cloneParams(params);
            // Référence = preset défaut pour que H265 validé ne paraisse pas « dirty » vs H264.
            state.appliedParams = SP.cloneParams(params);
            state.defaultPresetUsbId = result.defaultPresetUsb || state.defaultPresetUsbId;
            state.defaultPresetWifiId = result.defaultPresetWifi || state.defaultPresetWifiId;
            state.defaultPresetId = getActiveDefaultPresetId();
            state.selectedPresetId = presetId || state.selectedPresetId;
            if (els.presetSelect && presetId) {
                els.presetSelect.value = presetId;
            }
            syncTransportUi();
            syncPresetControls();
            syncSegmentUI();
            updateDirtyState();
            return true;
        } catch (err) {
            console.warn("[ControlPanel] preset défaut indisponible:", err.message);
            return false;
        }
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
            state.sessionType = null;
            renderSessionList();
            updateAppliedDisplay();
            await loadDefaultDraftFromPreset();
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
            syncSegmentUI();
            updateDirtyState();
            return;
        }

        loadDefaultDraftFromPreset().then((loaded) => {
            if (!loaded) {
                state.draftParams = SP.cloneParams(DEFAULT_PARAMS);
                state.appliedParams = null;
                syncSegmentUI();
                updateDirtyState();
            }
            setStatus(t("controlPanel.validation.cancelDefault"));
        }).catch(console.error);
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
        if (els.presetSelect && !els.presetSelect._bound) {
            els.presetSelect._bound = true;
            els.presetSelect.addEventListener("change", () => {
                onPresetSelectChange().catch(console.error);
            });
        }
        if (els.presetTransport && !els.presetTransport._bound) {
            els.presetTransport._bound = true;
            els.presetTransport.addEventListener("click", (event) => {
                const btn = event.target?.closest?.("[data-preset-transport]");
                if (!btn || btn.disabled) return;
                setPresetTransport(btn.getAttribute("data-preset-transport")).catch(console.error);
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
        if (els.btnResetFactory && !els.btnResetFactory._bound) {
            els.btnResetFactory._bound = true;
            els.btnResetFactory.addEventListener("click", () => resetTransportFactory().catch(console.error));
        }
        if (els.btnDeletePreset && !els.btnDeletePreset._bound) {
            els.btnDeletePreset._bound = true;
            els.btnDeletePreset.addEventListener("click", () => deleteSelectedPreset().catch(console.error));
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
                loadPresets()
                    .then(async () => {
                        if (state.ignorePresetUpdatedDraftReload) {
                            if (state.selectedPresetId && els.presetSelect) {
                                els.presetSelect.value = state.selectedPresetId;
                            }
                            updateCurrentPresetLabel();
                            return null;
                        }
                        if (state.selectedPresetId
                            && state.presets.some((preset) => preset.id === state.selectedPresetId)) {
                            if (els.presetSelect) els.presetSelect.value = state.selectedPresetId;
                            if (!state.selectedSessionId) {
                                await applyPresetToDraft(state.selectedPresetId);
                            }
                            updateCurrentPresetLabel();
                            return null;
                        }
                        if (!state.selectedSessionId) {
                            return loadDefaultDraftFromPreset();
                        }
                        updateCurrentPresetLabel();
                        return null;
                    })
                    .catch(console.error);
            });
            window.uiPreferencesAPI?.onPerformanceChanged?.((payload) => {
                if (payload?.performance) {
                    onPerformancePrefsChanged(payload.performance).catch(console.error);
                }
            });
            window.addEventListener("performance-prefs-changed", (event) => {
                const prefs = event?.detail || window.HubPerformance?.getPrefs?.() || {};
                onPerformancePrefsChanged(prefs).catch(console.error);
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
        els.presetSelect = $("control-preset-select");
        els.presetNameInput = $("control-preset-name-input");
        els.presetSetDefault = $("control-preset-set-default");
        els.presetSetDefaultLabel = $("control-preset-set-default-label");
        els.btnSavePreset = $("control-btn-save-preset");
        els.btnDeletePreset = $("control-btn-delete-preset");
        els.btnApplyAll = $("control-btn-apply-all");
        els.btnResetFactory = $("control-btn-reset-factory");
        els.presetApplyAllHint = $("control-preset-apply-all-hint");
        els.presetCurrent = $("control-preset-current");
        els.presetTransport = $("control-preset-transport");
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
        syncTransportUi();
        state.uiReady = true;
        updateSessionMeta();
        updateAppliedDisplay();
        updateDirtyState();
        return true;
    }

    async function ensureUIAsync() {
        if (!ensureUI()) return false;
        await loadPresets();
        if (!state.selectedSessionId) {
            await loadDefaultDraftFromPreset();
        } else {
            updateCurrentPresetLabel();
        }
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
        updateCurrentPresetLabel();
        if (isPerformanceModeOn()) {
            const res = getPerformanceResolution();
            setStatus(
                t("controlPanel.presets.performanceActive", {
                    resolution: `${res.width}×${res.height}`
                }),
                "info"
            );
            if (els.statusMessage) els.statusMessage.dataset.perfMode = "1";
        }
    };

    window.refreshControlPanel = refreshSessions;

    function boot() {
        try {
            ensureUI();
            loadPresets()
                .then(() => loadDefaultDraftFromPreset())
                .catch(console.error);
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
        syncTransportUi();
        updateSessionMeta();
        updateAppliedDisplay();
        renderSessionList();
        globalThis.HubI18n?.applyDomI18n?.(document.getElementById("panel-settings") || document);
        updateCurrentPresetLabel();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
