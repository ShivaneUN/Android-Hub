const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoAPI", {
    startVideoStream: (serial, tabId, packageName, options) =>
        ipcRenderer.invoke("start-video-stream", { serial, tabId, packageName, options }),
    stopVideoStream: (tabId) => ipcRenderer.invoke("stop-video-stream", tabId),
    sendInput: (payload) => ipcRenderer.invoke("send-input", payload),
    onVideoCodecMeta: (callback) => ipcRenderer.on("video-codec-meta", (_event, data) => callback(data)),
    onVideoPacket: (callback) => ipcRenderer.on("video-packet", (_event, data) => callback(data)),
    onVideoError: (callback) => ipcRenderer.on("video-error", (_event, data) => callback(data)),
    onVideoStreamState: (callback) => ipcRenderer.on("video-stream-state", (_event, data) => callback(data)),

    newInstanceStart: (payload) => ipcRenderer.invoke("new-instance:start", payload),
    newInstanceStop: (payload) => ipcRenderer.invoke("new-instance:stop", payload),
    newInstanceSendInput: (payload) => ipcRenderer.invoke("new-instance:send-input", payload),
    onNewInstanceVideoCodecMeta: (callback) =>
        ipcRenderer.on("new-instance:video-codec-meta", (_event, data) => callback(data)),
    onNewInstanceVideoPacket: (callback) =>
        ipcRenderer.on("new-instance:video-packet", (_event, data) => callback(data)),
    onNewInstanceVideoError: (callback) =>
        ipcRenderer.on("new-instance:video-error", (_event, data) => callback(data)),
    onNewInstanceState: (callback) =>
        ipcRenderer.on("new-instance:state", (_event, data) => callback(data)),
    onStreamRestarting: (callback) =>
        ipcRenderer.on("stream-restarting", (_event, data) => callback(data)),
    onOrientationChanged: (callback) =>
        ipcRenderer.on("session:orientation-changed", (_event, data) => callback(data)),
    onCaptureRotationChanged: (callback) =>
        ipcRenderer.on("session:capture-rotation-changed", (_event, data) => callback(data)),
    onSessionInputActive: (callback) =>
        ipcRenderer.on("session:input-active", (_event, data) => callback(data)),
    onAudioCodecMeta: (callback) => ipcRenderer.on("audio-codec-meta", (_event, data) => callback(data)),
    onAudioPacket: (callback) => ipcRenderer.on("audio-packet", (_event, data) => callback(data)),
    onNewInstanceAudioCodecMeta: (callback) =>
        ipcRenderer.on("new-instance:audio-codec-meta", (_event, data) => callback(data)),
    onNewInstanceAudioPacket: (callback) =>
        ipcRenderer.on("new-instance:audio-packet", (_event, data) => callback(data)),
    getInputContext: (sessionId) => ipcRenderer.invoke("session:getInputContext", sessionId),
    activateSession: (sessionId) => ipcRenderer.invoke("session:switchTo", sessionId),
    reportLaunchLatencyFirstFrame: (sessionId, ts) =>
        ipcRenderer.send("launch-latency:first-frame", { sessionId, ts: ts || Date.now() }),
    appendHubLog: (payload) => ipcRenderer.send("hub-log:append", payload || {})
});

contextBridge.exposeInMainWorld("deviceFsAPI", {
    pushPaths: (payload) => ipcRenderer.invoke("device-fs:push-paths", payload)
});

contextBridge.exposeInMainWorld("audioAPI", {
    getGlobalState: () => ipcRenderer.invoke("audio:getGlobalState"),
    onGlobalStateChanged: (callback) =>
        ipcRenderer.on("audio:global-state-changed", (_event, data) => callback(data))
});
