/**
 * Contrôleur renderer — délègue à une fenêtre Electron always-on-top
 * (au-dessus des BrowserView vidéo).
 */
(function initRenameDialog() {
    function openRenameDialog(options = {}) {
        if (!window.namesAPI?.openRenameDialog) return;
        void window.namesAPI.openRenameDialog(options);
    }

    function closeRenameDialog() {
        if (!window.namesAPI?.cancelRenameDialog) return;
        void window.namesAPI.cancelRenameDialog();
    }

    window.openRenameDialog = openRenameDialog;
    window.closeRenameDialog = closeRenameDialog;
})();
