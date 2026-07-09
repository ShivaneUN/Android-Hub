const path = require("path");
const { pathToFileURL } = require("url");

const HUB_ICON_SCHEME = "hub-icon";

function toAppIconUrl(iconPath) {
    if (!iconPath || typeof iconPath !== "string") return null;

    try {
        const resolved = path.resolve(iconPath);
        return `${HUB_ICON_SCHEME}://cache/${encodeURIComponent(resolved)}`;
    } catch (_err) {
        return null;
    }
}

function toLegacyFileIconUrl(iconPath) {
    if (!iconPath) return null;
    try {
        return pathToFileURL(iconPath).href;
    } catch (_err) {
        return null;
    }
}

function parseAppIconFilePath(requestUrl, iconsRoot) {
    if (!requestUrl || !iconsRoot) return null;

    const url = new URL(requestUrl);
    if (url.protocol !== `${HUB_ICON_SCHEME}:` || url.hostname !== "cache") {
        return null;
    }

    const encoded = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    const filePath = path.normalize(decodeURIComponent(encoded));
    const root = path.normalize(iconsRoot);

    if (!filePath.toLowerCase().startsWith(root.toLowerCase())) {
        return null;
    }

    return filePath;
}

const appIconUrlApi = {
    HUB_ICON_SCHEME,
    toAppIconUrl,
    toLegacyFileIconUrl,
    parseAppIconFilePath
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = appIconUrlApi;
} else {
    globalThis.HubAppIconUrl = appIconUrlApi;
}
