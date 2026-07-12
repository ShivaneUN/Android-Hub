const pkg = require("./package.json");
const { resolveBuildOutputDir } = require("./scripts/build-output-dir");

/** @type {import('electron-builder').Configuration} */
module.exports = {
    ...pkg.build,
    directories: {
        ...pkg.build.directories,
        output: resolveBuildOutputDir(pkg.build.directories?.output || "dist")
    }
};
