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

        activeTarget = target || { global: true };
        button.classList.remove("disabled", "screen-on", "screen-off");
        button.classList.add(screenOff ? "screen-off" : "screen-on");

        badge.textContent = screenOff ? t("toggles.screenOff") : t("toggles.screenOn");
        badge.classList.toggle("on", !screenOff);
        badge.classList.toggle("off", screenOff);
        button.removeAttribute("title");
    }

    async function updateScreenToggle(quickState = null) {
        if (!window.sessionAPI?.getScreenPowerPanel && !window.sessionAPI?.getScreenToggleState) {
            setScreenToggleDisabled();
            return;
        }

        if (quickState && typeof quickState.screenOff === "boolean") {
            setScreenToggleState(Boolean(quickState.screenOff), { global: true, home: isHomeVisible() });
            return;
        }

        const seq = ++updateSeq;
        try {
            let screenOff = false;
            let enabled = false;

            if (window.sessionAPI.getScreenPowerPanel) {
                const panel = await window.sessionAPI.getScreenPowerPanel();
                if (seq !== updateSeq) return;
                enabled = Boolean(panel?.enabled && panel?.devices?.length);
                // Badge global : OFF seulement si tous éteints.
                screenOff = Boolean(panel?.globalScreenOff)
                    || (enabled && (panel.devices || []).every((d) => d.screenOff));
            } else {
                const home = isHomeVisible();
                const state = await window.sessionAPI.getScreenToggleState({ home });
                if (seq !== updateSeq) return;
                enabled = Boolean(state?.success && state.enabled);
                screenOff = Boolean(state?.screenOff);
            }

            if (!enabled) {
                setScreenToggleDisabled();
                return;
            }

            setScreenToggleState(screenOff, { global: true, home: isHomeVisible() });
        } catch (err) {
            if (seq !== updateSeq) return;
            console.error("[ScreenToggle] Erreur mise a jour:", err);
            setScreenToggleDisabled();
        }
    }

    async function onScreenToggleClick() {
        const { button } = getScreenToggleElements();
        if (!button || button.classList.contains("disabled")) return;
        if (!window.sessionAPI?.toggleScreenGlobal && !window.sessionAPI?.toggleScreen) return;

        const nextOff = !button.classList.contains("screen-off");
        setScreenToggleState(nextOff, { global: true, home: isHomeVisible() });
        button.classList.add("pending");
        try {
            const result = window.sessionAPI.toggleScreenGlobal
                ? await window.sessionAPI.toggleScreenGlobal()
                : await window.sessionAPI.toggleScreen({ global: true, home: isHomeVisible() });
            if (!result?.success) {
                console.error("[ScreenToggle] Echec toggle global:", result?.error);
                await updateScreenToggle();
                return;
            }
            setScreenToggleState(Boolean(result.screenOff), { global: true, home: isHomeVisible() });
        } catch (err) {
            console.error("[ScreenToggle] Erreur toggle:", err);
            await updateScreenToggle();
        } finally {
            button.classList.remove("pending");
        }
    }

    async function openScreenPowerPopover() {
        const { button } = getScreenToggleElements();
        if (!button || !window.screenPowerOverlayAPI?.show) {
            return { ok: false };
        }

        try {
            window.dockHoverAPI?.hide?.();
        } catch (_err) {
            // noop
        }
        document.getElementById("quick-actions-dock")?.classList.remove("dock-covered");

        const rect = button.getBoundingClientRect();
        button.classList.add("screen-power-open");
        window.__screenPowerPopoverOpen = true;

        await window.screenPowerOverlayAPI.show({
            title: t("toggles.screenPowerTitle") || t("settingsPanel.screenPowerTitle") || "Écran appareil",
            anchor: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height
            }
        });

        return { ok: true };
    }

    function onScreenContextMenu(event) {
        event.preventDefault();
        event.stopPropagation();
        void openScreenPowerPopover();
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
        button.addEventListener("contextmenu", onScreenContextMenu);

        if (window.sessionAPI?.onSessionActivated) {
            window.sessionAPI.onSessionActivated(() => scheduleUpdateScreenToggle());
        }
        if (window.sessionAPI?.onSessionListChanged) {
            window.sessionAPI.onSessionListChanged(() => scheduleUpdateScreenToggle());
        }
        if (window.sessionAPI?.onScreenPowerChanged) {
            window.sessionAPI.onScreenPowerChanged((data) => {
                if (data && typeof data.screenOff === "boolean") {
                    if (data.mode === "global" || data.panel) {
                        const off = data.panel
                            ? Boolean(data.panel.globalScreenOff)
                            : Boolean(data.screenOff);
                        setScreenToggleState(off, { global: true, home: isHomeVisible() });
                        return;
                    }
                }
                scheduleUpdateScreenToggle();
            });
        }

        window.addEventListener("devices-refreshed", scheduleUpdateScreenToggle);
        window.addEventListener("launcher-device-selected", scheduleUpdateScreenToggle);
        window.addEventListener("hub-home-visibility", () => {
            window.screenPowerOverlayAPI?.hide?.();
            scheduleUpdateScreenToggle();
        });

        updateScreenToggle();
    }

    window.updateScreenToggle = updateScreenToggle;
    window.openScreenPowerPopover = openScreenPowerPopover;
    window.__screenPowerPopoverOpen = false;

    globalThis.HubI18n?.onChange?.(() => {
        updateScreenToggle();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
