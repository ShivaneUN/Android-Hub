(function initSessionFileDrop() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("sessionId");
    const deviceId = params.get("deviceId") || "";
    if (!sessionId) return;

    const overlay = document.getElementById("session-file-drop-overlay");
    if (!overlay) return;

    let dragDepth = 0;
    let busy = false;

    function hasFiles(event) {
        return Array.from(event.dataTransfer?.types || []).includes("Files");
    }

    function show() {
        overlay.hidden = false;
        overlay.classList.add("is-visible");
    }

    function hide() {
        dragDepth = 0;
        overlay.hidden = true;
        overlay.classList.remove("is-visible");
    }

    document.addEventListener("dragenter", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth += 1;
        show();
    });

    document.addEventListener("dragover", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        show();
    });

    document.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hide();
    });

    document.addEventListener("drop", async (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        hide();
        if (busy || !window.deviceFsAPI?.pushPaths) return;
        const files = Array.from(event.dataTransfer?.files || []);
        const paths = files.map((file) => file.path).filter(Boolean);
        if (!paths.length) return;
        busy = true;
        overlay.hidden = false;
        overlay.classList.add("is-busy");
        overlay.querySelector(".session-file-drop-label").textContent = "Envoi…";
        try {
            await window.deviceFsAPI.pushPaths({ sessionId, deviceId, paths });
        } finally {
            busy = false;
            overlay.classList.remove("is-busy");
            overlay.querySelector(".session-file-drop-label").textContent =
                "Déposer pour envoyer vers Téléchargements";
            hide();
        }
    });
})();
