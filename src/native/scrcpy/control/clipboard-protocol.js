/**
 * Messages contrôle scrcpy 4.0 : clipboard + scan média.
 * Sérialisation alignée sur app/src/control_msg.c (hors scrcpy-socket.js LOCK).
 */

const SC_CONTROL_MSG_TYPE_GET_CLIPBOARD = 8;
const SC_CONTROL_MSG_TYPE_SET_CLIPBOARD = 9;
const SC_CONTROL_MSG_TYPE_SCAN_FILE = 22;

const SC_COPY_KEY_NONE = 0;
const SC_COPY_KEY_COPY = 1;
const SC_COPY_KEY_CUT = 2;

const DEVICE_MSG_TYPE_CLIPBOARD = 0;
const DEVICE_MSG_TYPE_ACK_CLIPBOARD = 1;
const DEVICE_MSG_TYPE_UHID_OUTPUT = 2;

const SC_CONTROL_MSG_MAX_SIZE = 1 << 18;
const CLIPBOARD_TEXT_MAX_LENGTH = SC_CONTROL_MSG_MAX_SIZE - 14;
const SCAN_FILE_PATH_MAX_LENGTH = 256;

function encodeGetClipboard(copyKey = SC_COPY_KEY_NONE) {
    const key = Number(copyKey);
    const buffer = Buffer.alloc(2);
    buffer.writeUInt8(SC_CONTROL_MSG_TYPE_GET_CLIPBOARD, 0);
    buffer.writeUInt8(
        key === SC_COPY_KEY_CUT ? SC_COPY_KEY_CUT : key === SC_COPY_KEY_COPY ? SC_COPY_KEY_COPY : SC_COPY_KEY_NONE,
        1
    );
    return buffer;
}

function encodeSetClipboard(text, { paste = false, sequence = 0n } = {}) {
    const utf8 = Buffer.from(String(text ?? ""), "utf8");
    const slice = utf8.length > CLIPBOARD_TEXT_MAX_LENGTH
        ? utf8.subarray(0, CLIPBOARD_TEXT_MAX_LENGTH)
        : utf8;
    const buffer = Buffer.alloc(14 + slice.length);
    buffer.writeUInt8(SC_CONTROL_MSG_TYPE_SET_CLIPBOARD, 0);
    buffer.writeBigUInt64BE(typeof sequence === "bigint" ? sequence : BigInt(sequence || 0), 1);
    buffer.writeUInt8(paste ? 1 : 0, 9);
    buffer.writeUInt32BE(slice.length, 10);
    slice.copy(buffer, 14);
    return buffer;
}

function encodeScanFile(remotePath) {
    const utf8 = Buffer.from(String(remotePath ?? ""), "utf8");
    const slice = utf8.length > SCAN_FILE_PATH_MAX_LENGTH
        ? utf8.subarray(0, SCAN_FILE_PATH_MAX_LENGTH)
        : utf8;
    const buffer = Buffer.alloc(5 + slice.length);
    buffer.writeUInt8(SC_CONTROL_MSG_TYPE_SCAN_FILE, 0);
    buffer.writeUInt32BE(slice.length, 1);
    slice.copy(buffer, 5);
    return buffer;
}

/**
 * @param {Buffer} buffer
 * @returns {{ consumed: number, messages: Array<{ type: string, text?: string, sequence?: bigint }> }}
 */
function consumeDeviceMessages(buffer) {
    const messages = [];
    let offset = 0;

    while (offset < buffer.length) {
        const remaining = buffer.subarray(offset);
        if (remaining.length < 1) break;

        const type = remaining[0];
        if (type === DEVICE_MSG_TYPE_CLIPBOARD) {
            if (remaining.length < 5) break;
            const textLen = remaining.readUInt32BE(1);
            if (remaining.length < 5 + textLen) break;
            messages.push({
                type: "clipboard",
                text: remaining.subarray(5, 5 + textLen).toString("utf8")
            });
            offset += 5 + textLen;
            continue;
        }

        if (type === DEVICE_MSG_TYPE_ACK_CLIPBOARD) {
            if (remaining.length < 9) break;
            messages.push({
                type: "ack-clipboard",
                sequence: remaining.readBigUInt64BE(1)
            });
            offset += 9;
            continue;
        }

        if (type === DEVICE_MSG_TYPE_UHID_OUTPUT) {
            if (remaining.length < 5) break;
            const size = remaining.readUInt16BE(3);
            if (remaining.length < 5 + size) break;
            offset += 5 + size;
            continue;
        }

        // Type inconnu : on abandonne le reste pour ne pas boucler.
        offset = buffer.length;
        break;
    }

    return {
        consumed: offset,
        messages
    };
}

module.exports = {
    SC_COPY_KEY_NONE,
    SC_COPY_KEY_COPY,
    SC_COPY_KEY_CUT,
    encodeGetClipboard,
    encodeSetClipboard,
    encodeScanFile,
    consumeDeviceMessages
};
