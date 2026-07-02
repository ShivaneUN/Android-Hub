const fs = require('fs');
const path = require('path');

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class Session {
    constructor(data = {}) {
        this.id = data.id || generateId();
        this.name = data.name || `Session-${this.id}`;
        this.state = data.state || "disconnected";
        this.icon = data.icon || null;
        this.serial = data.serial || null; // device serial
        this.app = data.app || null; // current app/package
        this.resolution = data.resolution || { width: 0, height: 0 };
        this.fps = data.fps || 60;
        this.settings = data.settings || {};
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            state: this.state,
            icon: this.icon,
            serial: this.serial,
            app: this.app,
            resolution: this.resolution,
            fps: this.fps,
            settings: this.settings
        };
    }
}

class SessionManager {
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
        this.sessions = {}; // map id => Session
    }

    loadSync() {
        if (!fs.existsSync(this.filePath)) {
            this.sessions = {};
            return;
        }
        const raw = fs.readFileSync(this.filePath, 'utf8');
        try {
            const arr = JSON.parse(raw || '[]');
            this.sessions = {};
            for (const s of arr) {
                this.sessions[s.id] = new Session(s);
            }
        } catch (err) {
            throw new Error(`Failed to parse sessions file: ${err.message}`);
        }
    }

    saveSync() {
        const arr = Object.values(this.sessions).map(s => s.toJSON());
        fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2), 'utf8');
    }

    getAll() {
        return Object.values(this.sessions).map(s => s.toJSON());
    }

    get(id) {
        const s = this.sessions[id];
        return s ? s.toJSON() : null;
    }

    create(data = {}) {
        const s = new Session(data);
        this.sessions[s.id] = s;
        this.saveSync();
        return s.toJSON();
    }

    update(id, updates = {}) {
        const s = this.sessions[id];
        if (!s) throw new Error('Session not found');
        Object.assign(s, updates);
        this.saveSync();
        return s.toJSON();
    }

    remove(id) {
        if (!this.sessions[id]) return false;
        delete this.sessions[id];
        this.saveSync();
        return true;
    }

    pauseSession(sessionId) {
        const s = this.sessions[sessionId];
        if (!s) throw new Error('Session not found');
        if (s.state !== "connected" && s.state !== "reconnecting") {
            throw new Error(`Cannot pause session in state "${s.state}"`);
        }
        s.state = "paused";
        this.saveSync();
    }

    resumeSession(sessionId) {
        const s = this.sessions[sessionId];
        if (!s) throw new Error('Session not found');
        if (s.state !== "paused") {
            throw new Error(`Cannot resume session in state "${s.state}"`);
        }
        s.state = "connecting";
        this.saveSync();
    }

    updateSettings(sessionId, { fps, bitrate }) {
        const s = this.sessions[sessionId];
        if (!s) throw new Error('Session not found');
        if (fps !== undefined) s.fps = fps;
        if (bitrate !== undefined) s.settings.bitrate = bitrate;
        this.saveSync();
    }

    createSession(deviceId) {
        return this.create({ deviceId });
    }

    createAppSession(deviceId, appPackageName, options = {}) {
        const defaultOptions = {
            resolution: '1280x720',
            dpi: 240,
            fps: 60,
            bitrate: 8,
            iFrameInterval: 3,
            orientation: 'landscape'
        };

        const mergedOptions = { ...defaultOptions, ...options };

        return this.create({
            deviceId,
            app: appPackageName,
            settings: {
                ...mergedOptions,
                type: 'app'
            }
        });
    }

    destroySession(sessionId) {
        return this.remove(sessionId);
    }

    getSession(sessionId) {
        return this.get(sessionId);
    }

    listSessions() {
        return this.getAll();
    }
}

module.exports = { Session, SessionManager };
