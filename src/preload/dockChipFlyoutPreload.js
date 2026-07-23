const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dockChipFlyoutOverlayAPI", {
    onRender: (callback) => {
        ipcRenderer.on("dock-chip-flyout:render", (_event, payload) => callback(payload));
    },
    reportSize: (payload) => ipcRenderer.invoke("dock-chip-flyout:report-size", payload),
    hide: () => ipcRenderer.invoke("dock-chip-flyout:hide"),
    toggleAudio: (payload) => ipcRenderer.invoke("dock-chip-flyout:toggle-audio", payload),
    toggleWifi: (payload) => ipcRenderer.invoke("dock-chip-flyout:toggle-wifi", payload),
    keepOpen: () => ipcRenderer.invoke("dock-chip-flyout:keep-open")
});
