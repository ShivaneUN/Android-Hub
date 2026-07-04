const pkg = require("./package.json");

/** @type {import('electron-builder').Configuration} */
module.exports = {
    ...pkg.build
};
