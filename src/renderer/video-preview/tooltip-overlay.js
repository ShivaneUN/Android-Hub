(function initTooltipOverlay() {
    const root = document.getElementById("tooltip-root");
    const frameImg = root?.querySelector(".video-preview-tooltip__frame");
    if (!root || !frameImg || !window.tooltipOverlayAPI?.onUpdate) return;

    window.tooltipOverlayAPI.onUpdate((payload) => {
        const state = payload?.state || "hidden";
        const visible = Boolean(payload?.visible) && state !== "hidden";

        root.classList.toggle("is-visible", visible);
        root.classList.toggle("is-live", state === "live");
        root.classList.toggle("is-unavailable", state === "unavailable");
        root.setAttribute("aria-hidden", visible ? "false" : "true");

        if (state === "live" && payload.dataUrl) {
            if (frameImg.src !== payload.dataUrl) {
                frameImg.src = payload.dataUrl;
            }
            frameImg.classList.add("is-active");
        } else {
            frameImg.classList.remove("is-active");
            if (state === "hidden") {
                frameImg.removeAttribute("src");
            }
        }
    });
})();
