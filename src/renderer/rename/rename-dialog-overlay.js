(function initRenameDialogOverlay() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    const root = document.getElementById("rename-root");
    const input = document.getElementById("rename-input");
    const errorEl = document.getElementById("rename-error");
    if (!root || !input || !errorEl || !window.renameDialogAPI) return;

    const MAX_NAME_LENGTH = 50;

    function setError(message) {
        errorEl.textContent = message || "";
    }

    async function submit() {
        const value = input.value.trim();
        if (!value) {
            setError(t("rename.nameEmpty"));
            return;
        }
        if (value.length > MAX_NAME_LENGTH) {
            setError(t("rename.nameTooLong", { max: MAX_NAME_LENGTH }));
            return;
        }

        const result = await window.renameDialogAPI.submit(value);
        if (result?.success === false) {
            setError(result.error || t("rename.saveFailed"));
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

    globalThis.HubI18n?.onChange?.(() => {
        globalThis.HubI18n?.applyDomI18n?.(root);
    });

    window.__renameDialogReady = true;
    window.dispatchEvent(new Event("rename-dialog-ready"));
})();
