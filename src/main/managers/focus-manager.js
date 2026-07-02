class FocusManager {
    constructor() {
        this.focusedSessionId = null;
    }

    setFocus(sessionId) {
        if (this.focusedSessionId === sessionId) return;
        this.focusedSessionId = sessionId;
    }

    getFocus() {
        return this.focusedSessionId;
    }

    clearFocus() {
        this.focusedSessionId = null;
    }

    hasFocus(sessionId) {
        return this.focusedSessionId === sessionId;
    }
}

module.exports = { FocusManager };