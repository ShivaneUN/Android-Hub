class LayoutSlot {
    constructor(data = {}) {
        this.sessionId = data.sessionId || null;
        this.position = data.position || { x: 0, y: 0, width: 0, height: 0 };
    }

    toJSON() {
        return {
            sessionId: this.sessionId,
            position: { ...this.position }
        };
    }
}

class Layout {
    constructor(data = {}) {
        this.id = data.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        this.mode = data.mode || "single";
        this.slots = (data.slots || []).map(s => new LayoutSlot(s));
    }

    toJSON() {
        return {
            id: this.id,
            mode: this.mode,
            slots: this.slots.map(s => s.toJSON())
        };
    }
}

class LayoutManager {
    constructor() {
        this.layouts = {}; // map id => Layout
        this.activeLayoutId = null;
    }

    createLayout(mode, slots = []) {
        if (mode !== "single" && mode !== "multi") {
            throw new Error(`Invalid layout mode: "${mode}". Expected "single" or "multi".`);
        }

        const layout = new Layout({ mode, slots });
        this.layouts[layout.id] = layout;
        return layout.toJSON();
    }

    getLayout(layoutId) {
        const layout = this.layouts[layoutId];
        return layout ? layout.toJSON() : null;
    }

    listLayouts() {
        return Object.values(this.layouts).map(l => l.toJSON());
    }

    setActiveLayout(layoutId) {
        if (!this.layouts[layoutId]) {
            throw new Error(`Layout not found: "${layoutId}"`);
        }
        this.activeLayoutId = layoutId;
    }

    getActiveLayout() {
        if (!this.activeLayoutId) return null;
        return this.getLayout(this.activeLayoutId);
    }

    updateSlots(layoutId, slots) {
        const layout = this.layouts[layoutId];
        if (!layout) throw new Error('Layout not found');

        layout.slots = slots.map(s => new LayoutSlot(s));
        return layout.toJSON();
    }

    assignSessionToSlot(layoutId, slotIndex, sessionId) {
        const layout = this.layouts[layoutId];
        if (!layout) throw new Error('Layout not found');

        if (slotIndex < 0 || slotIndex >= layout.slots.length) {
            throw new Error(`Invalid slot index: ${slotIndex}`);
        }

        layout.slots[slotIndex].sessionId = sessionId;
        return layout.toJSON();
    }

    removeSessionFromSlot(layoutId, slotIndex) {
        const layout = this.layouts[layoutId];
        if (!layout) throw new Error('Layout not found');

        if (slotIndex < 0 || slotIndex >= layout.slots.length) {
            throw new Error(`Invalid slot index: ${slotIndex}`);
        }

        layout.slots[slotIndex].sessionId = null;
        return layout.toJSON();
    }

    destroyLayout(layoutId) {
        if (!this.layouts[layoutId]) return false;
        delete this.layouts[layoutId];

        if (this.activeLayoutId === layoutId) {
            this.activeLayoutId = null;
        }

        return true;
    }
}

module.exports = { Layout, LayoutSlot, LayoutManager };