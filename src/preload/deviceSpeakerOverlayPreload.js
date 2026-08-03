const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deviceSpeakerOverlayAPI", {
    onRender: (callback) => {
        ipcRenderer.on("deviceSpeakerOverlay:render", (_event, payload) => callback(payload));
    },
    onPanel: (callback) => {
        ipcRenderer.on("deviceSpeakerOverlay:panel", (_event, payload) => callback(payload));
    },
    hide: () => ipcRenderer.invoke("deviceSpeakerOverlay:hide"),
    getPanel: () => ipcRenderer.invoke("deviceSpeakerOverlay:getPanel"),
    setVolume: (payload = {}) => ipcRenderer.invoke("deviceSpeakerOverlay:setVolume", payload),
    setGlobalVolume: (payload = {}) => ipcRenderer.invoke("deviceSpeakerOverlay:setGlobalVolume", payload),
    toggleDeviceAudio: (payload = {}) => ipcRenderer.invoke("deviceSpeakerOverlay:toggleDeviceAudio", payload),
    toggleGlobalAudio: () => ipcRenderer.invoke("deviceSpeakerOverlay:toggleGlobalAudio")
});
