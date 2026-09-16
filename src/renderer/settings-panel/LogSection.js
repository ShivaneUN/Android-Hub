(function initLogSection() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    let bound = false;
    let autoScroll = true;

    function getOutput() {
        return document.getElementById("settings-log-output");
    }

    function formatTime(ts) {
        const date = new Date(ts);
        if (Number.isNaN(date.getTime())) return "--:--:--";
        return date.toLocaleTimeString("fr-FR", { hour12: false })
            + "." + String(date.getMilliseconds()).padStart(3, "0");
    }

    function formatLine(entry) {
        const session = entry.sessionId ? ` ${entry.sessionId}` : "";
        return `[${formatTime(entry.ts)}] ${String(entry.level || "info").toUpperCase()} ${entry.scope || "hub"}${session} — ${entry.message}`;
    }

    function appendLine(entry) {
        const output = getOutput();
        if (!output || !entry?.message) return;
        const line = document.createElement("div");
        line.className = `settings-log-line is-${entry.level || "info"}`;
        line.textContent = formatLine(entry);
        output.appendChild(line);
        while (output.childElementCount > 400) {
            output.removeChild(output.firstChild);
        }
        if (autoScroll) {
            output.scrollTop = output.scrollHeight;
        }
    }

    function renderAll(entries) {
        const output = getOutput();
        if (!output) return;
        output.replaceChildren();
        (entries || []).forEach((entry) => appendLine(entry));
        output.scrollTop = output.scrollHeight;
        autoScroll = true;
    }

    async function loadSnapshot() {
        const api = window.hubLogAPI;
        if (!api?.list) return;
        try {
            const result = await api.list();
            renderAll(result?.entries || []);
        } catch (_err) {
            renderAll([{
                ts: Date.now(),
                level: "error",
                scope: "log",
                message: t("settingsPanel.logLoadFailed")
            }]);
        }
    }

    async function clearLog() {
        try {
            await window.hubLogAPI?.clear?.();
        } catch (_err) {
            /* still wipe UI */
        }
        renderAll([]);
    }

    async function copyLog() {
        const output = getOutput();
        const text = output ? output.innerText : "";
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            window.showHubToast?.(t("settingsPanel.logCopied"), "success");
        } catch (_err) {
            window.showHubToast?.(t("settingsPanel.logCopyFailed"), "error");
        }
    }

    function bindLogSection() {
        if (!bound) {
            bound = true;
            const output = getOutput();
            output?.addEventListener("scroll", () => {
                if (!output) return;
                const gap = output.scrollHeight - output.scrollTop - output.clientHeight;
                autoScroll = gap < 32;
            });
            document.getElementById("settings-log-clear")?.addEventListener("click", () => {
                void clearLog();
            });
            document.getElementById("settings-log-copy")?.addEventListener("click", () => {
                void copyLog();
            });
            window.hubLogAPI?.onEntry?.((payload) => {
                if (payload?.type === "cleared") {
                    renderAll([]);
                    return;
                }
                appendLine(payload);
            });
        }
        void loadSnapshot();
    }

    window.bindLogSection = bindLogSection;
})();
