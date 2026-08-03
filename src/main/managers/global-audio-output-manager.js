/**
 * État audio PC (principe screen OFF) :
 * - globalMuted : maître — OFF = tous OFF, ON = tous ON
 * - deviceMuted : overrides par device, seulement après interaction locale
 * - Un nouveau global efface les overrides (reprend le dessus)
 */
class GlobalAudioOutputManager {
    constructor() {
        /** @type {boolean} true = son PC coupé (OFF) */
        this.globalMuted = true;
        /** @type {Map<string, boolean>} deviceKey → true = muet (override local) */
        this.deviceMuted = new Map();
        /** @type {((muted: boolean, options?: object) => Promise<void>)|null} */
        this._onMuteStateChanged = null;
        /** @type {((deviceKey: string, muted: boolean, meta?: object) => Promise<void>)|null} */
        this._onDeviceMuteChanged = null;
    }

    isGlobalMuted() {
        return this.globalMuted;
    }

    /** Efface les overrides locaux — tout le monde suit le maître. */
    clearAllDeviceMutes() {
        this.deviceMuted.clear();
    }

    /**
     * @param {string} deviceKey
     * @param {string[]} [aliasKeys]
     * @returns {boolean} true si le son PC est autorisé pour cet appareil
     */
    isDeviceAudioEnabled(deviceKey, aliasKeys = []) {
        return !this.isDeviceMuted(deviceKey, aliasKeys);
    }

    /**
     * true si muet (maître OFF inclus, ou override local OFF).
     */
    isDeviceMuted(deviceKey, aliasKeys = []) {
        if (this.globalMuted) return true;
        const keys = [deviceKey, ...(Array.isArray(aliasKeys) ? aliasKeys : [])]
            .map((k) => String(k || "").trim())
            .filter(Boolean);
        if (!keys.length) return true;
        for (const key of keys) {
            if (this.deviceMuted.get(key) === true) return true;
        }
        return false;
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

    /**
     * Maître global. resetDevices (défaut true) : efface les overrides per-device
     * pour que le global reprenne le dessus partout.
     */
    async setGlobalMuted(muted, options = {}) {
        const nextMuted = Boolean(muted);
        const changed = nextMuted !== this.globalMuted;
        this.globalMuted = nextMuted;

        if (options.resetDevices !== false) {
            this.clearAllDeviceMutes();
        }

        if (changed && this._onMuteStateChanged) {
            await this._onMuteStateChanged(this.globalMuted, options);
        }

        return this.getState();
    }

    async toggleGlobalMuted() {
        return this.setGlobalMuted(!this.globalMuted);
    }

    /**
     * Override local d'un device (après interaction utilisateur).
     * Si ON alors que le maître est OFF → lève le maître (indépendance locale) ;
     * l'appelant mute explicitement les siblings si besoin.
     * @param {string} deviceKey
     * @param {boolean} muted
     * @param {{ aliasKeys?: string[], silent?: boolean, skipSpeakerRestore?: boolean }} [options]
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

        if (!nextMuted && this.globalMuted) {
            this.globalMuted = false;
            // Ne pas resetDevices : on garde les overrides (siblings restent OFF).
            if (!options.silent && this._onMuteStateChanged) {
                await this._onMuteStateChanged(false, {
                    skipSpeakerRestore: true,
                    resetDevices: false
                });
            }
        }

        if (!options.silent && this._onDeviceMuteChanged) {
            await this._onDeviceMuteChanged(key, nextMuted, { aliasKeys: aliases });
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
