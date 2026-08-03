/**
 * État audio PC :
 * - globalMuted : interrupteur maître (OFF = silence total)
 * - deviceMuted : OFF/ON par appareil (deviceKey = stableDeviceId || serial)
 *   défaut si absent de la map = ON (autorisé) dès que le maître est ON
 */
class GlobalAudioOutputManager {
    constructor() {
        /** @type {boolean} true = son PC coupé (OFF) */
        this.globalMuted = true;
        /** @type {Map<string, boolean>} deviceKey → true = muet */
        this.deviceMuted = new Map();
        /** @type {((muted: boolean) => Promise<void>)|null} */
        this._onMuteStateChanged = null;
        /** @type {((deviceKey: string, muted: boolean) => Promise<void>)|null} */
        this._onDeviceMuteChanged = null;
    }

    isGlobalMuted() {
        return this.globalMuted;
    }

    /**
     * @param {string} deviceKey
     * @returns {boolean} true si le son PC est autorisé pour cet appareil
     */
    isDeviceAudioEnabled(deviceKey) {
        if (this.globalMuted) return false;
        if (!deviceKey) return true;
        if (this.deviceMuted.get(deviceKey) === true) return false;
        return true;
    }

    /**
     * true si le device est considéré muet (maître OFF inclus).
     * Accepte une clé unique ; le rendu UI peut croiser deviceId + serial.
     */
    isDeviceMuted(deviceKey) {
        if (!deviceKey) return true;
        if (this.globalMuted) return true;
        return this.deviceMuted.get(deviceKey) === true;
    }

    getState() {
        const devices = {};
        for (const [key, muted] of this.deviceMuted.entries()) {
            devices[key] = { muted: Boolean(muted) };
        }
        return {
            globalMuted: this.globalMuted,
            devices
        };
    }

    setOnMuteStateChanged(fn) {
        this._onMuteStateChanged = typeof fn === "function" ? fn : null;
    }

    setOnDeviceMuteChanged(fn) {
        this._onDeviceMuteChanged = typeof fn === "function" ? fn : null;
    }

    applyDisplayBootstrapScrcpyArgs(args) {
        const next = args.filter((arg) => arg !== "--no-audio" && arg !== "--no-playback");
        next.push("--no-audio", "--no-playback");
        return next;
    }

    applyScrcpyCliArgs(args) {
        const next = args.filter((arg) => arg !== "--no-audio");
        if (this.globalMuted) {
            next.push("--no-audio");
        }
        return next;
    }

    applySocketScrcpyOptions(options = {}) {
        const next = { ...options };
        next.audio = false;
        return next;
    }

    async setGlobalMuted(muted, options = {}) {
        const nextMuted = Boolean(muted);
        const changed = nextMuted !== this.globalMuted;
        this.globalMuted = nextMuted;

        if (changed && this._onMuteStateChanged) {
            await this._onMuteStateChanged(this.globalMuted, options);
        }

        return this.getState();
    }

    async toggleGlobalMuted() {
        return this.setGlobalMuted(!this.globalMuted);
    }

    /**
     * Mute/unmute PC audio pour un appareil physique.
     * Si on active un device alors que le maître est OFF → le maître passe ON
     * (sync global qui respecte déjà le mute par device).
     * @param {string} deviceKey
     * @param {boolean} muted
     * @param {{ aliasKeys?: string[] }} [options]
     */
    async setDeviceMuted(deviceKey, muted, options = {}) {
        const key = typeof deviceKey === "string" ? deviceKey.trim() : "";
        if (!key) {
            return { ...this.getState(), success: false, error: "deviceKey manquant" };
        }

        const nextMuted = Boolean(muted);
        const aliases = [
            key,
            ...((Array.isArray(options.aliasKeys) ? options.aliasKeys : [])
                .map((k) => String(k || "").trim())
                .filter(Boolean))
        ];
        for (const alias of [...new Set(aliases)]) {
            this.deviceMuted.set(alias, nextMuted);
        }

        // Unmute device alors que le maître est OFF → maître ON (PC),
        // sans restore HP de tous les devices (seul ce device sera rétabli par l'appelant).
        if (!nextMuted && this.globalMuted) {
            this.globalMuted = false;
            if (this._onMuteStateChanged) {
                await this._onMuteStateChanged(false, { skipSpeakerRestore: true });
            }
        }

        if (this._onDeviceMuteChanged) {
            await this._onDeviceMuteChanged(key, nextMuted);
        }

        return { ...this.getState(), success: true, deviceKey: key };
    }

    async toggleDeviceMuted(deviceKey) {
        const key = typeof deviceKey === "string" ? deviceKey.trim() : "";
        if (!key) {
            return { ...this.getState(), success: false, error: "deviceKey manquant" };
        }
        const currentlyMuted = this.isDeviceMuted(key);
        return this.setDeviceMuted(key, !currentlyMuted);
    }
}

module.exports = { GlobalAudioOutputManager };
