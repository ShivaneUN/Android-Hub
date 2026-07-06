(function initGlobalAudioToggle() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    function getGlobalAudioToggleElements() {
        return {
            button: document.getElementById("nav-toggle-global-audio"),
            badge: document.getElementById("sidebar-global-audio-badge"),
            iconOn: document.getElementById("sidebar-global-audio-icon-on"),
            iconOff: document.getElementById("sidebar-global-audio-icon-off")
        };
    }

    function setGlobalAudioToggleState(audioOn) {
        const { button, badge, iconOn, iconOff } = getGlobalAudioToggleElements();
        if (!button || !badge) return;

        button.classList.remove("pending", "audio-on", "audio-off");
        button.classList.add(audioOn ? "audio-on" : "audio-off");

        badge.textContent = audioOn ? t("toggles.audioOn") : t("toggles.audioOff");
        badge.classList.toggle("on", audioOn);
        badge.classList.toggle("off", !audioOn);

        if (iconOn) iconOn.classList.toggle("hidden", !audioOn);
        if (iconOff) iconOff.classList.toggle("hidden", audioOn);

        button.title = t("toggles.audioTitle");
    }

    async function refreshGlobalAudioToggle() {
        if (!window.audioAPI?.getGlobalState) {
            setGlobalAudioToggleState(true);
            return;
        }

        try {
            const state = await window.audioAPI.getGlobalState();
            setGlobalAudioToggleState(!state?.globalMuted);
        } catch (err) {
            console.error("[GlobalAudioToggle] Erreur lecture etat:", err);
            setGlobalAudioToggleState(true);
        }
    }

    async function onGlobalAudioToggleClick(event) {
        event?.stopPropagation?.();

        const { button } = getGlobalAudioToggleElements();
        if (!button || button.classList.contains("pending") || !window.audioAPI?.toggleGlobalMuted) {
            return;
        }

        button.classList.add("pending");

        try {
            const result = await window.audioAPI.toggleGlobalMuted();
            setGlobalAudioToggleState(!result?.globalMuted);
        } catch (err) {
            console.error("[GlobalAudioToggle] Erreur toggle:", err);
            await refreshGlobalAudioToggle();
        } finally {
            button.classList.remove("pending");
        }
    }

    function init() {
        const { button } = getGlobalAudioToggleElements();
        if (!button) return;

        button.addEventListener("click", onGlobalAudioToggleClick);

        if (window.audioAPI?.onGlobalStateChanged) {
            window.audioAPI.onGlobalStateChanged((data) => {
                setGlobalAudioToggleState(!data?.globalMuted);
            });
        }

        refreshGlobalAudioToggle();
    }

    window.refreshGlobalAudioToggle = refreshGlobalAudioToggle;

    globalThis.HubI18n?.onChange?.(() => {
        refreshGlobalAudioToggle();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
