const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    // --- Devices ---
    getDevices: () => ipcRenderer.invoke("get-devices"),
    onDevicesRefreshRequest: (callback) =>
        ipcRenderer.on("devices:refresh-request", () => callback()),
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

    // --- Video ---
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

    // --- Metadonnees apps (icone + nom) ---
    resolveAppMetadata: (payload) => ipcRenderer.invoke("app-metadata:resolve", payload),
    prefetchAppMetadata: (payload) => ipcRenderer.invoke("app-metadata:prefetch", payload),
    onAppMetadataUpdated: (callback) => ipcRenderer.on("app-metadata:updated", (_event, data) => callback(data)),

    // --- Nouvelle session ---
    getApps: (serial) => ipcRenderer.invoke("get-apps", serial),
    getAppsWithDetails: (serial) => ipcRenderer.invoke("device:apps", serial),
    launchNewInstance: (serial, packageName, userId = null, latencyTraceId = null) =>
        ipcRenderer.invoke("new-instance:launch", { serial, packageName, userId, latencyTraceId }),

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
    onNewInstanceScrcpyClosed: (callback) => ipcRenderer.on("new-instance:scrcpy-closed", (_event, data) => callback(data)),
    onAudioCodecMeta: (callback) => ipcRenderer.on("audio-codec-meta", (_event, data) => callback(data)),
    onAudioPacket: (callback) => ipcRenderer.on("audio-packet", (_event, data) => callback(data)),
    onNewInstanceAudioCodecMeta: (callback) =>
        ipcRenderer.on("new-instance:audio-codec-meta", (_event, data) => callback(data)),
    onNewInstanceAudioPacket: (callback) =>
        ipcRenderer.on("new-instance:audio-packet", (_event, data) => callback(data)),

    // --- Mises à jour automatiques ---
    updateGetStatus: () => ipcRenderer.invoke("update:getStatus"),
    updateCheck: () => ipcRenderer.invoke("update:check"),
    updateDownload: () => ipcRenderer.invoke("update:download"),
    updateInstall: () => ipcRenderer.invoke("update:install"),
    onUpdateStatus: (callback) => ipcRenderer.on("update:status", (_event, data) => callback(data))
});

contextBridge.exposeInMainWorld("audioAPI", {
    getGlobalState: () => ipcRenderer.invoke("audio:getGlobalState"),
    setGlobalMuted: (muted) => ipcRenderer.invoke("audio:setGlobalMuted", { muted }),
    toggleGlobalMuted: () => ipcRenderer.invoke("audio:toggleGlobalMuted"),
    onGlobalStateChanged: (callback) =>
        ipcRenderer.on("audio:global-state-changed", (_event, data) => callback(data))
});

contextBridge.exposeInMainWorld("sessionAPI", {
    switchTo: (sessionId) => ipcRenderer.invoke("session:switchTo", sessionId),
    cycleTab: (direction) => ipcRenderer.invoke("session:cycleTab", { direction }),
    close: (sessionId) => ipcRenderer.invoke("session:close", sessionId),
    list: () => ipcRenderer.invoke("session:list"),
    onSessionActivated: (callback) => ipcRenderer.on("session:activated", (_event, data) => callback(data)),
    registerView: (sessionId, type, options = {}) =>
        ipcRenderer.invoke("session:registerView", {
            sessionId,
            type,
            deviceId: options.deviceId,
            stableDeviceId: options.stableDeviceId,
            label: options.label,
            screenOff: options.screenOff,
            stayAwakeActive: options.stayAwakeActive,
            packageName: options.packageName,
            userId: options.userId,
            streamParams: options.streamParams
        }),
    setContentBounds: (bounds) => ipcRenderer.invoke("session:setContentBounds", bounds),
    suppressView: () => ipcRenderer.invoke("session:suppressView"),
    restoreView: () => ipcRenderer.invoke("session:restoreView"),
    getActiveTypeA: () => ipcRenderer.invoke("session:getActiveTypeA"),
    toggleScreen: (sessionId) => ipcRenderer.invoke("session:toggleScreen", sessionId),
    getActiveOrientation: () => ipcRenderer.invoke("session:getActiveOrientation"),
    toggleOrientation: (sessionId) => ipcRenderer.invoke("session:toggleOrientation", sessionId),
    getStreamParams: (sessionId) => ipcRenderer.invoke("session:getStreamParams", sessionId),
    applyStreamParams: (sessionId, params) =>
        ipcRenderer.invoke("session:applyStreamParams", { sessionId, params }),
    resetStreamParams: (sessionId) => ipcRenderer.invoke("session:resetStreamParams", sessionId),
    getFrameCounts: () => ipcRenderer.invoke("session:getFrameCounts"),
    getPreviewFrame: (sessionId) => ipcRenderer.invoke("session:getPreviewFrame", sessionId),
    onSessionListChanged: (callback) =>
        ipcRenderer.on("session:list-changed", () => callback()),
    onStreamRestarting: (callback) =>
        ipcRenderer.on("stream-restarting", (_event, data) => callback(data)),
    onOrientationChanged: (callback) =>
        ipcRenderer.on("session:orientation-changed", (_event, data) => callback(data)),
    onRestartStreamRequest: (callback) =>
        ipcRenderer.on("session:restart-stream-request", (_event, data) => callback(data)),
    reportRestartStreamResult: (payload) =>
        ipcRenderer.send("session:restart-stream-result", payload)
});

contextBridge.exposeInMainWorld("videoPreviewAPI", {
    show: (payload) => ipcRenderer.invoke("video-preview:show", payload),
    hide: () => ipcRenderer.invoke("video-preview:hide"),
    setPosition: (payload) => ipcRenderer.invoke("video-preview:setPosition", payload),
    setState: (payload) => ipcRenderer.invoke("video-preview:setState", payload),
    setFrame: (payload) => ipcRenderer.invoke("video-preview:setFrame", payload)
});

contextBridge.exposeInMainWorld("namesAPI", {
    renameDevice: (payload) => ipcRenderer.invoke("names:renameDevice", payload),
    resetDevice: (payload) => ipcRenderer.invoke("names:resetDevice", payload),
    renameSession: (payload) => ipcRenderer.invoke("names:renameSession", payload),
    resetSession: (payload) => ipcRenderer.invoke("names:resetSession", payload),
    getDeviceInfo: (payload) => ipcRenderer.invoke("names:getDeviceInfo", payload),
    getSessionInfo: (payload) => ipcRenderer.invoke("names:getSessionInfo", payload),
    openRenameDialog: (payload) => ipcRenderer.invoke("names:openRenameDialog", payload),
    cancelRenameDialog: () => ipcRenderer.invoke("names:cancelRenameDialog"),
    showContextMenu: (payload) => ipcRenderer.invoke("context-menu:show", payload),
    onContextMenuAction: (callback) =>
        ipcRenderer.on("context-menu:action", (_event, data) => callback(data)),
    onUpdated: (callback) => ipcRenderer.on("names:updated", () => callback())
});

contextBridge.exposeInMainWorld("wifiAPI", {
    toggle: (payload) => ipcRenderer.invoke("wifi:toggle", payload),
    getPanelData: () => ipcRenderer.invoke("wifi:panel-data"),
    rename: (payload) => ipcRenderer.invoke("wifi:rename", payload),
    remove: (payload) => ipcRenderer.invoke("wifi:remove", payload),
    removeFromPanel: (payload) => ipcRenderer.invoke("devices:panel-remove", payload),
    reconnect: (payload) => ipcRenderer.invoke("wifi:reconnect", payload),
    resolveSerial: (payload) => ipcRenderer.invoke("device:resolve-serial", payload)
});

contextBridge.exposeInMainWorld("launchHistoryAPI", {
    list: () => ipcRenderer.invoke("launch-history:list"),
    record: (payload) => ipcRenderer.invoke("launch-history:record", payload),
    remove: (payload) => ipcRenderer.invoke("launch-history:remove", payload),
    onUpdated: (callback) => ipcRenderer.on("launch-history:updated", () => callback())
});

contextBridge.exposeInMainWorld("deviceColorsAPI", {
    getPalette: () => ipcRenderer.invoke("device-colors:getPalette"),
    get: (payload) => ipcRenderer.invoke("device-colors:get", payload),
    setManual: (payload) => ipcRenderer.invoke("device-colors:setManual", payload),
    setAuto: (payload) => ipcRenderer.invoke("device-colors:setAuto", payload),
    onUpdated: (callback) => ipcRenderer.on("device-colors:updated", () => callback())
});

contextBridge.exposeInMainWorld("launchLatencyAPI", {
    click: (payload) => ipcRenderer.invoke("launch-latency:click", payload),
    bind: (payload) => ipcRenderer.invoke("launch-latency:bind", payload),
    mark: (payload) => ipcRenderer.invoke("launch-latency:mark", payload)
});

contextBridge.exposeInMainWorld("uiPreferencesAPI", {
    getLocaleData: () => ipcRenderer.invoke("ui:get-locale-data"),
    getLocale: () => ipcRenderer.invoke("ui:get-locale"),
    setLocale: (locale) => ipcRenderer.invoke("ui:set-locale", { locale }),
    getPreferences: () => ipcRenderer.invoke("ui:get-preferences"),
    setSidebarOpen: (sidebarOpen) => ipcRenderer.invoke("ui:set-sidebar-open", { sidebarOpen }),
    onLocaleChanged: (callback) =>
        ipcRenderer.on("ui:locale-changed", (_event, data) => callback(data))
});

contextBridge.exposeInMainWorld("maintenanceAPI", {
    previewCleanup: (payload = {}) => ipcRenderer.invoke("maintenance:cleanup-preview", payload),
    runCleanup: (payload = {}) => ipcRenderer.invoke("maintenance:cleanup-run", payload),
    getPreferences: () => ipcRenderer.invoke("maintenance:get-preferences"),
    setPreferences: (payload = {}) => ipcRenderer.invoke("maintenance:set-preferences", payload)
});

contextBridge.exposeInMainWorld("hubModalAPI", {
    open: (payload) => ipcRenderer.invoke("hub-modal:open", payload),
    close: () => ipcRenderer.invoke("hub-modal:close"),
    isOpen: () => ipcRenderer.invoke("hub-modal:isOpen"),
    onClosed: (callback) => ipcRenderer.on("hub-modal:closed", () => callback())
});

contextBridge.exposeInMainWorld("hubModalWindowAPI", {
    onOpen: (callback) => ipcRenderer.on("hub-modal:open", (_event, payload) => callback(payload)),
    close: () => ipcRenderer.send("hub-modal:close-request"),
    invokeMain: (action, args) => ipcRenderer.invoke("hub-modal:invoke-main", { action, args: args || [] })
});
