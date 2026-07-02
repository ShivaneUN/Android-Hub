const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    getDevices: () => ipcRenderer.invoke("get-devices"),
    getApps: (serial) => ipcRenderer.invoke("get-apps", serial),

    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    close: () => ipcRenderer.send("window-close"),

    // Mode 1 : Device Mirroring (écran physique)
    startVideoStream: (serial, tabId, packageName, options) => ipcRenderer.invoke("start-video-stream", { serial, tabId, packageName, options }),
    stopVideoStream: (tabId) => ipcRenderer.invoke("stop-video-stream", tabId),

    // Mode 2 : VirtualDisplay (écran virtuel isolé, GPU stream séparé)
    startVirtualDisplay: (serial, tabId, packageName, options) => ipcRenderer.invoke("start-virtual-display", { serial, tabId, packageName, options }),
    stopVirtualDisplay: (tabId) => ipcRenderer.invoke("stop-virtual-display", tabId),

    // Contrôle tactile unifié (device mirroring + virtual display)
    sendInput: (payload) => ipcRenderer.invoke("send-input", payload),

    // Événements vidéo (communs aux deux modes)
    onVideoCodecMeta: (callback) => ipcRenderer.on("video-codec-meta", (event, data) => callback(data)),
    onVideoPacket: (callback) => ipcRenderer.on("video-packet", (event, data) => callback(data)),
    onVideoError: (callback) => ipcRenderer.on("video-error", (event, data) => callback(data)),

    sessionsList: () => ipcRenderer.invoke("sessions-list"),
    sessionsCreate: (data) => ipcRenderer.invoke("sessions-create", data),
    sessionsUpdate: (id, updates) => ipcRenderer.invoke("sessions-update", id, updates),
    sessionsRemove: (id) => ipcRenderer.invoke("sessions-remove", id),

    bringAppToForeground: (deviceId, packageName) => ipcRenderer.invoke("bring-app-to-foreground", { deviceId, packageName })
});