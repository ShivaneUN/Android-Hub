const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("renameDialogAPI", {
    onOpen: (callback) => {
        ipcRenderer.on("rename-dialog:open", (_event, payload) => callback(payload));
    },
    submit: (name) => ipcRenderer.invoke("names:submitRenameDialog", { name }),
    cancel: () => ipcRenderer.invoke("names:cancelRenameDialog")
});
