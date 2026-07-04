/**
 * État global audio (toggle sidebar).
 * OFF : arrete les processus scrcpy audio + socket sans audio.
 * ON  : processus scrcpy --no-video par session (son PC + silence device).
 */
class GlobalAudioOutputManager {
    constructor() {
        /** @type {boolean} true = son PC coupé (OFF) */
        this.globalMuted = false;
        /** @type {((muted: boolean) => Promise<void>)|null} */
        this._onMuteStateChanged = null;
    }

    isGlobalMuted() {
        return this.globalMuted;
    }

    /**
     * Callback Main : refresh des sessions actives quand l'état mute change.
     * @param {(muted: boolean) => Promise<void>} fn
     */
    setOnMuteStateChanged(fn) {
        this._onMuteStateChanged = typeof fn === "function" ? fn : null;
    }

    /**
     * scrcpy.exe externe (bootstrap display Type B) : jamais d'audio côté CLI.
     * La capture + lecture PC passent uniquement par le socket Hub.
     * @param {string[]} args
     * @returns {string[]}
     */
    applyDisplayBootstrapScrcpyArgs(args) {
        const next = args.filter((arg) => arg !== "--no-audio" && arg !== "--no-playback");
        next.push("--no-audio", "--no-playback");
        return next;
    }

    /**
     * Applique ou retire --no-audio selon l'état global (scrcpy.exe externe).
     * @param {string[]} args
     * @returns {string[]}
     */
    applyScrcpyCliArgs(args) {
        const next = args.filter((arg) => arg !== "--no-audio");
        if (this.globalMuted) {
            next.push("--no-audio");
        }
        return next;
    }

    /**
     * Applique l'état global aux options scrcpy-server (socket Hub).
     * ON = audio:true (capture playback, device muet via OS).
     * OFF = audio:false.
     * @param {object} options
     * @returns {object}
     */
    applySocketScrcpyOptions(options = {}) {
        const next = { ...options };
        // Capture audio = processus scrcpy.exe dedie (--no-video), pas le socket Hub.
        next.audio = false;
        return next;
    }

    async setGlobalMuted(muted) {
        const nextMuted = Boolean(muted);
        const changed = nextMuted !== this.globalMuted;
        this.globalMuted = nextMuted;

        if (changed && this._onMuteStateChanged) {
            await this._onMuteStateChanged(this.globalMuted);
        }

        return { globalMuted: this.globalMuted };
    }

    async toggleGlobalMuted() {
        return this.setGlobalMuted(!this.globalMuted);
    }
}

module.exports = { GlobalAudioOutputManager };
