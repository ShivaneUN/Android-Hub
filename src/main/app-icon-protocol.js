const fs = require("fs");
const path = require("path");
const { protocol, net } = require("electron");
const { pathToFileURL } = require("url");
const { parseAppIconFilePath } = require("../shared/app-icon-url");

function registerAppIconProtocolSchemes() {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: "hub-icon",
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

function setupAppIconProtocol(userDataPath) {
    const iconsRoot = path.join(userDataPath, "app-icons");

    protocol.handle("hub-icon", async (request) => {
        try {
            const filePath = parseAppIconFilePath(request.url, iconsRoot);
            if (!filePath || !fs.existsSync(filePath)) {
                return new Response(null, { status: 404 });
            }

            return net.fetch(pathToFileURL(filePath).href);
        } catch (err) {
            console.warn("[AppIconProtocol]", err.message);
            return new Response(null, { status: 500 });
        }
    });
}

module.exports = {
    registerAppIconProtocolSchemes,
    setupAppIconProtocol
};
