/**
 * Helpers promisifiés pour child_process.exec (commandes ADB / shell).
 *
 * Destiné au **nouveau code** main process. La migration des copies locales
 * dans les managers existants est **différée** (rapport d'optimisation § 7.1) :
 * variations maxBuffer / trim / libellé timeout — migration au cas par cas si jugée utile.
 *
 * Fichiers LOCK / input non concernés : adb-input-controller.js, new-instance-manager.js
 * conservent leurs implémentations locales.
 */
const { exec } = require("child_process");

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 12000;

/**
 * @param {string} command
 * @param {{ maxBuffer?: number, trim?: boolean }} [options]
 * @returns {Promise<string>}
 */
function execPromise(command, { maxBuffer = DEFAULT_MAX_BUFFER_BYTES, trim = true } = {}) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            if (trim) {
                resolve(String(stdout || "").trim());
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * @param {string} command
 * @param {number} [timeoutMs]
 * @param {{ maxBuffer?: number, trim?: boolean, timeoutLabel?: string|null, timeoutMessage?: string }} [options]
 * @returns {Promise<string>}
 */
function execWithTimeout(
    command,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    options = {}
) {
    const {
        maxBuffer = DEFAULT_MAX_BUFFER_BYTES,
        trim = true,
        timeoutLabel = "ADB",
        timeoutMessage
    } = options;

    const rejectMessage = timeoutMessage
        ?? (timeoutLabel
            ? `Timeout ${timeoutLabel} (${timeoutMs}ms)`
            : `Timeout (${timeoutMs}ms)`);

    return Promise.race([
        execPromise(command, { maxBuffer, trim }),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(rejectMessage)), timeoutMs);
        })
    ]);
}

module.exports = {
    execPromise,
    execWithTimeout,
    DEFAULT_MAX_BUFFER_BYTES,
    DEFAULT_COMMAND_TIMEOUT_MS
};
