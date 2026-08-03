(function initDeviceSpeakerVolumePopover() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;
    const AUDIO_BUTTON_ID = "nav-toggle-global-audio";

    function getButton() {
        return document.getElementById(AUDIO_BUTTON_ID);
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

    async function openDeviceSpeakerVolumePopover() {
        const button = getButton();
        if (!button || !window.deviceSpeakerOverlayAPI?.show) {
            return { ok: false };
        }

        try {
            window.dockHoverAPI?.hide?.();
        } catch (_err) {
            // noop
        }
        document.getElementById("quick-actions-dock")?.classList.remove("dock-covered");

        const home = isHomeVisible();
        const hintBase = await resolveDeviceHint();
        const hint = {
            home,
            serial: hintBase.serial,
            stableDeviceId: hintBase.stableDeviceId
        };

        const rect = button.getBoundingClientRect();
        button.classList.add("speaker-volume-open");
        window.__deviceSpeakerPopoverOpen = true;

        await window.deviceSpeakerOverlayAPI.show({
            title: t("toggles.deviceSpeakerTitle"),
            hint,
            anchor: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height
            }
        });

        return { ok: true };
    }

    function onAudioContextMenu(event) {
        event.preventDefault();
        event.stopPropagation();
        void openDeviceSpeakerVolumePopover();
    }

    function init() {
        const button = getButton();
        if (!button) return;
        button.addEventListener("contextmenu", onAudioContextMenu);

        window.addEventListener("hub-home-visibility", () => {
            window.deviceSpeakerOverlayAPI?.hide?.();
        });
    }

    window.openDeviceSpeakerVolumePopover = openDeviceSpeakerVolumePopover;
    window.updateDeviceSpeakerToggle = async () => ({ enabled: true });
    window.__deviceSpeakerPopoverOpen = false;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
