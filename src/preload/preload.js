const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    // --- Devices ---
    getDevices: (options) => ipcRenderer.invoke("get-devices", options || {}),
    onDevicesRefreshRequest: (callback) =>
        ipcRenderer.on("devices:refresh-request", () => callback()),
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
    getAppsWithDetails: (serial) => ipcRenderer.invoke("device:apps", serial),
    launchNewInstance: (serial, packageName, userId = null, latencyTraceId = null, stableDeviceId = null, bootstrapNewDisplay = null) =>
        ipcRenderer.invoke("new-instance:launch", {
            serial,
            packageName,
            userId,
            latencyTraceId,
            stableDeviceId,
            bootstrapNewDisplay
        }),

    // --- Nouvelle instance Type B (IPC dedie) ---
    newInstanceCreate: (payload) => ipcRenderer.invoke("new-instance:create", payload),
    newInstanceStart: (payload) => ipcRenderer.invoke("new-instance:start", payload),
    newInstanceStop: (payload) => ipcRenderer.invoke("new-instance:stop", payload),
    forceStopAppOnDevice: (payload) => ipcRenderer.invoke("new-instance:force-stop-app", payload),
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
    setDeviceMuted: (deviceKey, muted) => ipcRenderer.invoke("audio:setDeviceMuted", { deviceKey, muted }),
    toggleDeviceMuted: (deviceKey) => ipcRenderer.invoke("audio:toggleDeviceMuted", { deviceKey }),
    onGlobalStateChanged: (callback) =>
        ipcRenderer.on("audio:global-state-changed", (_event, data) => callback(data))
});

/** Haut-parleur appareil (ADB) — ne contrôle pas l'audio PC Hub. */
contextBridge.exposeInMainWorld("deviceSpeakerAPI", {
    getState: (hint = {}) => ipcRenderer.invoke("deviceSpeaker:getState", hint),
    setVolume: (payload = {}) => ipcRenderer.invoke("deviceSpeaker:setVolume", payload),
    onStateChanged: (callback) =>
        ipcRenderer.on("deviceSpeaker:state-changed", (_event, data) => callback(data))
});

contextBridge.exposeInMainWorld("deviceSpeakerOverlayAPI", {
    show: (payload = {}) => ipcRenderer.invoke("deviceSpeakerOverlay:show", payload),
    hide: () => ipcRenderer.invoke("deviceSpeakerOverlay:hide"),
    toggleGlobalAudio: () => ipcRenderer.invoke("deviceSpeakerOverlay:toggleGlobalAudio"),
    toggleDeviceAudio: (payload = {}) => ipcRenderer.invoke("deviceSpeakerOverlay:toggleDeviceAudio", payload)
});

contextBridge.exposeInMainWorld("screenPowerOverlayAPI", {
    show: (payload = {}) => ipcRenderer.invoke("screenPowerOverlay:show", payload),
    hide: () => ipcRenderer.invoke("screenPowerOverlay:hide")
});

contextBridge.exposeInMainWorld("sessionAPI", {
    switchTo: (sessionId) => ipcRenderer.invoke("session:switchTo", sessionId),
    cycleTab: (direction) => ipcRenderer.invoke("session:cycleTab", { direction }),
    close: (sessionId) => ipcRenderer.invoke("session:close", sessionId),
    reorder: (orderedIds) => ipcRenderer.invoke("session:reorder", orderedIds),
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
    setLayoutMode: (mode) => ipcRenderer.invoke("session:setLayoutMode", { mode }),
    setLayoutBounds: (boundsMap) => ipcRenderer.invoke("session:setLayoutBounds", { boundsMap }),
    suppressView: () => ipcRenderer.invoke("session:suppressView"),
    restoreView: () => ipcRenderer.invoke("session:restoreView"),
    setUiBrightness: (brightness) => ipcRenderer.invoke("session:setUiBrightness", { brightness }),
    getActiveTypeA: () => ipcRenderer.invoke("session:getActiveTypeA"),
    getScreenToggleState: (hint = {}) => ipcRenderer.invoke("session:getScreenToggleState", hint),
    toggleScreen: (sessionIdOrPayload) => ipcRenderer.invoke("session:toggleScreen", sessionIdOrPayload),
    toggleScreenGlobal: () => ipcRenderer.invoke("session:toggleScreenGlobal"),
    getScreenPowerPanel: () => ipcRenderer.invoke("session:getScreenPowerPanel"),
    setScreenPower: (payload = {}) => ipcRenderer.invoke("session:setScreenPower", payload),
    onScreenPowerChanged: (callback) =>
        ipcRenderer.on("session:screen-power-changed", (_event, data) => callback(data)),
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
    onStreamRestarting: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on("stream-restarting", handler);
        return () => ipcRenderer.removeListener("stream-restarting", handler);
    },
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

contextBridge.exposeInMainWorld("dockHoverAPI", {
    show: (payload) => ipcRenderer.invoke("dock-hover:show", payload),
    hide: () => ipcRenderer.invoke("dock-hover:hide")
});

contextBridge.exposeInMainWorld("hubBubbleAPI", {
    showToast: (payload) => ipcRenderer.invoke("hub-bubble:show-toast", payload),
    showTip: (payload) => ipcRenderer.invoke("hub-bubble:show-tip", payload),
    hide: () => ipcRenderer.invoke("hub-bubble:hide")
});

contextBridge.exposeInMainWorld("dockChipFlyoutAPI", {
    show: (payload) => ipcRenderer.invoke("dock-chip-flyout:show", payload),
    update: (payload) => ipcRenderer.invoke("dock-chip-flyout:update", payload),
    hide: () => ipcRenderer.invoke("dock-chip-flyout:hide")
});

contextBridge.exposeInMainWorld("wifiReconnectOverlayAPI", {
    show: (payload) => ipcRenderer.invoke("wifi-reconnect-overlay:show", payload),
    update: (payload) => ipcRenderer.invoke("wifi-reconnect-overlay:update", payload),
    hide: () => ipcRenderer.invoke("wifi-reconnect-overlay:hide"),
    isOpen: () => ipcRenderer.invoke("wifi-reconnect-overlay:is-open")
});

contextBridge.exposeInMainWorld("namesAPI", {
    renameDevice: (payload) => ipcRenderer.invoke("names:renameDevice", payload),
    resetDevice: (payload) => ipcRenderer.invoke("names:resetDevice", payload),
    renameSession: (payload) => ipcRenderer.invoke("names:renameSession", payload),
    resetSession: (payload) => ipcRenderer.invoke("names:resetSession", payload),
    getDeviceInfo: (payload) => ipcRenderer.invoke("names:getDeviceInfo", payload),
    getSessionInfo: (payload) => ipcRenderer.invoke("names:getSessionInfo", payload),
    resolveInstanceAppNames: (items) => ipcRenderer.invoke("names:resolveInstanceAppNames", items),
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
    resolveSerial: (payload) => ipcRenderer.invoke("device:resolve-serial", payload),
    discoverDevices: () => ipcRenderer.invoke("devices:discover"),
    onTransportReattachState: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on("transport:reattach-state", handler);
        return () => ipcRenderer.removeListener("transport:reattach-state", handler);
    },
    onUsbUnplugged: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on("transport:usb-unplugged", handler);
        return () => ipcRenderer.removeListener("transport:usb-unplugged", handler);
    },
    onUsbRegained: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on("transport:usb-regained", handler);
        return () => ipcRenderer.removeListener("transport:usb-regained", handler);
    },
    onUsbReplugChoice: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on("transport:usb-replug-choice", handler);
        return () => ipcRenderer.removeListener("transport:usb-replug-choice", handler);
    },
    continueOnWifi: (payload) => ipcRenderer.invoke("wifi:continue-on-wifi", payload),
    playOnDevice: (payload) => ipcRenderer.invoke("wifi:play-on-device", payload),
    stayOnWifi: (payload) => ipcRenderer.invoke("wifi:stay-on-wifi", payload),
    switchToUsb: (payload) => ipcRenderer.invoke("wifi:switch-to-usb", payload)
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

contextBridge.exposeInMainWorld("displayPresetsAPI", {
    list: () => ipcRenderer.invoke("display-presets:list"),
    getDefault: (transport = "usb") => ipcRenderer.invoke("display-presets:get-default", { transport }),
    resolveParams: (presetId) => ipcRenderer.invoke("display-presets:resolve-params", { presetId }),
    getAllowedOptions: () => ipcRenderer.invoke("display-presets:get-allowed-options"),
    save: (payload) => ipcRenderer.invoke("display-presets:save", payload),
    setDefault: (presetId, transport = "usb") =>
        ipcRenderer.invoke("display-presets:set-default", { presetId, transport }),
    updateDefaultFromParams: (params, transport = "usb") =>
        ipcRenderer.invoke("display-presets:update-default-from-params", { params, transport }),
    delete: (presetId) => ipcRenderer.invoke("display-presets:delete", { presetId }),
    resetTransportToFactory: (transport = "usb") =>
        ipcRenderer.invoke("display-presets:reset-transport-factory", { transport }),
    onUpdated: (callback) => ipcRenderer.on("display-presets:updated", () => callback())
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
    getPerformancePrefs: () => ipcRenderer.invoke("ui:get-performance-prefs"),
    setPerformancePrefs: (payload) => ipcRenderer.invoke("ui:set-performance-prefs", payload),
    getDeviceScreenPowerPrefs: () => ipcRenderer.invoke("ui:get-device-screen-power-prefs"),
    setRememberScreenAcrossDisconnect: (enabled) =>
        ipcRenderer.invoke("ui:set-remember-screen-across-disconnect", { enabled: Boolean(enabled) }),
    getClipboardAutosync: () => ipcRenderer.invoke("ui:get-clipboard-autosync"),
    setClipboardAutosync: (enabled) =>
        ipcRenderer.invoke("ui:set-clipboard-autosync", { enabled: Boolean(enabled) }),
    onClipboardAutosyncChanged: (callback) =>
        ipcRenderer.on("ui:clipboard-autosync-changed", (_event, data) => callback(data)),
    setSidebarOpen: (sidebarOpen) => ipcRenderer.invoke("ui:set-sidebar-open", { sidebarOpen }),
    setDisplayPreferences: (payload) => ipcRenderer.invoke("ui:set-display-preferences", payload),
    getHubWallpaper: () => ipcRenderer.invoke("ui:get-hub-wallpaper"),
    pickHubWallpaper: () => ipcRenderer.invoke("ui:pick-hub-wallpaper"),
    clearHubWallpaper: () => ipcRenderer.invoke("ui:clear-hub-wallpaper"),
    onLocaleChanged: (callback) =>
        ipcRenderer.on("ui:locale-changed", (_event, data) => callback(data)),
    onWallpaperChanged: (callback) =>
        ipcRenderer.on("ui:wallpaper-changed", (_event, data) => callback(data)),
    onPerformanceChanged: (callback) =>
        ipcRenderer.on("ui:performance-changed", (_event, data) => callback(data))
});

contextBridge.exposeInMainWorld("deviceFsAPI", {
    shortcuts: () => ipcRenderer.invoke("device-fs:shortcuts"),
    list: (payload) => ipcRenderer.invoke("device-fs:list", payload),
    mkdir: (payload) => ipcRenderer.invoke("device-fs:mkdir", payload),
    remove: (payload) => ipcRenderer.invoke("device-fs:remove", payload),
    preview: (payload) => ipcRenderer.invoke("device-fs:preview", payload),
    openLocal: (payload) => ipcRenderer.invoke("device-fs:open-local", payload),
    pickAndPush: (payload) => ipcRenderer.invoke("device-fs:pick-and-push", payload),
    pushPaths: (payload) => ipcRenderer.invoke("device-fs:push-paths", payload),
    pull: (payload) => ipcRenderer.invoke("device-fs:pull", payload),
    openExplorer: (payload) => ipcRenderer.invoke("device-fs:open-explorer", payload),
    onProgress: (callback) =>
        ipcRenderer.on("device-fs:progress", (_event, data) => callback(data)),
    onToast: (callback) =>
        ipcRenderer.on("device-fs:toast", (_event, data) => callback(data))
});

contextBridge.exposeInMainWorld("maintenanceAPI", {
    previewCleanup: (payload = {}) => ipcRenderer.invoke("maintenance:cleanup-preview", payload),
    runCleanup: (payload = {}) => ipcRenderer.invoke("maintenance:cleanup-run", payload),
    getPreferences: () => ipcRenderer.invoke("maintenance:get-preferences"),
    setPreferences: (payload = {}) => ipcRenderer.invoke("maintenance:set-preferences", payload)
});

contextBridge.exposeInMainWorld("duoPopupAPI", {
    open: (payload) => ipcRenderer.invoke("duo-popup:open", payload),
    update: (payload) => ipcRenderer.invoke("duo-popup:update", payload),
    hide: () => ipcRenderer.invoke("duo-popup:hide"),
    onSlotsChanged: (callback) =>
        ipcRenderer.on("duo-popup:slots-changed", (_event, data) => callback(data)),
    onClosed: (callback) => ipcRenderer.on("duo-popup:closed", () => callback())
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

contextBridge.exposeInMainWorld("hubLogAPI", {
    list: () => ipcRenderer.invoke("hub-log:list"),
    clear: () => ipcRenderer.invoke("hub-log:clear"),
    append: (payload) => ipcRenderer.send("hub-log:append", payload || {}),
    onEntry: (callback) => ipcRenderer.on("hub-log:entry", (_event, data) => callback(data))
});
