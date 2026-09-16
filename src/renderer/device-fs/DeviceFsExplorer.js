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
    let previewToken = 0;

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function pane() {
        return document.getElementById("settings-pane-files");
    }

    function deviceKeyOf(device) {
        return device?.deviceId || device?.serial || "";
    }

    async function listOnlineDevices() {
        let devices = typeof window.getConnectedDevices === "function"
            ? window.getConnectedDevices()
            : [];
        if (!devices.length && window.electronAPI?.getDevices) {
            try {
                const list = await window.electronAPI.getDevices({ lightweight: true });
                devices = (Array.isArray(list) ? list : []).filter((item) => item?.connected !== false);
            } catch (_err) {
                devices = [];
            }
        }
        if (!devices.length && window.wifiAPI?.getPanelData) {
            try {
                const panel = await window.wifiAPI.getPanelData();
                const usb = (panel?.usb || []).filter((entry) => entry.connected);
                const wifi = (panel?.wifi || []).filter((entry) => entry.adbState === "connected");
                devices = [...usb, ...wifi].map((entry) => ({
                    deviceId: entry.deviceId || entry.serial,
                    serial: entry.serial || entry.adbTarget || entry.deviceId,
                    name: entry.name
                }));
            } catch (_err) {
                devices = [];
            }
        }
        return devices.filter((item) => deviceKeyOf(item));
    }

    function fillDeviceSelect(devices, preferredKey) {
        const select = document.getElementById("device-fs-device-select");
        if (!select) return;
        const preferred = String(preferredKey || state.deviceId || state.serial || "");
        select.innerHTML = devices.map((device) => {
            const key = deviceKeyOf(device);
            const label = device.name || device.serial || key;
            const selected = key === preferred || device.serial === preferred ? " selected" : "";
            return `<option value="${escapeHtml(key)}" data-serial="${escapeHtml(device.serial || key)}" data-name="${escapeHtml(label)}"${selected}>${escapeHtml(label)}</option>`;
        }).join("");
        const chosen = select.selectedOptions[0];
        if (chosen) {
            state.deviceId = chosen.value;
            state.serial = chosen.dataset.serial || chosen.value;
            state.deviceName = chosen.dataset.name || chosen.value;
        }
        select.hidden = devices.length <= 1;
        const label = pane()?.querySelector(".device-fs-device-label");
        if (label) label.hidden = devices.length <= 1;
    }

    function isOpen() {
        const el = pane();
        return Boolean(el && el.classList.contains("active"));
    }

    function setStatus(message) {
        const el = document.getElementById("device-fs-status");
        if (el) el.textContent = message || "";
    }

    function setBusy(busy) {
        state.loading = Boolean(busy);
        pane()?.classList.toggle("is-busy", state.loading);
        ["device-fs-up-btn", "device-fs-upload-btn", "device-fs-download-btn", "device-fs-open-btn", "device-fs-mkdir-btn", "device-fs-delete-btn"]
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
            return `<li class="device-fs-item${selected}${entry.isDir ? " is-dir" : ""}" data-path="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}" data-dir="${entry.isDir ? "1" : "0"}">
                <span class="device-fs-item-icon" aria-hidden="true">${entry.isDir ? FOLDER_ICON : FILE_ICON}</span>
                <span class="device-fs-item-name">${escapeHtml(entry.name)}</span>
            </li>`;
        }).join("");
    }

    function resetPreview(message) {
        previewToken += 1;
        const img = document.getElementById("device-fs-preview-img");
        const hint = document.getElementById("device-fs-preview-hint");
        if (img) {
            img.hidden = true;
            img.removeAttribute("src");
        }
        if (hint) hint.textContent = message || t("deviceFs.previewHint");
    }

    async function showPreview(entry) {
        const img = document.getElementById("device-fs-preview-img");
        const hint = document.getElementById("device-fs-preview-hint");
        if (!entry || entry.isDir) {
            resetPreview();
            return;
        }
        if (!window.deviceFsAPI?.preview) {
            resetPreview(t("deviceFs.previewUnavailable"));
            return;
        }
        const token = ++previewToken;
        if (img) {
            img.hidden = true;
            img.removeAttribute("src");
        }
        if (hint) hint.textContent = t("deviceFs.previewLoading");
        try {
            const result = await window.deviceFsAPI.preview({
                deviceId: state.deviceId,
                serial: state.serial,
                path: entry.path
            });
            if (token !== previewToken) return;
            if (result?.previewable && result.data && result.mime) {
                if (img) {
                    img.src = `data:${result.mime};base64,${result.data}`;
                    img.hidden = false;
                }
                if (hint) hint.textContent = entry.name;
                return;
            }
            if (hint) {
                hint.textContent = result?.tooLarge
                    ? t("deviceFs.previewTooLarge")
                    : t("deviceFs.previewUnavailable");
            }
        } catch (err) {
            if (token !== previewToken) return;
            if (hint) hint.textContent = err?.message || t("deviceFs.previewUnavailable");
        }
    }

    async function openSelected(entry = state.selected) {
        if (!entry) {
            window.showHubToast?.(t("deviceFs.selectFirst"), "info");
            return;
        }
        if (entry.isDir) {
            await refresh(entry.path);
            return;
        }
        if (!window.deviceFsAPI?.openLocal) {
            window.showHubToast?.(t("deviceFs.unavailable"), "error");
            return;
        }
        setStatus(t("deviceFs.loading"));
        const result = await window.deviceFsAPI.openLocal({
            deviceId: state.deviceId,
            serial: state.serial,
            path: entry.path,
            name: entry.name,
            isDir: false
        });
        if (!result?.success) {
            window.showHubToast?.(result?.error || t("deviceFs.openFailed"), "error");
            setStatus(result?.error || t("deviceFs.openFailed"));
            return;
        }
        setStatus("");
    }

    async function deleteSelected() {
        if (!state.selected?.path) {
            window.showHubToast?.(t("deviceFs.selectFirst"), "info");
            return;
        }
        if (!window.confirm(t("deviceFs.confirmDelete", { name: state.selected.name }))) return;
        setBusy(true);
        setStatus(t("deviceFs.loading"));
        try {
            const result = await window.deviceFsAPI.remove({
                deviceId: state.deviceId,
                serial: state.serial,
                path: state.selected.path
            });
            if (!result?.success) {
                window.showHubToast?.(result?.error || t("deviceFs.deleteFailed"), "error");
                setStatus(result?.error || t("deviceFs.deleteFailed"));
                return;
            }
            state.selected = null;
            resetPreview();
            await refresh();
        } catch (err) {
            window.showHubToast?.(err?.message || t("deviceFs.deleteFailed"), "error");
            setStatus(err?.message || t("deviceFs.deleteFailed"));
        } finally {
            setBusy(false);
        }
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
            if (state.selected && !state.selected.isDir) {
                void showPreview(state.selected);
            } else {
                resetPreview();
            }
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

    async function openExplorer(payload = {}) {
        const el = pane();
        if (!el) return;
        const devices = await listOnlineDevices();
        state.selected = null;
        fillDeviceSelect(devices, payload.deviceId || payload.serial);
        globalThis.HubI18n?.applyDomI18n?.(el);
        if (!devices.length) {
            state.deviceId = null;
            state.serial = null;
            state.deviceName = "";
            state.entries = [];
            state.path = "/sdcard";
            renderList();
            setStatus(t("deviceFs.noDevice"));
            return;
        }
        state.deviceId = payload.deviceId || payload.serial || deviceKeyOf(devices[0]);
        state.serial = payload.serial || payload.deviceId || devices[0].serial || state.deviceId;
        state.deviceName = payload.deviceName || devices[0].name || state.deviceId;
        fillDeviceSelect(devices, state.deviceId);
        el.focus({ preventScroll: true });
        await refresh("/sdcard");
    }

    function closeExplorer() {
        state.selected = null;
        setStatus("");
    }

    async function refreshExplorer() {
        if (!state.deviceId && !state.serial) {
            await openExplorer({});
            return;
        }
        await refresh();
    }

    function bindOnce() {
        const el = pane();
        if (!el || el.dataset.bound === "1") return;
        el.dataset.bound = "1";

        document.getElementById("device-fs-device-select")?.addEventListener("change", (event) => {
            const option = event.target?.selectedOptions?.[0];
            if (!option) return;
            state.deviceId = option.value;
            state.serial = option.dataset.serial || option.value;
            state.deviceName = option.dataset.name || option.value;
            state.selected = null;
            void refresh("/sdcard");
        });
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
        document.getElementById("device-fs-open-btn")?.addEventListener("click", () => {
            void openSelected();
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
        document.getElementById("device-fs-delete-btn")?.addEventListener("click", () => {
            void deleteSelected();
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
            if (!item || item.classList.contains("device-fs-empty")) return;
            const entry = {
                path: item.dataset.path,
                name: item.dataset.name,
                isDir: item.dataset.dir === "1"
            };
            if (entry.isDir) {
                if (event.detail !== 1) return;
                void refresh(entry.path);
                return;
            }
            if (event.detail !== 1) return;
            state.selected = entry;
            renderList();
            void showPreview(entry);
        });
        list?.addEventListener("dblclick", (event) => {
            const item = event.target.closest(".device-fs-item");
            if (!item || item.dataset.dir === "1") return;
            void openSelected({
                path: item.dataset.path,
                name: item.dataset.name,
                isDir: false
            });
        });

        pane()?.addEventListener("keydown", (event) => {
            if (!isOpen()) return;
            if (event.key !== "Delete") return;
            if (event.target?.closest("input, textarea, select")) return;
            event.preventDefault();
            void deleteSelected();
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
    window.refreshDeviceFsExplorer = () => {
        bindOnce();
        return refreshExplorer();
    };
    window.isDeviceFsExplorerOpen = isOpen;
})();
