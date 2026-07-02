const { exec } = require("child_process");
const path = require("path");

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

class DeviceManager {
    constructor(adbPath) {
        this.adbPath = adbPath;
    }

    async getUserIds(serial) {
        try {
            const stdout = await execPromise(`"${this.adbPath}" -s ${serial} shell pm list users`);
            const ids = [];
            const regex = /UserInfo\{(\d+):/g;
            let match;
            while ((match = regex.exec(stdout)) !== null) {
                ids.push(Number(match[1]));
            }

            if (ids.length > 0) {
                return Array.from(new Set(ids)).sort((a, b) => a - b);
            }
        } catch (err) {
            // Fallback vers l'utilisateur principal si la commande n'est pas supportée.
        }

        return [0];
    }

    async getInstalledPackagesByUser(serial, userId) {
        const stdout = await execPromise(`"${this.adbPath}" -s ${serial} shell pm list packages -3 --user ${userId}`);
        return stdout.split("\n")
            .map(l => l.replace("package:", "").trim())
            .filter(l => l !== "")
            .map(pkg => ({ package: pkg, userId }));
    }

    async getConnectedDevices() {
        const stdout = await execPromise(`"${this.adbPath}" devices -l`);
        const lines = stdout.split("\n").slice(1).filter(l => l.trim() !== "");
        
        const devices = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            const serial = parts[0];
            const state = parts[1];
            let status = "orange";
            if (state === "device") status = "green";
            else if (state === "offline" || state === "unauthorized") status = "red";
            
            const modelMatch = line.match(/model:(\S+)/);
            const name = modelMatch ? modelMatch[1].replace(/_/g, " ") : serial;
            
            return {
                serial,
                status,
                name,
                connected: true
            };
        });

        return devices;
    }

    async getInstalledApps(serial) {
        // Récupérer la liste des packages sur tous les profils/utilisateurs Android.
        const userIds = await this.getUserIds(serial);
        const packagesByUser = await Promise.all(
            userIds.map(async (userId) => {
                try {
                    return await this.getInstalledPackagesByUser(serial, userId);
                } catch (err) {
                    return [];
                }
            })
        );
        const packages = packagesByUser.flat().map((entry) => entry.package);
        
        // Retourner un tableau simple de strings pour compatibilité
        return packages;
    }

    async getInstalledAppsWithDetails(serial) {
        // Récupérer les apps sur tous les profils/utilisateurs Android (inclut les apps clonées).
        const userIds = await this.getUserIds(serial);
        const packagesByUser = await Promise.all(
            userIds.map(async (userId) => {
                try {
                    return await this.getInstalledPackagesByUser(serial, userId);
                } catch (err) {
                    return [];
                }
            })
        );
        const packages = packagesByUser.flat();

        // Pour chaque package, récupérer le nom d'affichage de l'application.
        const appsWithNames = await Promise.all(
            packages.map(async ({ package: pkg, userId }) => {
                try {
                    // Timeout de 2 secondes par package pour éviter les blocages
                    const dumpOutput = await Promise.race([
                        execPromise(`"${this.adbPath}" -s ${serial} shell dumpsys package ${pkg}`),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
                    ]);
                    
                    const versionNameMatch = dumpOutput.match(/versionName=([^\s]+)/);
                    const labelMatchers = [
                        /applicationLabel=([^\n]+)/,
                        /application-label(?:-[a-zA-Z-]+)?:'([^']+)'/,
                        /nonLocalizedLabel=([^\n]+)/
                    ];

                    let displayName = pkg;
                    for (const matcher of labelMatchers) {
                        const match = dumpOutput.match(matcher);
                        if (match && match[1] && match[1].trim()) {
                            displayName = match[1].trim();
                            break;
                        }
                    }

                    return {
                        package: pkg,
                        userId,
                        appKey: `${pkg}@@${userId}`,
                        displayName: displayName,
                        versionName: versionNameMatch ? versionNameMatch[1].trim() : null
                    };
                } catch (err) {
                    // En cas d'erreur, utiliser le nom de package comme nom d'affichage
                    return {
                        package: pkg,
                        userId,
                        appKey: `${pkg}@@${userId}`,
                        displayName: pkg,
                        versionName: null
                    };
                }
            })
        );

        // Dédupliquer par nom d'affichage (garder tous les packages distincts)
        const seenNames = new Map(); // displayName -> array of packages
        appsWithNames.forEach(app => {
            if (!seenNames.has(app.displayName)) {
                seenNames.set(app.displayName, []);
            }
            seenNames.get(app.displayName).push(app);
        });

        // Formater la sortie : marquer les doublons
        return appsWithNames.map(app => ({
            package: app.package,
            userId: app.userId,
            appKey: app.appKey,
            displayName: app.displayName,
            isDuplicate: seenNames.get(app.displayName).length > 1,
            duplicates: seenNames.get(app.displayName).map(a => ({
                package: a.package,
                userId: a.userId,
                appKey: a.appKey
            }))
        }));
    }

    async getDeviceInfo(serial) {
        const [sizeOutput, androidVersion] = await Promise.all([
            execPromise(`"${this.adbPath}" -s ${serial} shell wm size`),
            execPromise(`"${this.adbPath}" -s ${serial} shell getprop ro.build.version.release`)
        ]);

        const sizeMatch = sizeOutput.match(/Physical size:\s*(\d+)x(\d+)/i);
        if (!sizeMatch) {
            throw new Error(`Impossible de lire la résolution de l'appareil : ${sizeOutput}`);
        }

        return {
            width: Number(sizeMatch[1]),
            height: Number(sizeMatch[2]),
            androidVersion: androidVersion || "unknown"
        };
    }
}

module.exports = { DeviceManager };