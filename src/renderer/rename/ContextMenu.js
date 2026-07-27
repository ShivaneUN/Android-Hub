/**
 * Menu contextuel natif Electron (via IPC main process).
 * Le menu DOM HTML ne peut pas passer au-dessus des BrowserView vidéo.
 */
(function initContextMenuBridge() {
    async function closeSessionById(sessionId, reason = "context-menu") {
        console.warn(`[ContextMenu] closeSessionById ${sessionId} reason=${reason}`);
        if (sessionId.startsWith("instance-") && typeof closeInstance === "function") {
            await closeInstance(sessionId);
        } else if (typeof closeNewInstanceSession === "function") {
            await closeNewInstanceSession(sessionId, reason);
        } else if (window.sessionAPI?.close) {
            await window.sessionAPI.close(sessionId);
        }

        if (typeof window.renderSidebar === "function") {
            window.renderSidebar().catch(console.error);
        }
    }

    /**
     * @param {MouseEvent} event
     * @param {object} target
     */
    function showNativeContextMenu(event, target) {
        event.preventDefault();
        event.stopPropagation();

        if (!window.namesAPI?.showContextMenu) return;

        // menu.popup x/y = coords relatives à la fenêtre (pas screenX/Y).
        let x = Math.round(event.clientX);
        let y = Math.round(event.clientY);

        if (target?.kind === "device") {
            const card = event.currentTarget?.closest?.(".sidebar-device-card")
                || event.target?.closest?.(".sidebar-device-card")
                || event.currentTarget?.closest?.(".dock-device-chip")
                || event.target?.closest?.(".dock-device-chip")
                || event.currentTarget;
            if (card?.getBoundingClientRect) {
                const rect = card.getBoundingClientRect();
                const menuWidth = target.colorsOnly ? 160 : 180;
                x = Math.round(rect.left + (rect.width / 2) - (menuWidth / 2));
                y = Math.round(rect.bottom + 6);
                x = Math.max(8, Math.min(x, Math.round(window.innerWidth - menuWidth - 8)));
                y = Math.max(8, Math.min(y, Math.round(window.innerHeight - 8)));
            }
        }

        void window.namesAPI.showContextMenu({
            x,
            y,
            target
        });
    }

    if (window.namesAPI?.onContextMenuAction) {
        window.namesAPI.onContextMenuAction((data) => {
            if (data?.action === "close-session" && data.sessionId) {
                closeSessionById(data.sessionId).catch(console.error);
            }
            if (data?.action === "home-fab-toggle-lock" && data.fabId) {
                window.dispatchEvent(new CustomEvent("home-fab-toggle-lock", {
                    detail: { fabId: data.fabId }
                }));
            }
            if (data?.action === "home-fab-group-toggle-lock" && Array.isArray(data.fabIds)) {
                window.dispatchEvent(new CustomEvent("home-fab-group-toggle-lock", {
                    detail: { fabIds: data.fabIds }
                }));
            }
            if (data?.action === "home-app-pin" || data?.action === "home-app-unpin") {
                window.dispatchEvent(new CustomEvent(data.action, {
                    detail: {
                        deviceId: data.deviceId,
                        packageName: data.packageName,
                        appName: data.appName,
                        userId: data.userId ?? null,
                        iconPath: data.iconPath || null,
                        iconUrl: data.iconUrl || null
                    }
                }));
            }
        });
    }

    window.showRenameContextMenu = showNativeContextMenu;
})();
