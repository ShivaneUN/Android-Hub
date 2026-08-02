(function initScreenToggle() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    let activeTarget = null;
    let updateSeq = 0;

    function getScreenToggleElements() {
        return {
            button: document.getElementById("nav-toggle-screen"),
            badge: document.getElementById("sidebar-screen-badge")
        };
    }

    function isHomeVisible() {
        if (typeof window.isHomeVisible === "function") {
            try {
                return Boolean(window.isHomeVisible());
            } catch (_err) {
                // fallback
            }
        }
        const pageNew = document.getElementById("page-new");
        if (pageNew && !pageNew.classList.contains("hidden")) {
            const sessionView = document.getElementById("content")?.classList.contains("content--session-view");
            if (!sessionView) return true;
        }
        return Boolean(window.__hubShowingHome);
    }

    async function resolveDeviceHint() {
        const selected = typeof window.getSelectedLauncherDevice === "function"
            ? window.getSelectedLauncherDevice()
            : null;
        if (selected?.serial) {
            return {
                serial: selected.serial,
                stableDeviceId: selected.deviceId || null
            };
        }

        const devices = typeof window.getConnectedDevices === "function"
            ? window.getConnectedDevices()
            : [];
        const connected = (devices || []).filter((d) => d && d.connected !== false);
        if (connected.length === 1) {
            return {
                serial: connected[0].serial,
                stableDeviceId: connected[0].deviceId || null
            };
        }

        // Accueil avec sessions : reprendre le device de la session active / première.
        if (window.sessionAPI?.list) {
            try {
                const sessions = await window.sessionAPI.list();
                const pick = (sessions || []).find((s) => s?.active && s.deviceId)
                    || (sessions || []).find((s) => s?.deviceId);
                if (pick?.deviceId) {
                    return {
                        serial: pick.deviceId,
                        stableDeviceId: pick.stableDeviceId || null
                    };
                }
            } catch (_err) {
                // ignore
            }
        }

        return { serial: null, stableDeviceId: null };
    }

    function setScreenToggleDisabled() {
        const { button, badge } = getScreenToggleElements();
        if (!button || !badge) return;

        button.classList.add("disabled");
        button.classList.remove("screen-on", "screen-off", "pending");
        badge.textContent = "—";
        badge.classList.remove("on", "off");
        button.removeAttribute("title");
        activeTarget = null;
    }

    function setScreenToggleState(screenOff, target) {
        const { button, badge } = getScreenToggleElements();
        if (!button || !badge) return;

        activeTarget = target || null;
        button.classList.remove("disabled", "screen-on", "screen-off");
        button.classList.add(screenOff ? "screen-off" : "screen-on");

        badge.textContent = screenOff ? t("toggles.screenOff") : t("toggles.screenOn");
        badge.classList.toggle("on", !screenOff);
        badge.classList.toggle("off", screenOff);

        button.removeAttribute("title");
    }

    async function updateScreenToggle() {
        if (!window.sessionAPI?.getScreenToggleState && !window.sessionAPI?.getActiveTypeA) {
            setScreenToggleDisabled();
            return;
        }

        const seq = ++updateSeq;
        const home = isHomeVisible();
        const deviceHint = await resolveDeviceHint();

        try {
            let state = null;
            if (window.sessionAPI.getScreenToggleState) {
                state = await window.sessionAPI.getScreenToggleState({
                    home,
                    serial: deviceHint.serial,
                    stableDeviceId: deviceHint.stableDeviceId
                });
            } else {
                // Fallback legacy Type A only
                const { session } = await window.sessionAPI.getActiveTypeA();
                if (session?.sessionId && session.deviceId) {
                    state = {
                        success: true,
                        enabled: true,
                        mode: "typeA",
                        sessionId: session.sessionId,
                        deviceId: session.deviceId,
                        screenOff: Boolean(session.screenOff)
                    };
                } else {
                    state = { success: true, enabled: false };
                }
            }

            if (seq !== updateSeq) return;

            if (!state?.success || !state.enabled) {
                setScreenToggleDisabled();
                return;
            }

            setScreenToggleState(Boolean(state.screenOff), {
                mode: state.mode || "adb",
                sessionId: state.sessionId || null,
                deviceId: state.deviceId || deviceHint.serial || null,
                stableDeviceId: state.stableDeviceId || deviceHint.stableDeviceId || null,
                home
            });
        } catch (err) {
            if (seq !== updateSeq) return;
            console.error("[ScreenToggle] Erreur mise a jour:", err);
            setScreenToggleDisabled();
        }
    }

    async function onScreenToggleClick() {
        const { button } = getScreenToggleElements();
        if (!button || button.classList.contains("disabled") || !window.sessionAPI?.toggleScreen) {
            return;
        }

        if (!activeTarget) {
            await updateScreenToggle();
            if (!activeTarget || button.classList.contains("disabled")) {
                return;
            }
        }

        button.classList.add("pending");

        try {
            const home = isHomeVisible();
            const payload = {
                sessionId: activeTarget.sessionId || null,
                serial: activeTarget.deviceId || null,
                stableDeviceId: activeTarget.stableDeviceId || null,
                home
            };

            const result = await window.sessionAPI.toggleScreen(payload);
            if (!result?.success) {
                console.error("[ScreenToggle] Echec toggle:", result?.error);
                await updateScreenToggle();
                return;
            }
            setScreenToggleState(Boolean(result.screenOff), {
                mode: result.mode || activeTarget.mode || "adb",
                sessionId: result.sessionId || activeTarget.sessionId || null,
                deviceId: result.deviceId || activeTarget.deviceId || null,
                stableDeviceId: activeTarget.stableDeviceId || null,
                home
            });
        } catch (err) {
            console.error("[ScreenToggle] Erreur toggle:", err);
            await updateScreenToggle();
        } finally {
            button.classList.remove("pending");
        }
    }

    function scheduleUpdateScreenToggle() {
        void updateScreenToggle();
    }

    function init() {
        const { button } = getScreenToggleElements();
        if (!button) return;

        button.addEventListener("click", () => {
            onScreenToggleClick();
        });

        if (window.sessionAPI?.onSessionActivated) {
            window.sessionAPI.onSessionActivated(() => scheduleUpdateScreenToggle());
        }
        if (window.sessionAPI?.onSessionListChanged) {
            window.sessionAPI.onSessionListChanged(() => scheduleUpdateScreenToggle());
        }
        if (window.sessionAPI?.onScreenPowerChanged) {
            window.sessionAPI.onScreenPowerChanged((data) => {
                // Détection device / apply : toujours resync le badge.
                if (!data || typeof data.screenOff !== "boolean" || !activeTarget) {
                    scheduleUpdateScreenToggle();
                    return;
                }
                const sameSession = data.sessionId && activeTarget.sessionId === data.sessionId;
                const sameDevice = data.deviceId && (
                    activeTarget.deviceId === data.deviceId
                    || activeTarget.stableDeviceId === data.deviceId
                );
                const sameStable = data.stableDeviceId && activeTarget.stableDeviceId === data.stableDeviceId;
                if (sameSession || sameDevice || sameStable || data.mode?.startsWith?.("applied")) {
                    setScreenToggleState(Boolean(data.screenOff), {
                        ...activeTarget,
                        deviceId: data.deviceId || activeTarget.deviceId,
                        stableDeviceId: data.stableDeviceId || activeTarget.stableDeviceId,
                        mode: data.mode || activeTarget.mode
                    });
                } else {
                    scheduleUpdateScreenToggle();
                }
            });
        }

        window.addEventListener("devices-refreshed", scheduleUpdateScreenToggle);
        window.addEventListener("launcher-device-selected", scheduleUpdateScreenToggle);
        window.addEventListener("hub-home-visibility", scheduleUpdateScreenToggle);

        updateScreenToggle();
    }

    window.updateScreenToggle = updateScreenToggle;

    globalThis.HubI18n?.onChange?.(() => {
        updateScreenToggle();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
