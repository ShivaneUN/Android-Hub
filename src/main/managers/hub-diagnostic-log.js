const { BrowserWindow } = require("electron");

const MAX_ENTRIES = 400;
const DEDUPE_MS = 1500;

function formatConsoleArgs(args) {
    return args
        .map((value) => {
            if (value instanceof Error) return value.message || String(value);
            if (typeof value === "string") return value;
            try {
                return JSON.stringify(value);
            } catch (_err) {
                return String(value);
            }
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

class HubDiagnosticLog {
    constructor() {
        this.entries = [];
        this.seq = 0;
        this._capturing = false;
        this._hooksInstalled = false;
        this._recent = [];
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

        const now = entry.ts;
        const dedupeKey = `${entry.level}:${entry.scope}:${entry.message}`;
        this._recent = this._recent.filter((item) => now - item.ts < DEDUPE_MS);
        if (this._recent.some((item) => item.key === dedupeKey)) {
            return entry;
        }
        this._recent.push({ key: dedupeKey, ts: now });

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

    installGlobalCapture() {
        if (this._hooksInstalled) return;
        this._hooksInstalled = true;

        const origError = console.error.bind(console);
        console.error = (...args) => {
            origError(...args);
            this._appendFromConsole("error", args);
        };

        process.on("uncaughtException", (err) => {
            this.append({
                level: "error",
                scope: "process",
                message: `uncaughtException: ${err?.message || err}`
            });
        });
        process.on("unhandledRejection", (reason) => {
            const msg = reason instanceof Error ? reason.message : String(reason);
            this.append({
                level: "error",
                scope: "process",
                message: `unhandledRejection: ${msg}`
            });
        });
    }

    attachWebContents(contents) {
        if (!contents || typeof contents.on !== "function") return;
        if (contents.__hubLogAttached) return;
        contents.__hubLogAttached = true;
        contents.on("console-message", (event, level, message) => {
            const lvl = Number(event?.level ?? level);
            const msg = String(event?.message ?? message ?? "").trim();
            if (lvl < 3 || !msg) return;
            this.append({
                level: "error",
                scope: "renderer",
                message: msg
            });
        });
    }

    _appendFromConsole(level, args) {
        if (this._capturing) return;
        this._capturing = true;
        try {
            const message = formatConsoleArgs(args);
            if (!message) return;
            this.append({ level, scope: "main", message });
        } finally {
            this._capturing = false;
        }
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

function installHubLogWebContentsBridge() {
    const { app } = require("electron");
    app.on("web-contents-created", (_event, contents) => {
        const attach = () => global.hubDiagnosticLog?.attachWebContents?.(contents);
        attach();
        contents.on("dom-ready", attach);
    });
}

module.exports = { HubDiagnosticLog, installHubLogWebContentsBridge };
