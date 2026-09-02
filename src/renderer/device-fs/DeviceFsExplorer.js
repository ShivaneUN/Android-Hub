(function initDeviceFsExplorer() {
    const t = (key, vars) => globalThis.HubI18n?.t(key, vars) ?? key;

    const FOLDER_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h6l2 2h10v10H3z"/></svg>`;
    const FILE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

    let state = {
        deviceId: null,
        serial: null,
        deviceName: "",
        path: "/sdcard",
        parent: "/sdcard",
        atRoot: true,
        entries: [],
        selected: null,
        loading: false
    };

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function overlay() {
        return document.getElementById("device-fs-overlay");
    }

    function isOpen() {
        const el = overlay();
        return Boolean(el && !el.classList.contains("hidden"));
    }

    function setStatus(message) {
        const el = document.getElementById("device-fs-status");
        if (el) el.textContent = message || "";
    }

    function setBusy(busy) {
        state.loading = Boolean(busy);
        overlay()?.classList.toggle("is-busy", state.loading);
        ["device-fs-up-btn", "device-fs-upload-btn", "device-fs-download-btn", "device-fs-mkdir-btn", "device-fs-delete-btn"]
            .forEach((id) => {
                const btn = document.getElementById(id);
                if (btn && id !== "device-fs-up-btn") btn.disabled = state.loading;
            });
        const up = document.getElementById("device-fs-up-btn");
        if (up) up.disabled = state.loading || state.atRoot;
    }

    function renderList() {
        const list = document.getElementById("device-fs-list");
        const pathEl = document.getElementById("device-fs-path");
        const titleEl = document.getElementById("device-fs-title");
        if (pathEl) pathEl.textContent = state.path;
        if (titleEl) {
            titleEl.textContent = t("deviceFs.title", { name: state.deviceName || state.deviceId || "" });
        }
        if (!list) return;

        if (!state.entries.length) {
            list.innerHTML = `<li class="device-fs-empty">${escapeHtml(t("deviceFs.empty"))}</li>`;
            return;
        }

        list.innerHTML = state.entries.map((entry) => {
            const selected = state.selected?.path === entry.path ? " is-selected" : "";
            return `<li class="device-fs-item${selected}${entry.isDir ? " is-dir" : ""}" data-path="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}" data-dir="${entry.isDir ? "1" : "0"}" draggable="false">
                <span class="device-fs-item-icon" aria-hidden="true">${entry.isDir ? FOLDER_ICON : FILE_ICON}</span>
                <span class="device-fs-item-name">${escapeHtml(entry.name)}</span>
            </li>`;
        }).join("");
    }

    async function refresh(remotePath = state.path) {
        if (!window.deviceFsAPI?.list) {
            setStatus(t("deviceFs.unavailable"));
            return;
        }
        setBusy(true);
        setStatus(t("deviceFs.loading"));
        try {
            const result = await window.deviceFsAPI.list({
                deviceId: state.deviceId,
                serial: state.serial,
                path: remotePath
            });
            if (!result?.success) {
                setStatus(result?.error || t("deviceFs.listFailed"));
                return;
            }
            state.path = result.path;
            state.parent = result.parent;
            state.atRoot = Boolean(result.atRoot);
            state.entries = Array.isArray(result.entries) ? result.entries : [];
            if (state.selected && !state.entries.some((item) => item.path === state.selected.path)) {
                state.selected = null;
            }
            renderList();
            setStatus("");
        } catch (err) {
            setStatus(err?.message || t("deviceFs.listFailed"));
        } finally {
            setBusy(false);
        }
    }

    function hintPayload() {
        return {
            deviceId: state.deviceId,
            serial: state.serial,
            path: state.path
        };
    }

    async function openExplorer({ deviceId, serial, deviceName } = {}) {
        const el = overlay();
        if (!el) return;
        state.deviceId = deviceId || serial || null;
        state.serial = serial || deviceId || null;
        state.deviceName = deviceName || "";
        state.selected = null;
        el.classList.remove("hidden");
        globalThis.HubI18n?.applyDomI18n?.(el);
        await refresh("/sdcard");
    }

    function closeExplorer() {
        overlay()?.classList.add("hidden");
        state.selected = null;
        setStatus("");
    }

    function bindOnce() {
        const el = overlay();
        if (!el || el.dataset.bound === "1") return;
        el.dataset.bound = "1";

        document.getElementById("device-fs-close-btn")?.addEventListener("click", () => closeExplorer());
        document.getElementById("device-fs-up-btn")?.addEventListener("click", () => {
            if (state.atRoot) return;
            void refresh(state.parent);
        });
        document.getElementById("device-fs-upload-btn")?.addEventListener("click", async () => {
            const result = await window.deviceFsAPI.pickAndPush(hintPayload());
            if (result?.cancelled) return;
            if (!result?.success) {
                window.showHubToast?.(result?.error || t("deviceFs.uploadFailed"), "error");
                return;
            }
            await refresh();
        });
        document.getElementById("device-fs-download-btn")?.addEventListener("click", async () => {
            if (!state.selected) {
                window.showHubToast?.(t("deviceFs.selectFirst"), "info");
                return;
            }
            const result = await window.deviceFsAPI.pull({
                ...hintPayload(),
                path: state.selected.path,
                name: state.selected.name,
                isDir: state.selected.isDir
            });
            if (result?.cancelled) return;
            if (!result?.success) {
                window.showHubToast?.(result?.error || t("deviceFs.downloadFailed"), "error");
            }
        });
        document.getElementById("device-fs-mkdir-btn")?.addEventListener("click", async () => {
            const name = window.prompt(t("deviceFs.mkdirPrompt"));
            if (!name) return;
            const result = await window.deviceFsAPI.mkdir({ ...hintPayload(), name });
            if (!result?.success) {
                window.showHubToast?.(result?.error || t("deviceFs.mkdirFailed"), "error");
                return;
            }
            await refresh();
        });
        document.getElementById("device-fs-delete-btn")?.addEventListener("click", async () => {
            if (!state.selected) {
                window.showHubToast?.(t("deviceFs.selectFirst"), "info");
                return;
            }
            if (!window.confirm(t("deviceFs.confirmDelete", { name: state.selected.name }))) return;
            const result = await window.deviceFsAPI.remove({
                ...hintPayload(),
                path: state.selected.path
            });
            if (!result?.success) {
                window.showHubToast?.(result?.error || t("deviceFs.deleteFailed"), "error");
                return;
            }
            state.selected = null;
            await refresh();
        });

        el.addEventListener("click", (event) => {
            if (event.target === el) closeExplorer();
        });

        const shortcuts = el.querySelector("#device-fs-shortcuts");
        shortcuts?.addEventListener("click", (event) => {
            const btn = event.target.closest("[data-fs-shortcut]");
            if (!btn) return;
            void refresh(btn.getAttribute("data-fs-shortcut"));
        });

        const list = document.getElementById("device-fs-list");
        list?.addEventListener("click", (event) => {
            const item = event.target.closest(".device-fs-item");
            if (!item) return;
            state.selected = {
                path: item.dataset.path,
                name: item.dataset.name,
                isDir: item.dataset.dir === "1"
            };
            renderList();
        });
        list?.addEventListener("dblclick", (event) => {
            const item = event.target.closest(".device-fs-item");
            if (!item || item.dataset.dir !== "1") return;
            void refresh(item.dataset.path);
        });

        const dropZone = document.getElementById("device-fs-drop");
        const onDragOver = (event) => {
            if (![...event.dataTransfer.types].includes("Files")) return;
            event.preventDefault();
            dropZone?.classList.add("is-active");
        };
        const onDragLeave = () => dropZone?.classList.remove("is-active");
        const onDrop = async (event) => {
            event.preventDefault();
            dropZone?.classList.remove("is-active");
            const files = Array.from(event.dataTransfer?.files || []);
            const paths = files.map((file) => file.path).filter(Boolean);
            if (!paths.length) return;
            setBusy(true);
            const result = await window.deviceFsAPI.pushPaths({ ...hintPayload(), paths });
            setBusy(false);
            if (!result?.success && !result?.cancelled) {
                window.showHubToast?.(result?.error || t("deviceFs.uploadFailed"), "error");
                return;
            }
            await refresh();
        };
        dropZone?.addEventListener("dragover", onDragOver);
        dropZone?.addEventListener("dragleave", onDragLeave);
        dropZone?.addEventListener("drop", onDrop);
        list?.addEventListener("dragover", onDragOver);
        list?.addEventListener("drop", onDrop);

        window.deviceFsAPI?.onProgress?.((payload) => {
            if (!isOpen()) return;
            const name = payload?.name || "";
            const percent = Number.isFinite(payload?.percent) ? `${payload.percent}%` : "";
            setStatus(`${name} ${percent}`.trim());
        });
    }

    window.openDeviceFsExplorer = (payload) => {
        bindOnce();
        return openExplorer(payload || {});
    };
    window.closeDeviceFsExplorer = closeExplorer;
    window.isDeviceFsExplorerOpen = isOpen;
})();
