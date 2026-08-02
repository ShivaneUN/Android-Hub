(function initPerformanceSection() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;
    const FEATURE_KEYS = [
        "fpsMonitor",
        "appLogos",
        "homePreview",
        "hoverPreview",
        "dockBatteryLive",
        "uiAnimations",
        "sessionTransportSwitch"
    ];

    let bound = false;

    function getModeToggle() {
        return document.getElementById("settings-perf-mode-toggle");
    }

    function getRememberScreenToggle() {
        return document.getElementById("settings-remember-screen-toggle");
    }

    function getFeatureChips() {
        return document.querySelectorAll("#settings-perf-feature-toggles [data-perf-feature]");
    }

    async function readPrefs() {
        if (window.uiPreferencesAPI?.getPerformancePrefs) {
            try {
                return await window.uiPreferencesAPI.getPerformancePrefs();
            } catch (_err) {
                /* fall through */
            }
        }
        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("getPerformancePrefs", []);
            if (response?.success && response.result) return response.result;
        }
        return window.HubPerformance?.getPrefs?.() || {};
    }

    async function readScreenPowerPrefs() {
        if (window.uiPreferencesAPI?.getDeviceScreenPowerPrefs) {
            try {
                return await window.uiPreferencesAPI.getDeviceScreenPowerPrefs();
            } catch (_err) {
                /* fall through */
            }
        }
        return { rememberAcrossDisconnect: false };
    }

    async function writePrefs(patch) {
        if (window.uiPreferencesAPI?.setPerformancePrefs) {
            const result = await window.uiPreferencesAPI.setPerformancePrefs(patch);
            if (result?.success) {
                applyLocalDom(result.performance || {});
                return result.performance || {};
            }
            window.showHubToast?.(result?.error || t("settingsPanel.performanceSaveFailed"), "error");
            return null;
        }
        if (window.hubModalWindowAPI?.invokeMain) {
            const response = await window.hubModalWindowAPI.invokeMain("setPerformancePrefs", [patch]);
            if (response?.success) {
                applyLocalDom(response.result || {});
                return response.result || {};
            }
            window.showHubToast?.(response?.error || t("settingsPanel.performanceSaveFailed"), "error");
            return null;
        }
        return null;
    }

    async function writeRememberScreen(enabled) {
        if (!window.uiPreferencesAPI?.setRememberScreenAcrossDisconnect) {
            window.showHubToast?.(t("settingsPanel.rememberScreenSaveFailed"), "error");
            return null;
        }
        const result = await window.uiPreferencesAPI.setRememberScreenAcrossDisconnect(enabled);
        if (!result?.success) {
            window.showHubToast?.(result?.error || t("settingsPanel.rememberScreenSaveFailed"), "error");
            return null;
        }
        return result.deviceScreenPower || { rememberAcrossDisconnect: enabled };
    }

    function applyLocalDom(prefs = {}) {
        const modeOn = prefs.performanceMode === true;
        document.body?.classList.toggle("perf-reduce-motion", modeOn || prefs.uiAnimations === false);
        document.body?.classList.toggle("perf-hide-fps", modeOn || prefs.fpsMonitor === false);
        document.body?.classList.toggle("perf-no-app-logos", modeOn || prefs.appLogos === false);
    }

    function applyRememberScreenUi(enabled) {
        const btn = getRememberScreenToggle();
        if (!btn) return;
        btn.classList.toggle("is-on", enabled === true);
        btn.setAttribute("aria-pressed", enabled === true ? "true" : "false");
    }

    function applyPrefsToUi(prefs = {}) {
        const modeOn = prefs.performanceMode === true;
        const modeBtn = getModeToggle();
        if (modeBtn) {
            modeBtn.classList.toggle("is-on", modeOn);
            modeBtn.setAttribute("aria-pressed", modeOn ? "true" : "false");
        }

        getFeatureChips().forEach((chip) => {
            const key = chip.getAttribute("data-perf-feature");
            const on = modeOn ? false : prefs?.[key] !== false;
            chip.classList.toggle("is-on", on);
            chip.setAttribute("aria-pressed", on ? "true" : "false");
            chip.disabled = modeOn;
            chip.classList.toggle("is-locked", modeOn);
        });

        applyLocalDom(prefs);
    }

    async function syncToggleUi() {
        const [prefs, screenPrefs] = await Promise.all([readPrefs(), readScreenPowerPrefs()]);
        applyPrefsToUi(prefs);
        applyRememberScreenUi(screenPrefs?.rememberAcrossDisconnect === true);
    }

    function bindPerformanceSection() {
        if (!bound) {
            bound = true;

            getModeToggle()?.addEventListener("click", () => {
                const next = !getModeToggle()?.classList.contains("is-on");
                void (async () => {
                    const result = await writePrefs({ performanceMode: next });
                    if (!result) return;
                    applyPrefsToUi(result);
                })();
            });

            getFeatureChips().forEach((chip) => {
                chip.addEventListener("click", () => {
                    if (chip.disabled) return;
                    const key = chip.getAttribute("data-perf-feature");
                    if (!FEATURE_KEYS.includes(key)) return;
                    const next = !chip.classList.contains("is-on");
                    void (async () => {
                        const result = await writePrefs({ [key]: next });
                        if (!result) return;
                        applyPrefsToUi(result);
                    })();
                });
            });

            getRememberScreenToggle()?.addEventListener("click", () => {
                const next = !getRememberScreenToggle()?.classList.contains("is-on");
                void (async () => {
                    const result = await writeRememberScreen(next);
                    if (!result) return;
                    applyRememberScreenUi(result.rememberAcrossDisconnect === true);
                })();
            });

            window.uiPreferencesAPI?.onPerformanceChanged?.((payload) => {
                if (payload?.performance) applyPrefsToUi(payload.performance);
            });
        }

        void syncToggleUi();
    }

    window.bindPerformanceSection = bindPerformanceSection;
})();
