const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wifiReconnectOverlayAPI", {
    onRender: (callback) => {
        ipcRenderer.on("wifi-reconnect-overlay:render", (_event, payload) => callback(payload));
    },
    hide: () => ipcRenderer.invoke("wifi-reconnect-overlay:hide"),
    reconnect: (payload) => ipcRenderer.invoke("wifi-reconnect-overlay:reconnect", payload),
    reportSize: (payload) => ipcRenderer.invoke("wifi-reconnect-overlay:report-size", payload)
});
