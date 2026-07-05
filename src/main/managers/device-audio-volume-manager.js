const { exec } = require("child_process");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

const STREAM_MUSIC = 3;

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

function parseVolumeFromOutput(output) {
    const text = String(output || "").trim();
    if (!text) return null;

    const volumeMatch = text.match(/volume is\s*(\d+)/i);
    if (volumeMatch) return Number(volumeMatch[1]);

    const trailingNumber = text.match(/(\d+)\s*$/);
    if (trailingNumber) return Number(trailingNumber[1]);

    const anyNumber = text.match(/(\d+)/);
    return anyNumber ? Number(anyNumber[1]) : null;
}

/**
 * Mute / unmute STREAM_MUSIC sur l'appareil Android via ADB (haut-parleur device).
 */
class DeviceAudioVolumeManager {
    constructor(adbPath) {
        this.adbPath = adbPath;
        /** @type {Map<string, number>} volume média sauvegardé avant mute global */
        this.savedVolumeBySerial = new Map();
    }

    async _runShell(serial, shellCommand) {
        if (!serial || !this.adbPath) {
            throw new Error("ADB ou serial manquant");
        }
        return execPromise(`"${this.adbPath}" -s ${adbSerialArg(serial)} shell ${shellCommand}`);
    }

    async _getMediaVolume(serial) {
        const commands = [
            `media volume --stream ${STREAM_MUSIC} --get`,
            `cmd media_session volume --stream ${STREAM_MUSIC} --get`
        ];

        for (const command of commands) {
            try {
                const output = await this._runShell(serial, command);
                const volume = parseVolumeFromOutput(output);
                if (Number.isInteger(volume) && volume >= 0) {
                    return volume;
                }
            } catch (_err) {
                /* essai commande suivante */
            }
        }

        return null;
    }

    async _setMediaVolume(serial, level) {
        const volume = Math.max(0, Math.round(level));
        const commands = [
            `media volume --stream ${STREAM_MUSIC} --set ${volume}`,
            `cmd media_session volume --stream ${STREAM_MUSIC} --set ${volume}`
        ];

        for (const command of commands) {
            try {
                await this._runShell(serial, command);
                return true;
            } catch (_err) {
                /* essai commande suivante */
            }
        }

        return false;
    }

    /**
     * Sauvegarde le volume actuel puis met STREAM_MUSIC à 0.
     * @param {string} serial
     */
    async muteSerial(serial) {
        if (!serial) return;

        try {
            if (!this.savedVolumeBySerial.has(serial)) {
                const current = await this._getMediaVolume(serial);
                if (Number.isInteger(current) && current >= 0) {
                    this.savedVolumeBySerial.set(serial, current);
                }
            }

            const saved = await this._setMediaVolume(serial, 0);
            if (saved) {
                console.log(`[DeviceAudio] Volume média coupé sur ${serial} (restaurable=${this.savedVolumeBySerial.has(serial)})`);
            }
        } catch (err) {
            console.warn(`[DeviceAudio] Impossible de couper le volume sur ${serial}:`, err.message);
        }
    }

    /**
     * Restaure le volume média sauvegardé pour ce serial.
     * @param {string} serial
     */
    async restoreSerial(serial) {
        if (!serial) return;

        const saved = this.savedVolumeBySerial.get(serial);
        if (!Number.isInteger(saved)) {
            return;
        }

        try {
            const restored = await this._setMediaVolume(serial, saved);
            if (restored) {
                console.log(`[DeviceAudio] Volume média restauré sur ${serial} → ${saved}`);
            }
        } catch (err) {
            console.warn(`[DeviceAudio] Impossible de restaurer le volume sur ${serial}:`, err.message);
        } finally {
            this.savedVolumeBySerial.delete(serial);
        }
    }

    async applyMuteToSerials(serials = []) {
        const unique = [...new Set(serials.filter(Boolean))];
        await Promise.allSettled(unique.map((serial) => this.muteSerial(serial)));
    }

    async restoreAllSaved() {
        const serials = [...this.savedVolumeBySerial.keys()];
        await Promise.allSettled(serials.map((serial) => this.restoreSerial(serial)));
    }
}

module.exports = { DeviceAudioVolumeManager };
