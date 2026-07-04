const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tooltipOverlayAPI", {
    onUpdate: (callback) => {
        ipcRenderer.on("video-preview:update", (_event, payload) => callback(payload));
    }
});
