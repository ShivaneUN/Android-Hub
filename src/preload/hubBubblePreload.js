const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hubBubbleOverlayAPI", {
    onRender: (callback) => {
        ipcRenderer.on("hub-bubble:render", (_event, payload) => callback(payload));
    },
    reportSize: (payload) => ipcRenderer.invoke("hub-bubble:report-size", payload)
});
