module.exports = (ipcMain) => {
  ipcMain.on("get-settings", (event) => {
    event.reply("settings-data", {
      theme: "dark",
      lang: "fr"
    });
  });

  ipcMain.on("save-settings", (event, data) => {
    console.log("settings saved", data);
  });
};