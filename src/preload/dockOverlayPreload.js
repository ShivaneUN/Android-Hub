const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dockOverlayAPI", {
    invokeClick: (buttonId) => ipcRenderer.invoke("dock-hover:invoke-click", buttonId),
    hide: () => ipcRenderer.invoke("dock-hover:hide"),
    onRender: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("dock-hover:render", listener);
        return () => ipcRenderer.removeListener("dock-hover:render", listener);
    }
});
