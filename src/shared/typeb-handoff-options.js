/**
 * Options scrcpy pour handoff Type B USB↔WiFi (même logique dans les 2 sens).
 */
const { DEFAULT_STREAM_PARAMS, toScrcpyOptions, parseNewDisplay } = require("./stream-params");

/**
 * Construit les options scrcpy pour un handoff / migrate Type B.
 * - Si un displayId live existe : s'y rattacher (pas de new_display / start_app → pas de letterbox).
 * - Sinon : new_display figé + captureOrientationLock=null.
 *
 * @param {object|null} session
 * @param {object} [overrides]
 */
function buildTypeBHandoffScrcpyOptions(session = null, overrides = {}) {
    const fromSession = session?.streamOptions || {};
    const preferred = session?.preferredNewDisplay
        || fromSession.newDisplay
        || toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay;

    const liveDisplayId = Number.isInteger(session?.displayId)
        ? session.displayId
        : (Number.isInteger(session?.presetDisplayId) ? session.presetDisplayId : null);

    const startOptions = {
        ...fromSession,
        ...overrides,
        vdDestroyContent: overrides.vdDestroyContent !== true
            && fromSession.vdDestroyContent !== true
            ? false
            : true
    };

    delete startOptions.flexDisplay;
    delete startOptions.vdSystemDecorations;
    delete startOptions.serverJarPath;
    delete startOptions.orientation;
    // Empêche le recalcul @270 dans ScrcpySocketClient.
    startOptions.captureOrientationLock = null;

    // Préférer rattacher au VD existant (bootstrap externe encore vivant).
    if (Number.isInteger(liveDisplayId) && overrides.forceNewDisplay !== true) {
        startOptions.displayId = liveDisplayId;
        delete startOptions.newDisplay;
        return startOptions;
    }

    let newDisplay = preferred;
    const parsedPref = parseNewDisplay(preferred);
    const live = session?.streamSize;

    // Aligner sur streamSize seulement s'il a le même sens paysage/portrait que le display config.
    if (
        live?.width > 0
        && live?.height > 0
        && parsedPref?.width > 0
        && parsedPref?.height > 0
        && (parsedPref.width >= parsedPref.height) === (live.width >= live.height)
    ) {
        newDisplay = preferred;
    }

    startOptions.newDisplay = newDisplay;
    delete startOptions.displayId;

    return startOptions;
}

module.exports = {
    buildTypeBHandoffScrcpyOptions
};
