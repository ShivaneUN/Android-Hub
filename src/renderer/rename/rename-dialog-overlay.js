(function initRenameDialogOverlay() {
    const root = document.getElementById("rename-root");
    const input = document.getElementById("rename-input");
    const errorEl = document.getElementById("rename-error");
    if (!root || !input || !errorEl || !window.renameDialogAPI) return;

    function setError(message) {
        errorEl.textContent = message || "";
    }

    async function submit() {
        const value = input.value.trim();
        if (!value) {
            setError("Le nom ne peut pas être vide.");
            return;
        }

        const result = await window.renameDialogAPI.submit(value);
        if (result?.success === false) {
            setError(result.error || "Impossible d'enregistrer le nom.");
            return;
        }
        setError("");
    }

    function cancel() {
        window.renameDialogAPI.cancel();
    }

    root.querySelector('[data-action="cancel"]').addEventListener("click", cancel);
    root.querySelector('[data-action="save"]').addEventListener("click", submit);

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            submit();
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
        }
    });

    window.renameDialogAPI.onOpen((payload) => {
        input.value = payload?.currentName || "";
        setError("");
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    });

    window.__renameDialogReady = true;
    window.dispatchEvent(new Event("rename-dialog-ready"));
})();
