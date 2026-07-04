const APP_NAME = "Android Hub";

function setWindowTitle() {
    document.title = APP_NAME;
    const el = document.querySelector(".titlebar-title");
    if (el) el.textContent = APP_NAME;
}

const api = { APP_NAME, setWindowTitle };

if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
} else {
    globalThis.AppName = api;
}
