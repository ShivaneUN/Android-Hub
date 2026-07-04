const { exec } = require("child_process");

function shellQuote(value) {
    if (value == null) return '""';
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

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
    }

    async applyStayAwake(serial) {
        if (!serial) return;

        const quoted = shellQuote(serial);

        try {
            await execPromise(`"${this.adbPath}" -s ${quoted} shell svc power stayon true`);
        } catch (err) {
            console.warn(`[DevicePower] stayon ${serial}:`, err.message);
        }

        this.appliedSerials.add(serial);
        console.log(`[DevicePower] stay-awake applique a ${serial}`);
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
            if (!this.appliedSerials.has(serial)) {
                pending.push(this.applyStayAwake(serial));
            }
        }

        return Promise.allSettled(pending);
    }
}

module.exports = { DevicePowerManager };
