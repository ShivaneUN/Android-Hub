const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("duoPopupOverlayAPI", {
    onOpen: (callback) => {
        ipcRenderer.on("duo-popup:open", (_event, payload) => callback(payload));
    },
    notifySlotsChange: (slots) => ipcRenderer.send("duo-popup:slots-changed", slots),
    requestClose: () => ipcRenderer.send("duo-popup:close-request")
});

contextBridge.exposeInMainWorld("uiPreferencesAPI", {
    getLocaleData: () => ipcRenderer.invoke("ui:get-locale-data"),
    getLocale: () => ipcRenderer.invoke("ui:get-locale"),
    setLocale: (locale) => ipcRenderer.invoke("ui:set-locale", { locale }),
    onLocaleChanged: (callback) =>
        ipcRenderer.on("ui:locale-changed", (_event, data) => callback(data))
});
