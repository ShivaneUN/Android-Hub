const base = require("./electron-builder.config.js");

/** Config electron-builder avec publication GitHub (build:release uniquement). */
/** @type {import('electron-builder').Configuration} */
module.exports = {
    ...base,
    publish: [
        {
            provider: "github",
            owner: "ShivaneUN",
            repo: "Android-Hub",
            private: true,
            releaseType: "release",
            publishAutoUpdate: true
        }
    ]
};
