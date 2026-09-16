const { BrowserWindow } = require("electron");

const MAX_ENTRIES = 400;

class HubDiagnosticLog {
    constructor() {
        this.entries = [];
        this.seq = 0;
    }

    append(partial = {}) {
        const message = String(partial.message || "").trim();
        if (!message) return null;

        const entry = {
            id: ++this.seq,
            ts: Date.now(),
            level: ["info", "warn", "error"].includes(partial.level) ? partial.level : "info",
            scope: String(partial.scope || "hub").slice(0, 32),
            message: message.slice(0, 500),
            sessionId: partial.sessionId ? String(partial.sessionId).slice(0, 64) : null
        };

        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }

        this._broadcast(entry);
        return entry;
    }

    list() {
        return this.entries.slice();
    }

    clear() {
        this.entries = [];
        this._broadcast({ type: "cleared" });
        return { success: true };
    }

    _broadcast(payload) {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win || win.isDestroyed()) continue;
            try {
                win.webContents.send("hub-log:entry", payload);
            } catch (_err) {
                /* noop */
            }
        }
    }
}

module.exports = { HubDiagnosticLog };
