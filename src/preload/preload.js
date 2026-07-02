const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    // --- Devices ---
    getDevices: () => ipcRenderer.invoke("get-devices"),
    getApps: (serial) => ipcRenderer.invoke("get-apps", serial),
    getDeviceInfo: (serial) => ipcRenderer.invoke("device:info", serial),

    // --- Sessions ---
    sessionCreate: (deviceId, options) => ipcRenderer.invoke("session:create", deviceId, options),
    sessionDestroy: (sessionId) => ipcRenderer.invoke("session:destroy", sessionId),
    sessionList: () => ipcRenderer.invoke("session:list"),
    sessionGet: (sessionId) => ipcRenderer.invoke("session:get", sessionId),
    sessionPause: (sessionId) => ipcRenderer.invoke("session:pause", sessionId),
    sessionResume: (sessionId) => ipcRenderer.invoke("session:resume", sessionId),
    onSessionUpdate: (callback) => ipcRenderer.on("session:update", (event, data) => callback(data)),

    // --- Layout ---
    layoutSet: (layoutId) => ipcRenderer.invoke("layout:set", layoutId),
    layoutList: () => ipcRenderer.invoke("layout:list"),
    layoutCreate: (mode, slots) => ipcRenderer.invoke("layout:create", mode, slots),

    // --- Focus ---
    focusSet: (sessionId) => ipcRenderer.invoke("focus:set", sessionId),
    focusGet: () => ipcRenderer.invoke("focus:get"),
    onFocusChanged: (callback) => ipcRenderer.on("focus:changed", (event, data) => callback(data)),

    // --- Video ---
    launchScrcpy: (serial, packageName, deviceName) => ipcRenderer.invoke("launch-scrcpy", { serial, packageName, deviceName }),
    focusScrcpyTab: (tabId) => ipcRenderer.invoke("focus-scrcpy-tab", tabId),
    closeScrcpyTab: (tabId) => ipcRenderer.invoke("close-scrcpy-tab", tabId),
    onTabClosed: (callback) => ipcRenderer.on("tab-closed", (event, tabId) => callback(tabId)),
    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    close: () => ipcRenderer.send("window-close"),

    // --- Nouvelles fonctions pour le flux vidéo natif ---
    startVideoStream: (serial, tabId, packageName, options) => ipcRenderer.invoke("start-video-stream", { serial, tabId, packageName, options }),
    stopVideoStream: (tabId) => ipcRenderer.invoke("stop-video-stream", tabId),
    sendInput: (payload) => ipcRenderer.invoke("send-input", payload),
    onVideoCodecMeta: (callback) => ipcRenderer.on("video-codec-meta", (event, data) => callback(data)),
    onVideoPacket: (callback) => ipcRenderer.on("video-packet", (event, data) => callback(data)),
    onVideoError: (callback) => ipcRenderer.on("video-error", (event, data) => callback(data)),
    onVideoStreamState: (callback) => ipcRenderer.on("video-stream-state", (event, data) => callback(data)),
    onNewInstanceDisplayReady: (callback) => ipcRenderer.on("new-instance:display-ready", (event, data) => callback(data)),

    // --- Nouvelle session ---
    getApps: (serial) => ipcRenderer.invoke("get-apps", serial),
    getAppsWithDetails: (serial) => ipcRenderer.invoke("device:apps", serial),
    launchNewInstance: (serial, packageName, userId = null) => ipcRenderer.invoke("new-instance:launch", { serial, packageName, userId }),

    // --- Nouvelle instance Type B (IPC dedie) ---
    newInstanceCreate: (payload) => ipcRenderer.invoke("new-instance:create", payload),
    newInstanceStart: (payload) => ipcRenderer.invoke("new-instance:start", payload),
    newInstanceStop: (payload) => ipcRenderer.invoke("new-instance:stop", payload),
    newInstanceList: () => ipcRenderer.invoke("new-instance:list"),
    newInstanceSendInput: (payload) => ipcRenderer.invoke("new-instance:send-input", payload),
    onNewInstanceVideoCodecMeta: (callback) => ipcRenderer.on("new-instance:video-codec-meta", (event, data) => callback(data)),
    onNewInstanceVideoPacket: (callback) => ipcRenderer.on("new-instance:video-packet", (event, data) => callback(data)),
    onNewInstanceVideoError: (callback) => ipcRenderer.on("new-instance:video-error", (event, data) => callback(data)),
    onNewInstanceState: (callback) => ipcRenderer.on("new-instance:state", (event, data) => callback(data)),

});
