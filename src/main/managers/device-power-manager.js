const { exec } = require("child_process");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * Applique stay-awake + extinction écran physique (équivalent scrcpy --stay-awake --turn-screen-off)
 * à chaque appareil nouvellement connecté pendant la session Hub.
 */
class DevicePowerManager {
    constructor(adbPath) {
        this.adbPath = adbPath;
        this.appliedSerials = new Set();
        /** @type {Map<string, Promise<void>>} */
        this.inFlight = new Map();
    }

    async applyStayAwake(serial) {
        if (!serial) return;
        if (this.appliedSerials.has(serial)) return;

        const pending = this.inFlight.get(serial);
        if (pending) return pending;

        const work = (async () => {
            const quoted = adbSerialArg(serial);
            try {
                await execPromise(`"${this.adbPath}" -s ${quoted} shell svc power stayon true`);
            } catch (err) {
                console.warn(`[DevicePower] stayon ${serial}:`, err.message);
            }

            this.appliedSerials.add(serial);
            console.log(`[DevicePower] stay-awake applique a ${serial}`);
        })().finally(() => {
            this.inFlight.delete(serial);
        });

        this.inFlight.set(serial, work);
        return work;
    }

    /** @deprecated alias interne — ecran off reserve au « Lancer instance » */
    async applyStayAwakeAndScreenOff(serial) {
        await this.applyStayAwake(serial);
    }

    syncConnectedDevices(serials = []) {
        const current = new Set(serials.filter(Boolean));

        for (const serial of this.appliedSerials) {
            if (!current.has(serial)) {
                this.appliedSerials.delete(serial);
            }
        }

        const pending = [];
        for (const serial of current) {
            if (!this.appliedSerials.has(serial) && !this.inFlight.has(serial)) {
                pending.push(this.applyStayAwake(serial));
            }
        }

        return Promise.allSettled(pending);
    }
}

module.exports = { DevicePowerManager };
