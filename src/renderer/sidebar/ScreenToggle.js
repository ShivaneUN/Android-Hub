(function initScreenToggle() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    let activeTypeASessionId = null;

    function getScreenToggleElements() {
        return {
            button: document.getElementById("nav-toggle-screen"),
            badge: document.getElementById("sidebar-screen-badge")
        };
    }

    function setScreenToggleDisabled() {
        const { button, badge } = getScreenToggleElements();
        if (!button || !badge) return;

        button.classList.add("disabled");
        button.classList.remove("screen-on", "screen-off");
        badge.textContent = "—";
        badge.classList.remove("on", "off");
        button.title = t("toggles.screenTitle");
        activeTypeASessionId = null;
    }

    function setScreenToggleState(screenOff, sessionId) {
        const { button, badge } = getScreenToggleElements();
        if (!button || !badge) return;

        activeTypeASessionId = sessionId;
        button.classList.remove("disabled", "screen-on", "screen-off");
        button.classList.add(screenOff ? "screen-off" : "screen-on");

        badge.textContent = screenOff ? t("toggles.screenOff") : t("toggles.screenOn");
        badge.classList.toggle("on", !screenOff);
        badge.classList.toggle("off", screenOff);

        button.title = t("toggles.screenTitle");
    }

    async function updateScreenToggle() {
        if (!window.sessionAPI?.getActiveTypeA) {
            setScreenToggleDisabled();
            return;
        }

        try {
            const { session } = await window.sessionAPI.getActiveTypeA();
            if (!session?.sessionId || !session.deviceId) {
                setScreenToggleDisabled();
                return;
            }

            setScreenToggleState(Boolean(session.screenOff), session.sessionId);
        } catch (err) {
            console.error("[ScreenToggle] Erreur mise a jour:", err);
            setScreenToggleDisabled();
        }
    }

    async function onScreenToggleClick() {
        const { button } = getScreenToggleElements();
        if (!button || button.classList.contains("disabled") || !window.sessionAPI?.toggleScreen) {
            return;
        }

        if (!activeTypeASessionId) {
            await updateScreenToggle();
            return;
        }

        button.classList.add("pending");

        try {
            const result = await window.sessionAPI.toggleScreen(activeTypeASessionId);
            if (!result?.success) {
                console.error("[ScreenToggle] Echec toggle:", result?.error);
                return;
            }
            setScreenToggleState(Boolean(result.screenOff), result.sessionId);
        } catch (err) {
            console.error("[ScreenToggle] Erreur toggle:", err);
        } finally {
            button.classList.remove("pending");
        }
    }

    function init() {
        const { button } = getScreenToggleElements();
        if (!button) return;

        button.addEventListener("click", () => {
            onScreenToggleClick();
        });

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
