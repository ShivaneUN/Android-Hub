const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("screenPowerOverlayAPI", {
    onRender: (callback) => {
        ipcRenderer.on("screenPowerOverlay:render", (_event, payload) => callback(payload));
    },
    onPanel: (callback) => {
        ipcRenderer.on("screenPowerOverlay:panel", (_event, payload) => callback(payload));
    },
    hide: () => ipcRenderer.invoke("screenPowerOverlay:hide"),
    getPanel: () => ipcRenderer.invoke("screenPowerOverlay:getPanel"),
    toggleDevice: (payload = {}) => ipcRenderer.invoke("screenPowerOverlay:toggleDevice", payload),
    toggleGlobal: () => ipcRenderer.invoke("screenPowerOverlay:toggleGlobal")
});
