let activeSessionId = null;

function getOrientationToggleElements() {
    return {
        button: document.getElementById("nav-toggle-orientation"),
        badge: document.getElementById("sidebar-orientation-badge")
    };
}

function setOrientationToggleDisabled() {
    const { button, badge } = getOrientationToggleElements();
    if (!button || !badge) return;

    button.classList.add("disabled");
    button.classList.remove("portrait-on", "portrait-off");
    badge.textContent = "—";
    badge.classList.remove("on", "off");
    button.title = "Mode portrait (session active requise)";
    activeSessionId = null;
}

function setOrientationToggleState(portraitOn, sessionId) {
    const { button, badge } = getOrientationToggleElements();
    if (!button || !badge) return;

    activeSessionId = sessionId;
    button.classList.remove("disabled", "portrait-on", "portrait-off", "pending");
    button.classList.add(portraitOn ? "portrait-on" : "portrait-off");

    badge.textContent = portraitOn ? "ON" : "OFF";
    badge.classList.toggle("on", portraitOn);
    badge.classList.toggle("off", !portraitOn);

    button.title = portraitOn
        ? "Mode portrait actif — cliquer pour desactiver"
        : "Mode portrait inactif — cliquer pour activer";
}

async function updateOrientationToggle() {
    if (!window.sessionAPI?.getActiveOrientation) {
        setOrientationToggleDisabled();
        return;
    }

    try {
        const result = await window.sessionAPI.getActiveOrientation();
        if (!result?.success || !result.sessionId) {
            setOrientationToggleDisabled();
            return;
        }

        setOrientationToggleState(result.orientation === "portrait", result.sessionId);
    } catch (err) {
        console.error("[OrientationToggle] Erreur mise a jour:", err);
        setOrientationToggleDisabled();
    }
}

async function onOrientationToggleClick() {
    const { button } = getOrientationToggleElements();
    if (!button || button.classList.contains("disabled") || !window.sessionAPI?.toggleOrientation) {
        return;
    }

    if (!activeSessionId) {
        await updateOrientationToggle();
        return;
    }

    button.classList.add("pending");

    try {
        const result = await window.sessionAPI.toggleOrientation(activeSessionId);
        if (!result?.success) {
            console.error("[OrientationToggle] Echec toggle:", result?.error);
            return;
        }
        setOrientationToggleState(result.orientation === "portrait", result.sessionId);
        if (typeof window.applySessionPortraitLayout === "function") {
            await window.applySessionPortraitLayout(result.orientation === "portrait");
        }
    } catch (err) {
        console.error("[OrientationToggle] Erreur toggle:", err);
    } finally {
        button.classList.remove("pending");
    }
}

function initOrientationToggle() {
    const { button } = getOrientationToggleElements();
    if (!button) return;

    button.addEventListener("click", () => {
        onOrientationToggleClick();
    });

    if (window.sessionAPI?.onSessionActivated) {
        window.sessionAPI.onSessionActivated(() => {
            updateOrientationToggle();
        });
    }

    updateOrientationToggle();
}

window.updateOrientationToggle = updateOrientationToggle;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOrientationToggle);
} else {
    initOrientationToggle();
}
