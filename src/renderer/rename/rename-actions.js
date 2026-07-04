/**
 * Actions de renommage partagées (appareils et sessions).
 */
(function initRenameActions() {
    async function syncLocalSessionLabels() {
        if (!window.sessionAPI?.list) return;

        const sessions = await window.sessionAPI.list();
        const byId = new Map(sessions.map((session) => [session.sessionId, session]));

        if (typeof window.getAllInstances === "function") {
            for (const instance of window.getAllInstances()) {
                const session = byId.get(instance.id);
                if (session?.label) {
                    instance.label = session.label;
                }
            }
        }

        if (typeof window.getAllNewInstanceSessions === "function") {
            for (const session of window.getAllNewInstanceSessions()) {
                const updated = byId.get(session.sessionId);
                if (updated?.label) {
                    session.label = updated.label;
                }
            }
        }
    }

    async function refreshAllNames() {
        await syncLocalSessionLabels();

        if (typeof window.refreshDevices === "function") {
            window.refreshDevices();
        }
        if (typeof window.renderSidebar === "function") {
            window.renderSidebar().catch(console.error);
        }
        if (typeof window.renderDevicePanel === "function" && typeof window.getCurrentDevices === "function") {
            window.renderDevicePanel(window.getCurrentDevices());
        }
        window.dispatchEvent(new CustomEvent("custom-names-updated"));
    }

    function confirmReset() {
        return window.confirm("Réinitialiser le nom d'origine ?");
    }

    function openDeviceRename(serial, currentName, originalName) {
        if (!window.namesAPI?.openRenameDialog) return;
        void window.namesAPI.openRenameDialog({
            kind: "device",
            serial,
            currentName,
            originalName: originalName || currentName
        });
    }

    async function resetDeviceName(serial) {
        if (!window.namesAPI || !confirmReset()) return;
        const result = await window.namesAPI.resetDevice({ serial });
        if (result?.success) await refreshAllNames();
    }

    function openSessionRename(sessionId, currentName) {
        if (!window.namesAPI?.openRenameDialog) return;
        void window.namesAPI.openRenameDialog({
            kind: "session",
            sessionId,
            currentName
        });
    }

    async function resetSessionName(sessionId) {
        if (!window.namesAPI || !confirmReset()) return;
        const result = await window.namesAPI.resetSession({ sessionId });
        if (result?.success) await refreshAllNames();
    }

    function attachDeviceContextMenu(card, device) {
        const serial = device.serial;
        if (!serial) return;

        card.addEventListener("contextmenu", (event) => {
            if (!window.showRenameContextMenu) return;
            window.showRenameContextMenu(event, {
                kind: "device",
                serial,
                currentName: device.name,
                originalName: device.originalName || device.name,
                hasCustomName: Boolean(device.hasCustomName),
                connected: Boolean(device.connected)
            });
        });
    }

    function attachSessionContextMenu(tab, sessionId, label, hasCustomName) {
        tab.addEventListener("contextmenu", (event) => {
            if (event.target.classList.contains("tab-close")) return;
            if (!window.showRenameContextMenu) return;

            window.showRenameContextMenu(event, {
                kind: "session",
                sessionId,
                currentName: label,
                hasCustomName: Boolean(hasCustomName)
            });
        });
    }

    if (window.namesAPI?.onUpdated) {
        window.namesAPI.onUpdated(() => {
            refreshAllNames().catch(console.error);
        });
    }

    if (window.deviceColorsAPI?.onUpdated) {
        window.deviceColorsAPI.onUpdated(() => {
            if (typeof window.refreshDevices === "function") {
                window.refreshDevices();
            }
            if (typeof window.renderSidebar === "function") {
                window.renderSidebar().catch(console.error);
            }
        });
    }

    window.renameActions = {
        refreshAllNames,
        syncLocalSessionLabels,
        attachDeviceContextMenu,
        attachSessionContextMenu,
        openDeviceRename,
        openSessionRename,
        resetDeviceName,
        resetSessionName
    };
})();
