/**
 * Menu contextuel natif Electron (via IPC main process).
 * Le menu DOM HTML ne peut pas passer au-dessus des BrowserView vidéo.
 */
(function initContextMenuBridge() {
    async function closeSessionById(sessionId) {
        if (sessionId.startsWith("instance-") && typeof closeInstance === "function") {
            await closeInstance(sessionId);
        } else if (typeof closeNewInstanceSession === "function") {
            await closeNewInstanceSession(sessionId);
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

        void window.namesAPI.showContextMenu({
            x: event.screenX,
            y: event.screenY,
            target
        });
    }

    if (window.namesAPI?.onContextMenuAction) {
        window.namesAPI.onContextMenuAction((data) => {
            if (data?.action === "close-session" && data.sessionId) {
                closeSessionById(data.sessionId).catch(console.error);
            }
        });
    }

    window.showRenameContextMenu = showNativeContextMenu;
})();
