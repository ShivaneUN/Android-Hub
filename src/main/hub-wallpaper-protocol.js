const fs = require("fs");
const path = require("path");
const { protocol, net } = require("electron");
const { pathToFileURL } = require("url");

const SCHEME = "hub-wallpaper";

function registerHubWallpaperProtocolSchemes() {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                corsEnabled: true,
                stream: true
            }
        }
    ]);
}

function setupHubWallpaperProtocol(getWallpaperPath) {
    protocol.handle(SCHEME, async () => {
        try {
            const filePath = typeof getWallpaperPath === "function" ? getWallpaperPath() : null;
            if (!filePath || !fs.existsSync(filePath)) {
                return new Response(null, { status: 404 });
            }
            return net.fetch(pathToFileURL(filePath).href);
        } catch (err) {
            console.warn("[HubWallpaperProtocol]", err.message);
            return new Response(null, { status: 500 });
        }
    });
}

function wallpaperUrl(revision = Date.now()) {
    return `${SCHEME}://current/?v=${encodeURIComponent(String(revision))}`;
}

module.exports = {
    SCHEME,
    registerHubWallpaperProtocolSchemes,
    setupHubWallpaperProtocol,
    wallpaperUrl
};
