const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("renameDialogAPI", {
    onOpen: (callback) => {
        ipcRenderer.on("rename-dialog:open", (_event, payload) => callback(payload));
    },
    submit: (name) => ipcRenderer.invoke("names:submitRenameDialog", { name }),
    cancel: () => ipcRenderer.invoke("names:cancelRenameDialog")
});

contextBridge.exposeInMainWorld("uiPreferencesAPI", {
    getLocaleData: () => ipcRenderer.invoke("ui:get-locale-data"),
    getLocale: () => ipcRenderer.invoke("ui:get-locale"),
    setLocale: (locale) => ipcRenderer.invoke("ui:set-locale", { locale }),
    onLocaleChanged: (callback) =>
        ipcRenderer.on("ui:locale-changed", (_event, data) => callback(data))
});
