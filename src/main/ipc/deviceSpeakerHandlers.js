const { ipcMain } = require("electron");

async function resolveAdbSerial({ serial = null, stableDeviceId = null } = {}) {
    if (!serial && !stableDeviceId) return null;
    if (global.deviceRegistry?.resolveEffectiveAdbSerial) {
        try {
            const resolved = await global.deviceRegistry.resolveEffectiveAdbSerial({
                deviceId: stableDeviceId || null,
                serial: serial || null
            });
            if (resolved) return resolved;
        } catch (_err) {
            // fallback
        }
    }
    return serial || null;
}

async function resolveTarget(hint = {}) {
    const home = Boolean(hint?.home);
    const manager = global.browserViewManager;
    const activeId = (!home && manager) ? manager.getActiveSessionId() : null;
    const entry = activeId ? manager.getSessionEntry(activeId) : null;

    let serialHint = hint?.serial || null;
    let stableDeviceId = hint?.stableDeviceId || null;

    if (entry?.deviceId) {
        serialHint = entry.deviceId;
        stableDeviceId = entry.stableDeviceId || stableDeviceId;
    }

    const adbSerial = await resolveAdbSerial({
        serial: serialHint,
        stableDeviceId
    });

    return {
        adbSerial,
        serialHint,
        stableDeviceId,
        activeId
    };
}

function broadcastDeviceSpeakerState(getMainWindow, payload) {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
        win.webContents.send("deviceSpeaker:state-changed", payload);
    }
}

function toPayload(base, state) {
    return {
        success: Boolean(state?.success),
        enabled: Boolean(base.adbSerial),
        volume: Number.isInteger(state?.volume) ? state.volume : null,
        max: Number.isInteger(state?.max) && state.max > 0 ? state.max : 15,
        serial: base.adbSerial,
        deviceId: base.serialHint || base.adbSerial,
        stableDeviceId: base.stableDeviceId || null,
        sessionId: base.activeId || null,
        error: state?.error || null
    };
}

/**
 * IPC volume haut-parleur device (ADB STREAM_MUSIC) — isolé de l'audio PC Hub.
 */
function registerDeviceSpeakerHandlers(getMainWindow, volumeManager) {
    if (!volumeManager) {
        console.warn("[DeviceSpeaker] manager manquant — handlers non enregistres");
        return;
    }

    ipcMain.handle("deviceSpeaker:getState", async (_event, hint = {}) => {
        const target = await resolveTarget(hint);
        if (!target.adbSerial) {
            return { success: true, enabled: false, volume: null, max: 15 };
        }
        const state = await volumeManager.getState(target.adbSerial);
        return toPayload(target, state);
    });

    ipcMain.handle("deviceSpeaker:setVolume", async (_event, payload = {}) => {
        const target = await resolveTarget(payload);
        if (!target.adbSerial) {
            return { success: false, enabled: false, error: "Aucun appareil pour regler le son" };
        }

        const result = await volumeManager.setVolume(target.adbSerial, payload.volume);
        const response = toPayload(target, result);
        if (response.success) {
            broadcastDeviceSpeakerState(getMainWindow, response);
        }
        return response;
    });
}

module.exports = { registerDeviceSpeakerHandlers };
