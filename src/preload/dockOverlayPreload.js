const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dockOverlayAPI", {
    invokeClick: (buttonId) => ipcRenderer.invoke("dock-hover:invoke-click", buttonId),
    hide: () => ipcRenderer.invoke("dock-hover:hide"),
    showTip: (payload) => ipcRenderer.invoke("dock-hover:show-tip", payload),
    hideTip: () => ipcRenderer.invoke("dock-hover:hide-tip"),
    onRender: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("dock-hover:render", listener);
        return () => ipcRenderer.removeListener("dock-hover:render", listener);
    }
});
