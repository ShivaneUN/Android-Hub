const { exec } = require("child_process");
const { normalizeOrientation, ORIENTATION_PORTRAIT } = require("../../shared/stream-params");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * Rotation physique de l'écran Android via ADB (user_rotation).
 */
class DeviceOrientationManager {
    constructor(adbPath) {
        this.adbPath = adbPath;
        /** @type {Map<string, { userRotation: number, accelerometerRotation: number }>} */
        this.savedStateBySerial = new Map();
    }

    async _runShell(serial, shellCommand) {
        if (!serial || !this.adbPath) {
            throw new Error("ADB ou serial manquant");
        }
        return execPromise(`"${this.adbPath}" -s ${adbSerialArg(serial)} shell ${shellCommand}`);
    }

    async _readSetting(serial, key) {
        try {
            const out = await this._runShell(serial, `settings get system ${key}`);
            const trimmed = String(out).trim();
            if (!trimmed || trimmed === "null") return null;
            const value = Number(trimmed);
            return Number.isFinite(value) ? value : null;
        } catch (_err) {
            return null;
        }
    }

    async getDeviceDimensions(serial) {
        try {
            const out = await this._runShell(serial, "wm size");
            const physical = String(out).match(/Physical size:\s*(\d+)x(\d+)/i);
            if (physical) {
                return { width: Number(physical[1]), height: Number(physical[2]) };
            }
            const override = String(out).match(/Override size:\s*(\d+)x(\d+)/i);
            if (override) {
                return { width: Number(override[1]), height: Number(override[2]) };
            }
            return null;
        } catch (_err) {
            return null;
        }
    }

    async _saveOriginalState(serial) {
        if (this.savedStateBySerial.has(serial)) return;

        const userRotation = await this._readSetting(serial, "user_rotation");
        const accelerometerRotation = await this._readSetting(serial, "accelerometer_rotation");

        this.savedStateBySerial.set(serial, {
            userRotation: Number.isInteger(userRotation) ? userRotation : 0,
            accelerometerRotation: accelerometerRotation === 1 ? 1 : 0
        });
    }

    /**
     * user_rotation Android (0–3), relatif à l'orientation naturelle de l'appareil.
     */
    resolveUserRotation(orientation, deviceWidth, deviceHeight) {
        const portrait = normalizeOrientation(orientation) === ORIENTATION_PORTRAIT;
        const naturalLandscape = deviceWidth > 0 && deviceHeight > 0
            ? deviceWidth >= deviceHeight
            : false;

        if (naturalLandscape) {
            return portrait ? 1 : 0;
        }
        return portrait ? 0 : 1;
    }

    async applyOrientation(serial, orientation, deviceDims = null) {
        if (!serial) {
            return { success: false, error: "Aucun appareil associé" };
        }

        const dims = deviceDims || await this.getDeviceDimensions(serial);
        const targetRotation = this.resolveUserRotation(
            orientation,
            dims?.width,
            dims?.height
        );

        await this._saveOriginalState(serial);

        try {
            await this._runShell(serial, "settings put system accelerometer_rotation 0");
            await this._runShell(serial, `settings put system user_rotation ${targetRotation}`);

            try {
                await this._runShell(serial, `cmd window set-user-rotation lock ${targetRotation}`);
            } catch (_err) {
                // Android < 11 ou ROM sans cmd window
            }

            console.log(
                `[DeviceOrientation] ${serial} → user_rotation=${targetRotation} (${orientation})`
            );

            return {
                success: true,
                userRotation: targetRotation,
                physical: true
            };
        } catch (err) {
            console.warn(`[DeviceOrientation] Echec ${serial}:`, err.message);
            return { success: false, error: err.message, physical: false };
        }
    }

    async restoreSavedOrientation(serial) {
        if (!serial) return { success: false, error: "Aucun appareil" };

        const saved = this.savedStateBySerial.get(serial);
        if (!saved) {
            return this.applyOrientation(serial, "landscape");
        }

        try {
            await this._runShell(serial, `settings put system user_rotation ${saved.userRotation}`);
            await this._runShell(
                serial,
                `settings put system accelerometer_rotation ${saved.accelerometerRotation}`
            );
            this.savedStateBySerial.delete(serial);
            return { success: true, restored: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    clearSavedState(serial) {
        if (serial) this.savedStateBySerial.delete(serial);
    }
}

module.exports = { DeviceOrientationManager };
