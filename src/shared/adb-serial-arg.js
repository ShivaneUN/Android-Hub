/**
 * Quote un serial ADB pour les commandes shell (`-s`, `connect`, `disconnect`).
 * Gère les serials WiFi (`ip:port`) et les caractères spéciaux Windows.
 */
function adbSerialArg(serial) {
    return `"${String(serial ?? "").replace(/"/g, '\\"')}"`;
}

module.exports = { adbSerialArg };
