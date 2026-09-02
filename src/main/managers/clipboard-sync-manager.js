const { clipboard } = require("electron");
const {
    SC_COPY_KEY_COPY,
    SC_COPY_KEY_CUT,
    encodeGetClipboard,
    encodeSetClipboard,
    encodeScanFile,
    consumeDeviceMessages
} = require("../../native/scrcpy/control/clipboard-protocol");

/**
 * Sync presse-papiers PC ↔ device via le socket contrôle existant.
 * Greffe externe sur _attachControlListeners (scrcpy-socket.js LOCK inchangé).
 */
class ClipboardSyncManager {
    constructor({ getUiPreferencesManager } = {}) {
        this.getUiPreferencesManager = getUiPreferencesManager;
        this._attachedSockets = new WeakSet();
        this._installed = false;
    }

    isEnabled() {
        const prefs = this.getUiPreferencesManager?.();
        if (typeof prefs?.getClipboardAutosync === "function") {
            return prefs.getClipboardAutosync() !== false;
        }
        return true;
    }

    install(ScrcpySocketClient) {
        if (this._installed || !ScrcpySocketClient?.prototype) return;
        this._installed = true;
        const proto = ScrcpySocketClient.prototype;
        const original = proto._attachControlListeners;
        if (typeof original !== "function") return;

        const manager = this;
        proto._attachControlListeners = function patchedAttachControlListeners() {
            original.call(this);
            manager.attach(this);
        };
    }

    attach(client) {
        const socket = client?.controlSocket;
        if (!socket || socket.destroyed || this._attachedSockets.has(socket)) return;

        this._attachedSockets.add(socket);
        let buffer = Buffer.alloc(0);

        socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const { consumed, messages } = consumeDeviceMessages(buffer);
            if (consumed > 0) {
                buffer = buffer.subarray(consumed);
            }
            for (const message of messages) {
                if (message.type === "clipboard") {
                    this._onDeviceClipboard(message.text);
                }
            }
        });

        socket.on("close", () => {
            this._attachedSockets.delete(socket);
        });
    }

    _onDeviceClipboard(text) {
        if (!this.isEnabled()) return;
        if (typeof text !== "string") return;
        try {
            clipboard.writeText(text);
        } catch (err) {
            console.warn("[ClipboardSync] writeText:", err?.message || err);
        }
    }

    getClientForSession(sessionId) {
        if (!sessionId) return null;
        const entry = global.browserViewManager?.getSessionEntry?.(sessionId);
        if (!entry) return null;
        if (entry.type === "A") {
            return global.getVideoClientForSession?.(sessionId) || null;
        }
        return global.newInstanceManager?.getNewInstanceSession?.(sessionId)?.client
            || null;
    }

    getClientForSerial(serial) {
        const wanted = String(serial || "");
        if (!wanted) return null;
        const sessions = global.browserViewManager?.getAllSessions?.() || [];
        for (const summary of sessions) {
            const client = this.getClientForSession(summary.sessionId);
            if (!client?.controlSocket || client.controlSocket.destroyed) continue;
            const ids = [client.serial, client.shellSerial, summary.deviceId, summary.stableDeviceId]
                .filter(Boolean)
                .map(String);
            if (ids.includes(wanted)) return client;
        }
        return null;
    }

    findSessionIdByWebContents(webContents) {
        const manager = global.browserViewManager;
        if (!manager?.views) return manager?.getActiveSessionId?.() || null;
        for (const [sessionId, entry] of manager.views) {
            if (entry?.view?.webContents === webContents) return sessionId;
        }
        return manager.getActiveSessionId?.() || null;
    }

    async sendGetClipboard(client, copyKey) {
        if (!client?.controlSocket || typeof client.sendControlMessage !== "function") {
            throw new Error("Contrôle scrcpy indisponible");
        }
        await client.sendControlMessage(encodeGetClipboard(copyKey));
    }

    async sendSetClipboard(client, text, { paste = false } = {}) {
        if (!client?.controlSocket || typeof client.sendControlMessage !== "function") {
            throw new Error("Contrôle scrcpy indisponible");
        }
        await client.sendControlMessage(encodeSetClipboard(text, { paste, sequence: 0n }));
    }

    async sendScanFile(client, remotePath) {
        if (!client?.controlSocket || typeof client.sendControlMessage !== "function") {
            return false;
        }
        try {
            await client.sendControlMessage(encodeScanFile(remotePath));
            return true;
        } catch (_err) {
            return false;
        }
    }

    async handleShortcut(webContents, key) {
        if (!this.isEnabled()) return { success: false, error: "clipboard-disabled" };
        const sessionId = this.findSessionIdByWebContents(webContents);
        const client = this.getClientForSession(sessionId);
        if (!client?.controlSocket) {
            return { success: false, error: "no-control" };
        }

        try {
            if (key === "v") {
                const text = clipboard.readText();
                await this.sendSetClipboard(client, text, { paste: true });
                return { success: true };
            }
            if (key === "c") {
                await this.sendGetClipboard(client, SC_COPY_KEY_COPY);
                return { success: true };
            }
            if (key === "x") {
                await this.sendGetClipboard(client, SC_COPY_KEY_CUT);
                return { success: true };
            }
            return { success: false, error: "unknown-key" };
        } catch (err) {
            console.warn("[ClipboardSync] shortcut:", err?.message || err);
            return { success: false, error: err?.message || String(err) };
        }
    }
}

module.exports = { ClipboardSyncManager };
