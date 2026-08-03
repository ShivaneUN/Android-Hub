const { exec } = require("child_process");
const { adbSerialArg } = require("../../shared/adb-serial-arg");

const STREAM_MUSIC = 3;
/** Fallback stock Android si le probe échoue. Xiaomi HyperOS = souvent 150. */
const DEFAULT_MAX_VOLUME = 15;
/** Au-delà : parse probablement foireux (pas un vrai max STREAM_MUSIC). */
const ABSURD_MAX_VOLUME = 200;
const UI_MAX_PERCENT = 100;

function levelToPercent(volume, max = DEFAULT_MAX_VOLUME) {
    if (!Number.isInteger(volume) || volume <= 0) return 0;
    const m = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_VOLUME;
    return Math.max(0, Math.min(UI_MAX_PERCENT, Math.round((volume / m) * UI_MAX_PERCENT)));
}

function percentToLevel(percent, max = DEFAULT_MAX_VOLUME) {
    const m = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_VOLUME;
    const p = Math.max(0, Math.min(UI_MAX_PERCENT, Math.round(Number(percent) || 0)));
    if (p <= 0) return 0;
    // 100% = index max exact (évite un round qui resterait sous le vrai max).
    if (p >= UI_MAX_PERCENT) return m;
    return Math.max(1, Math.round((p / UI_MAX_PERCENT) * m));
}

function sanitizeMax(max, fallback = DEFAULT_MAX_VOLUME) {
    if (!Number.isInteger(max) || max <= 0) return fallback;
    if (max > ABSURD_MAX_VOLUME) return fallback;
    return max;
}

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

function parseVolumeInfo(output) {
    const text = String(output || "").trim();
    if (!text) return { volume: null, max: null };

    let volume = null;
    let max = null;

    // Ligne canonique media_session : "volume is 75 in range [0..150]"
    const fullLine = text.match(/\bvolume\s+is\s+(\d+)\s+in\s+range\s*\[\s*(\d+)\s*[.\-]{1,2}\s*(\d+)\s*\]/i);
    if (fullLine) {
        volume = Number(fullLine[1]);
        max = Number(fullLine[3]);
    } else {
        const volumeMatch = text.match(/\bvolume\s+is\s+(\d+)\b/i)
            || text.match(/\bvolume(?:\s+is)?\s*[:=]\s*(\d+)\b/i);
        if (volumeMatch) volume = Number(volumeMatch[1]);

        const shouldBe = text.match(/should be in\s*\[\s*(\d+)\s*[.\-]{1,2}\s*(\d+)\s*\]/i);
        const bracketRange = text.match(/in\s+range\s*\[\s*(\d+)\s*[.\-]{1,2}\s*(\d+)\s*\]/i)
            || text.match(/\[\s*(\d+)\s*[.\-]{1,2}\s*(\d+)\s*\]/);
        const wordRange = text.match(/range\s+(\d+)\s*(?:to|-|\.\.)\s*(\d+)/i);
        const maxWord = text.match(/\bmax(?:imum)?\s*[:=]?\s*(\d+)/i);
        if (shouldBe) {
            max = Number(shouldBe[2]);
        } else if (bracketRange) {
            max = Number(bracketRange[2]);
        } else if (wordRange) {
            max = Number(wordRange[2]);
        } else if (maxWord) {
            max = Number(maxWord[1]);
        }
    }

    max = sanitizeMax(max, null);

    if (Number.isInteger(volume) && Number.isInteger(max) && volume > max) {
        max = sanitizeMax(volume, max);
    }

    return {
        volume: Number.isInteger(volume) && volume >= 0 ? volume : null,
        max: Number.isInteger(max) && max > 0 ? max : null
    };
}

/**
 * Volume STREAM_MUSIC sur l'appareil Android via ADB (haut-parleur device).
 * Ne touche jamais au flux audio Hub → PC (scrcpy / session audio).
 */
class DeviceAudioVolumeManager {
    constructor(adbPath) {
        this.adbPath = adbPath;
        /** @type {Map<string, number>} dernier volume connu par serial */
        this.volumeBySerial = new Map();
        /** @type {Map<string, number>} max stream music connu par serial */
        this.maxBySerial = new Map();
        /** @type {Map<string, number>} volume sauvegardé avant mute (0) */
        this.savedVolumeBySerial = new Map();
        /** @type {Map<string, boolean>} intention mute */
        this.mutedBySerial = new Map();
        /** @type {Set<string>} max déjà découvert (évite set 999 à chaque lecture) */
        this.maxProbedSerials = new Set();
    }

    async _runShell(serial, shellCommand) {
        if (!serial || !this.adbPath) {
            throw new Error("ADB ou serial manquant");
        }
        // Quotes obligatoires : sinon Windows/cmd casse --stream / --set.
        const remote = String(shellCommand).replace(/"/g, '\\"');
        return execPromise(`"${this.adbPath}" -s ${adbSerialArg(serial)} shell "${remote}"`);
    }

    async _probeFromMediaCmds(serial) {
        const commands = [
            // Android 11+ en premier
            `cmd media_session volume --stream ${STREAM_MUSIC} --get`,
            `media volume --stream ${STREAM_MUSIC} --get`,
            `cmd media volume --stream ${STREAM_MUSIC} --get`
        ];

        for (const command of commands) {
            try {
                const output = await this._runShell(serial, command);
                const info = parseVolumeInfo(output);
                if (info.volume !== null || info.max !== null) {
                    return info;
                }
            } catch (_err) {
                /* essai commande suivante */
            }
        }
        return { volume: null, max: null };
    }

    _parseStreamMusicBlock(dumpsysText) {
        const text = String(dumpsysText || "");
        const music = text.match(/-\s*STREAM_MUSIC\s*:([\s\S]*?)(?=-\s*STREAM_|\n\s*Streams:|$)/i);
        const block = music ? music[1] : "";
        if (!block) {
            return {
                max: null,
                streamVolume: null,
                speakerVolume: null,
                remoteVolume: null,
                muted: null,
                devices: null
            };
        }
        const maxMatch = block.match(/\bMax\s*:\s*(\d+)/i);
        const streamMatch = block.match(/\bstreamVolume\s*:\s*(\d+)/i);
        const speakerMatch = block.match(/\b2\s*\(speaker\)\s*:\s*(\d+)/i);
        const remoteMatch = block.match(/\b8000\s*\(remote_submix\)\s*:\s*(\d+)/i);
        const mutedMatch = block.match(/\bMuted\s*:\s*(true|false)/i);
        const devicesMatch = block.match(/\bDevices\s*:\s*([^\r\n]+)/i);
        return {
            max: maxMatch ? Number(maxMatch[1]) : null,
            streamVolume: streamMatch ? Number(streamMatch[1]) : null,
            speakerVolume: speakerMatch ? Number(speakerMatch[1]) : null,
            remoteVolume: remoteMatch ? Number(remoteMatch[1]) : null,
            muted: mutedMatch ? mutedMatch[1].toLowerCase() === "true" : null,
            devices: devicesMatch ? devicesMatch[1].trim() : null
        };
    }

    async _probeDumpsysMusic(serial) {
        try {
            const output = await this._runShell(serial, "dumpsys audio");
            return this._parseStreamMusicBlock(output);
        } catch (_err) {
            return {
                max: null,
                streamVolume: null,
                speakerVolume: null,
                remoteVolume: null,
                muted: null,
                devices: null
            };
        }
    }

    async _discoverMaxByInvalidSet(serial) {
        try {
            const output = await this._runShell(
                serial,
                `cmd media_session volume --stream ${STREAM_MUSIC} --set 999`
            );
            const parsed = parseVolumeInfo(output);
            if (parsed.max) return parsed.max;
        } catch (err) {
            const parsed = parseVolumeInfo(err?.message || "");
            if (parsed.max) return parsed.max;
        }
        try {
            const output = await this._runShell(
                serial,
                `media volume --stream ${STREAM_MUSIC} --set 999`
            );
            const parsed = parseVolumeInfo(output);
            if (parsed.max) return parsed.max;
        } catch (err) {
            const parsed = parseVolumeInfo(err?.message || "");
            if (parsed.max) return parsed.max;
        }
        return null;
    }

    /**
     * Volume HP speaker (pas remote_submix scrcpy) — c'est ce que l'utilisateur règle.
     */
    async _probeVolume(serial) {
        const dumpsys = await this._probeDumpsysMusic(serial);
        let max = sanitizeMax(dumpsys.max, null);

        const media = await this._probeFromMediaCmds(serial);
        if (!Number.isInteger(max) || max <= 0) {
            max = media.max;
        }
        if (!Number.isInteger(max) || max <= 0) {
            max = this.maxBySerial.get(serial) || null;
        }
        if (
            !this.maxProbedSerials.has(serial)
            && (!Number.isInteger(max) || max <= 0 || max === DEFAULT_MAX_VOLUME)
        ) {
            const discovered = await this._discoverMaxByInvalidSet(serial);
            this.maxProbedSerials.add(serial);
            if (discovered) max = discovered;
        } else if (Number.isInteger(max) && max > 0) {
            this.maxProbedSerials.add(serial);
        }

        max = sanitizeMax(max, DEFAULT_MAX_VOLUME);
        if (Number.isInteger(max)) this.maxBySerial.set(serial, max);

        // Priorité : index speaker dumpsys (HyperOS / scrcpy remote_submix).
        let volume = dumpsys.speakerVolume;
        if (!Number.isInteger(volume)) {
            volume = dumpsys.streamVolume;
        }
        if (!Number.isInteger(volume)) {
            volume = media.volume;
        }
        if (dumpsys.muted === true && (!Number.isInteger(volume) || volume <= 0)) {
            volume = 0;
        }

        return {
            volume: Number.isInteger(volume) ? volume : null,
            max,
            muted: dumpsys.muted === true || (Number.isInteger(volume) && volume <= 0),
            speakerVolume: dumpsys.speakerVolume,
            streamVolume: dumpsys.streamVolume
        };
    }

    async _tryDisableDnd(serial) {
        try {
            await this._runShell(serial, "cmd notification set_dnd off");
        } catch (_err) {
            /* ignore */
        }
    }

    async _sendVolumeKeys(serial, keyCode, count) {
        const n = Math.max(0, Math.min(40, Math.round(Number(count) || 0)));
        if (n <= 0) return;
        // Une seule shell : beaucoup plus rapide que N invokes ADB.
        await this._runShell(
            serial,
            `sh -c 'i=0; while [ $i -lt ${n} ]; do input keyevent ${keyCode}; i=$((i+1)); done'`
        );
    }

    /**
     * Force le HP speaker à 0 (le son Hub doit sortir sur le PC, jamais la tablette).
     */
    async forceSpeakerSilent(serial) {
        let state = await this._probeDumpsysMusic(serial);
        let speaker = Number.isInteger(state.speakerVolume) ? state.speakerVolume : null;
        if (speaker === null) {
            // Pas d'info speaker : tenter un bas volume stream puis re-probe.
            try {
                await this._runShell(
                    serial,
                    `cmd media_session volume --stream ${STREAM_MUSIC} --set 0`
                );
            } catch (_err) {
                /* ignore */
            }
            state = await this._probeDumpsysMusic(serial);
            speaker = Number.isInteger(state.speakerVolume) ? state.speakerVolume : 0;
        }
        let guard = 0;
        while (speaker > 0 && guard < 25) {
            guard += 1;
            const steps = Math.min(12, Math.max(1, Math.ceil(speaker / 8)));
            await this._sendVolumeKeys(serial, 25, steps);
            state = await this._probeDumpsysMusic(serial);
            const next = Number.isInteger(state.speakerVolume) ? state.speakerVolume : 0;
            if (next >= speaker) {
                await this._sendVolumeKeys(serial, 25, 1);
                state = await this._probeDumpsysMusic(serial);
                const again = Number.isInteger(state.speakerVolume) ? state.speakerVolume : 0;
                if (again >= speaker) break;
                speaker = again;
                continue;
            }
            speaker = next;
        }
        return { success: speaker <= 0, speakerVolume: speaker };
    }

    /**
     * true si le flux actif STREAM_MUSIC est remote_submix (capture scrcpy → PC).
     */
    async isRemoteAudioRouteActive(serial) {
        const state = await this._probeDumpsysMusic(serial);
        return /remote_submix/i.test(String(state.devices || ""));
    }

    /**
     * Attend que scrcpy ait basculé le stream vers remote_submix.
     * Sans ça, media_session --set tape le HP tablette.
     */
    async waitForRemoteAudioRoute(serial, { timeoutMs = 2500 } = {}) {
        if (!serial) return false;
        if (await this.isRemoteAudioRouteActive(serial)) return true;
        const start = Date.now();
        const budget = Math.max(200, Number(timeoutMs) || 2500);
        while (Date.now() - start < budget) {
            await new Promise((resolve) => setTimeout(resolve, 120));
            if (await this.isRemoteAudioRouteActive(serial)) return true;
        }
        return false;
    }

    _activeMusicVolumeFromDumpsys(dumpsys) {
        if (!dumpsys) return null;
        if (/remote_submix/i.test(String(dumpsys.devices || ""))) {
            if (Number.isInteger(dumpsys.remoteVolume)) return dumpsys.remoteVolume;
            if (Number.isInteger(dumpsys.streamVolume)) return dumpsys.streamVolume;
        }
        if (Number.isInteger(dumpsys.speakerVolume)) return dumpsys.speakerVolume;
        if (Number.isInteger(dumpsys.streamVolume)) return dumpsys.streamVolume;
        return null;
    }

    /**
     * Niveau stream media (capture / sortie) via media_session.
     * Ne force pas le HP à 0 (sinon ON → silence total).
     * percent > 0 : n'applique que si remote_submix est actif (son PC),
     * sauf force=true (ex. slider alors que la route n'est pas encore là).
     */
    async setVolumePercentPcOnly(serial, percent, { force = false, showUi = true } = {}) {
        const max = await this.ensureMax(serial);
        const level = percentToLevel(percent, max);
        const uiPercent = Math.max(
            0,
            Math.min(UI_MAX_PERCENT, Math.round(Number(percent) || 0))
        );
        await this._tryDisableDnd(serial);

        // Remonter / baisser le volume avant remote_submix → risque de taper le HP.
        // OFF (0) et ON (>0) : n'appliquer que si la route PC est active.
        if (!force) {
            const ready = await this.isRemoteAudioRouteActive(serial);
            if (!ready) {
                this.volumeBySerial.set(serial, level);
                this._remember(serial, level, max);
                return {
                    success: false,
                    deferred: true,
                    volume: level,
                    max,
                    percent: uiPercent,
                    speakerVolume: null,
                    muted: uiPercent === 0
                };
            }
        }

        // media_session cible le device actif (remote_submix pendant mirroring).
        // showUi=false (lancement OFF) : pas de barre volume Android.
        const commands = [
            `cmd media_session volume --stream ${STREAM_MUSIC} --set ${level}`
        ];
        if (showUi !== false) {
            commands.push(
                `cmd media_session volume --stream ${STREAM_MUSIC} --show --set ${level}`
            );
        }
        let applied = false;
        for (const command of commands) {
            try {
                const output = await this._runShell(serial, command);
                if (/invalid volume index|Error:/i.test(String(output || ""))) continue;
                applied = true;
                break;
            } catch (_err) {
                /* suivante */
            }
        }

        // Jamais de keyevents VOLUME_* ici : ça injecte des inputs fantômes dans les sessions Hub.
        const dumpsys = await this._probeDumpsysMusic(serial);
        const activeVol = this._activeMusicVolumeFromDumpsys(dumpsys);
        const tol = Math.max(1, Math.round(max * 0.03));
        if (Number.isInteger(activeVol) && Math.abs(activeVol - level) <= tol) {
            applied = true;
        }

        this.volumeBySerial.set(serial, level);
        this._remember(serial, level, dumpsys.max || max);

        return {
            success: applied || uiPercent === 0,
            volume: level,
            max: sanitizeMax(dumpsys.max, max),
            percent: uiPercent,
            speakerVolume: dumpsys.speakerVolume ?? 0,
            remoteVolume: dumpsys.remoteVolume ?? null,
            muted: uiPercent <= 0
        };
    }

    /**
     * Ajuste le stream MUSIC actif (remote_submix ou speaker) via keyevents.
     */
    async _adjustActiveStreamWithKeys(serial, target, max) {
        let dumpsys = await this._probeDumpsysMusic(serial);
        let current = this._activeMusicVolumeFromDumpsys(dumpsys);
        if (!Number.isInteger(current)) current = 0;

        if (dumpsys.muted && target > 0 && current <= 0) {
            await this._sendVolumeKeys(serial, 24, 1);
            dumpsys = await this._probeDumpsysMusic(serial);
            current = this._activeMusicVolumeFromDumpsys(dumpsys);
            if (!Number.isInteger(current)) current = 0;
        }

        let guard = 0;
        while (current !== target && guard < 30) {
            guard += 1;
            const diff = target - current;
            if (diff === 0) break;
            const steps = Math.min(Math.max(1, Math.ceil(Math.abs(diff) / 8)), 12);
            await this._sendVolumeKeys(serial, diff > 0 ? 24 : 25, steps);
            dumpsys = await this._probeDumpsysMusic(serial);
            const next = this._activeMusicVolumeFromDumpsys(dumpsys);
            if (!Number.isInteger(next) || next === current) {
                await this._sendVolumeKeys(serial, diff > 0 ? 24 : 25, 1);
                dumpsys = await this._probeDumpsysMusic(serial);
                const again = this._activeMusicVolumeFromDumpsys(dumpsys);
                if (!Number.isInteger(again) || again === current) break;
                current = Math.max(0, Math.min(max, again));
                continue;
            }
            current = Math.max(0, Math.min(max, next));
        }
        return current;
    }

    /**
     * Fallback HyperOS : media_session --set est parfois ignoré (mute / DND / OEM).
     * Les keyevents VOLUME_UP/DOWN passent toujours.
     */
    async _adjustSpeakerWithKeys(serial, target, max) {
        let state = await this._probeVolume(serial);
        let current = Number.isInteger(state.volume) ? state.volume : 0;

        // Unmute obligatoire : sinon --set et même --adj sont ignorés.
        if (state.muted && target > 0 && current <= 0) {
            await this._sendVolumeKeys(serial, 24, 1);
            state = await this._probeVolume(serial);
            current = Number.isInteger(state.volume) ? state.volume : 0;
        }

        let guard = 0;
        while (current !== target && guard < 30) {
            guard += 1;
            const diff = target - current;
            if (diff === 0) break;
            // Sur Xiaomi 0–150, 1 key ≈ plusieurs index : on envoie peu puis on re-mesure.
            const steps = Math.min(Math.max(1, Math.ceil(Math.abs(diff) / 8)), 12);
            await this._sendVolumeKeys(serial, diff > 0 ? 24 : 25, steps);
            state = await this._probeVolume(serial);
            const next = Number.isInteger(state.volume) ? state.volume : current;
            if (next === current) {
                // Bloqué : un seul key puis abandon si toujours égal.
                await this._sendVolumeKeys(serial, diff > 0 ? 24 : 25, 1);
                state = await this._probeVolume(serial);
                const again = Number.isInteger(state.volume) ? state.volume : current;
                if (again === current) break;
                current = again;
                continue;
            }
            // Dépassement : on continue, la boucle corrige dans l'autre sens.
            current = Math.max(0, Math.min(max, next));
        }
        return current;
    }

    async _setMediaVolume(serial, level) {
        const volume = Math.max(0, Math.round(level));
        await this._tryDisableDnd(serial);

        const commands = [
            `cmd media_session volume --stream ${STREAM_MUSIC} --set ${volume}`,
            `cmd media_session volume --stream ${STREAM_MUSIC} --show --set ${volume}`,
            `media volume --stream ${STREAM_MUSIC} --set ${volume}`
        ];

        for (const command of commands) {
            try {
                const output = await this._runShell(serial, command);
                const text = String(output || "");
                if (/invalid volume index|Error:/i.test(text)) {
                    const parsed = parseVolumeInfo(text);
                    if (parsed.max) {
                        this.maxBySerial.set(serial, parsed.max);
                        this.maxProbedSerials.add(serial);
                    }
                    continue;
                }
                const verified = await this._probeVolume(serial);
                if (Number.isInteger(verified.max) && verified.max > 0) {
                    this.maxBySerial.set(serial, sanitizeMax(verified.max));
                    this.maxProbedSerials.add(serial);
                }
                if (Number.isInteger(verified.volume) && verified.volume === volume && !verified.muted) {
                    return true;
                }
                if (
                    volume <= 0
                    && Number.isInteger(verified.volume)
                    && verified.volume <= 0
                ) {
                    return true;
                }
            } catch (_err) {
                /* essai suivante */
            }
        }
        return false;
    }

    _remember(serial, volume, max = null) {
        if (!serial) return;
        if (Number.isInteger(volume) && volume >= 0) {
            this.volumeBySerial.set(serial, volume);
            if (volume > 0) {
                this.savedVolumeBySerial.set(serial, volume);
                this.mutedBySerial.set(serial, false);
            } else {
                this.mutedBySerial.set(serial, true);
            }
        }
        if (Number.isInteger(max) && max > 0) {
            this.maxBySerial.set(serial, sanitizeMax(max));
        }
    }

    /**
     * @param {string} serial
     * @returns {Promise<{ success: boolean, volume: number|null, max: number, muted?: boolean, error?: string }>}
     */
    async getState(serial) {
        if (!serial) {
            return { success: false, volume: null, max: DEFAULT_MAX_VOLUME, muted: false, error: "Serial manquant" };
        }

        try {
            const probed = await this._probeVolume(serial);
            const max = sanitizeMax(
                probed.max || this.maxBySerial.get(serial) || DEFAULT_MAX_VOLUME
            );
            if (probed.volume === null) {
                const cached = this.volumeBySerial.get(serial);
                const muted = this.mutedBySerial.has(serial)
                    ? Boolean(this.mutedBySerial.get(serial))
                    : (Number.isInteger(cached) ? cached <= 0 : false);
                return {
                    success: true,
                    volume: Number.isInteger(cached) ? cached : null,
                    max,
                    muted,
                    speakerVolume: null,
                    streamVolume: null
                };
            }
            let volume = probed.volume;
            let safeMax = max;
            if (Number.isInteger(volume) && volume > safeMax) {
                safeMax = sanitizeMax(volume, max);
            }
            this._remember(serial, volume, safeMax);
            return {
                success: true,
                volume,
                max: safeMax,
                muted: Boolean(probed.muted) || volume <= 0,
                speakerVolume: probed.speakerVolume ?? null,
                streamVolume: probed.streamVolume ?? null
            };
        } catch (err) {
            return {
                success: false,
                volume: this.volumeBySerial.get(serial) ?? null,
                max: this.maxBySerial.get(serial) || DEFAULT_MAX_VOLUME,
                muted: Boolean(this.mutedBySerial.get(serial)),
                error: err?.message || String(err)
            };
        }
    }

    /**
     * Assure un max fiable avant set (sinon 100% ≠ vrai max device).
     * @param {string} serial
     */
    async ensureMax(serial) {
        if (!this.maxProbedSerials.has(serial)) {
            const state = await this.getState(serial);
            return sanitizeMax(state.max || DEFAULT_MAX_VOLUME);
        }
        const known = this.maxBySerial.get(serial);
        if (Number.isInteger(known) && known > 0 && known <= ABSURD_MAX_VOLUME) {
            return known;
        }
        const state = await this.getState(serial);
        return sanitizeMax(state.max || DEFAULT_MAX_VOLUME);
    }

    /**
     * @param {string} serial
     * @param {number} level
     */
    async setVolume(serial, level) {
        if (!serial) {
            return { success: false, volume: null, max: DEFAULT_MAX_VOLUME, muted: false, error: "Serial manquant" };
        }

        let max = await this.ensureMax(serial);
        const target = Math.max(0, Math.min(max, Math.round(Number(level))));
        if (!Number.isFinite(target)) {
            return { success: false, volume: null, max, muted: false, error: "Niveau invalide" };
        }

        try {
            let ok = await this._setMediaVolume(serial, target);
            let verified = await this._probeVolume(serial);
            if (Number.isInteger(verified.max) && verified.max > 0) {
                max = sanitizeMax(verified.max, max);
            }

            const speakerOk = Number.isInteger(verified.volume)
                && Math.abs(verified.volume - target) <= 1
                && (target <= 0 || !verified.muted);

            if (!speakerOk) {
                // HyperOS / device "bloqué" : keyevents (seul chemin fiable observé).
                const keyed = await this._adjustSpeakerWithKeys(serial, target, max);
                verified = await this._probeVolume(serial);
                ok = Number.isInteger(verified.volume)
                    && Math.abs((verified.volume ?? keyed) - target) <= Math.max(2, Math.round(max * 0.03));
            } else {
                ok = true;
            }

            const finalVol = Number.isInteger(verified.volume) ? verified.volume : target;
            this._remember(serial, finalVol, max);
            console.log(
                `[DeviceSpeaker] Volume speaker ${serial} → ${finalVol}/${max}`
                + (ok ? "" : " (approx)")
            );
            return {
                success: ok || Number.isInteger(verified.volume),
                volume: finalVol,
                max,
                muted: Boolean(verified.muted) || finalVol <= 0
            };
        } catch (err) {
            console.warn(`[DeviceSpeaker] setVolume ${serial}:`, err.message);
            return {
                success: false,
                volume: this.volumeBySerial.get(serial) ?? null,
                max: this.maxBySerial.get(serial) || max,
                muted: Boolean(this.mutedBySerial.get(serial)),
                error: err.message
            };
        }
    }

    /**
     * UI 0–100 → niveau ADB stream (100% = vrai max device).
     * @param {string} serial
     * @param {number} percent
     */
    async setVolumePercent(serial, percent) {
        const max = await this.ensureMax(serial);
        const level = percentToLevel(percent, max);
        const result = await this.setVolume(serial, level);
        // Si l'utilisateur demande 100% mais le device n'est pas au max, retenter une fois.
        if (
            result.success
            && Math.round(Number(percent) || 0) >= UI_MAX_PERCENT
            && Number.isInteger(result.volume)
            && Number.isInteger(result.max)
            && result.volume < result.max
        ) {
            const again = await this.setVolume(serial, result.max);
            return {
                ...again,
                percent: levelToPercent(again.volume, again.max || result.max)
            };
        }
        return {
            ...result,
            percent: levelToPercent(result.volume, result.max || max)
        };
    }

    async setVolumePercentMany(serials = [], percent, { shouldContinue } = {}) {
        const unique = [...new Set((serials || []).filter(Boolean))];
        const results = [];
        for (const serial of unique) {
            if (typeof shouldContinue === "function" && !shouldContinue()) {
                break;
            }
            results.push({
                serial,
                ...(await this.setVolumePercent(serial, percent))
            });
        }
        return { success: results.length > 0 && results.every((r) => r.success), results };
    }

    async setVolumeMany(serials = [], level) {
        const unique = [...new Set((serials || []).filter(Boolean))];
        const results = await Promise.all(
            unique.map(async (serial) => ({ serial, ...(await this.setVolume(serial, level)) }))
        );
        return { success: results.every((r) => r.success), results };
    }
}

module.exports = {
    DeviceAudioVolumeManager,
    DEFAULT_MAX_VOLUME,
    UI_MAX_PERCENT,
    levelToPercent,
    percentToLevel
};
