/**
 * Script de test isolé pour ScrcpySocketClient.
 *
 * Usage :
 *   node video/test-connection.js <serial>
 *
 * Exemple :
 *   node video/test-connection.js e176518f
 *
 * Ce script ne fait QUE vérifier qu'on arrive à se connecter au flux vidéo
 * et à recevoir des paquets. Il n'affiche rien, ne décode rien : il sert
 * uniquement à valider que le protocole de connexion fonctionne avant
 * d'aller plus loin.
 */

const path = require("path");
const { ScrcpySocketClient } = require("./scrcpy-socket");

const serial = process.argv[2];

if (!serial) {
    console.error("Usage: node video/test-connection.js <serial>");
    process.exit(1);
}

const adbPath = path.join(__dirname, "..", "..", "..", "tools", "adb.exe");
const serverJarPath = path.join(__dirname, "..", "..", "..", "tools", "scrcpy-server");

console.log("=== Test de connexion scrcpy-server ===");
console.log("adb path:", adbPath);
console.log("server jar path:", serverJarPath);
console.log("serial:", serial);
console.log("");

const client = new ScrcpySocketClient(adbPath, serial);

let packetCount = 0;
let totalBytes = 0;
let firstPacketTime = null;

client.on("connected", ({ deviceName }) => {
    console.log(`✅ Connecté ! Nom de l'appareil reçu: "${deviceName}"`);
    console.log("En attente des paquets vidéo...\n");
});

client.on("raw-packet", (packet) => {
    packetCount++;
    totalBytes += packet.data.length;

    if (!firstPacketTime) {
        firstPacketTime = Date.now();
    }

    const flags = [];
    if (packet.isConfig) flags.push("CONFIG");
    if (packet.isKeyFrame) flags.push("KEYFRAME");

    console.log(
        `Paquet #${packetCount} | taille=${packet.data.length} octets | pts=${packet.pts} | flags=[${flags.join(", ") || "none"}]`
    );

    // Affiche les 16 premiers octets en hexadécimal pour vérification visuelle
    const hexPreview = packet.data.slice(0, 16).toString("hex").match(/.{1,2}/g).join(" ");
    console.log(`   premiers octets: ${hexPreview}`);

    // Arrête le test après 20 paquets pour ne pas spammer la console
    if (packetCount >= 20) {
        console.log("\n=== 20 paquets reçus, arrêt du test ===");
        const elapsedSec = (Date.now() - firstPacketTime) / 1000;
        console.log(`Total reçu: ${totalBytes} octets en ${elapsedSec.toFixed(2)}s`);
        client.stop();
        process.exit(0);
    }
});

client.on("error", (err) => {
    console.error("❌ Erreur:", err.message);
    process.exit(1);
});

client.on("closed", () => {
    console.log("Connexion fermée.");
});

client.start(serverJarPath).catch((err) => {
    console.error("❌ Échec du démarrage:", err.message);
    process.exit(1);
});

// Sécurité : arrêt forcé après 20 secondes si rien ne se passe
setTimeout(() => {
    console.error("❌ Timeout global : rien reçu après 20 secondes.");
    client.stop();
    process.exit(1);
}, 20000);
