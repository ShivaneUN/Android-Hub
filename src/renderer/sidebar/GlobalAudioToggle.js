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
        if (!button) return;

        button.classList.remove("pending", "audio-on", "audio-off");
        button.classList.add(audioOn ? "audio-on" : "audio-off");

        if (badge) {
            badge.textContent = audioOn ? t("toggles.audioOn") : t("toggles.audioOff");
            badge.classList.toggle("on", audioOn);
            badge.classList.toggle("off", !audioOn);
        }

        if (iconOn) iconOn.classList.toggle("hidden", !audioOn);
        if (iconOff) iconOff.classList.toggle("hidden", audioOn);

        button.removeAttribute("title");
    }

    async function refreshGlobalAudioToggle() {
        if (!window.audioAPI?.getGlobalState) {
            setGlobalAudioToggleState(false);
            return;
        }

        try {
            const state = await window.audioAPI.getGlobalState();
            setGlobalAudioToggleState(!state?.globalMuted);
        } catch (err) {
            console.error("[GlobalAudioToggle] Erreur lecture etat:", err);
            setGlobalAudioToggleState(false);
        }
    }

    async function toggleGlobalAudio(event) {
        event?.stopPropagation?.();
        event?.preventDefault?.();

        const { button } = getGlobalAudioToggleElements();
        if (!button) {
            return { ok: false };
        }
        // Évite un "pending" coincé qui bloquait le bouton (surtout via overlay dock).
        if (button.classList.contains("pending")) {
            button.classList.remove("pending");
        }

        button.classList.add("pending");
        try {
            // Même logique que l'icône ON/OFF global du popup audio :
            // OFF → mute + sliders à 0 ; ON → unmute + restore volume.
            let result = null;
            if (window.deviceSpeakerOverlayAPI?.toggleGlobalAudio) {
                result = await window.deviceSpeakerOverlayAPI.toggleGlobalAudio();
            } else if (window.audioAPI?.toggleGlobalMuted) {
                result = await window.audioAPI.toggleGlobalMuted();
            } else {
                return { ok: false };
            }
            const muted = result?.globalMuted ?? result?.panel?.globalMuted;
            if (typeof muted === "boolean") {
                setGlobalAudioToggleState(!muted);
            } else {
                await refreshGlobalAudioToggle();
            }
            return { ok: true, globalMuted: Boolean(muted) };
        } catch (err) {
            console.error("[GlobalAudioToggle] Erreur toggle:", err);
            await refreshGlobalAudioToggle();
            return { ok: false, error: err?.message || String(err) };
        } finally {
            button.classList.remove("pending");
        }
    }

    function init() {
        const { button } = getGlobalAudioToggleElements();
        if (!button) return;

        button.addEventListener("click", (event) => {
            void toggleGlobalAudio(event);
        });

        if (window.audioAPI?.onGlobalStateChanged) {
            window.audioAPI.onGlobalStateChanged((data) => {
                setGlobalAudioToggleState(!data?.globalMuted);
            });
        }

        refreshGlobalAudioToggle();
    }

    window.refreshGlobalAudioToggle = refreshGlobalAudioToggle;
    window.setGlobalAudioToggleState = setGlobalAudioToggleState;
    window.toggleGlobalAudio = toggleGlobalAudio;

    globalThis.HubI18n?.onChange?.(() => {
        refreshGlobalAudioToggle();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
