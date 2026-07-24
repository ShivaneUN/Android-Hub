const fs = require("fs");
const path = require("path");
const { dialog, BrowserWindow } = require("electron");
const { wallpaperUrl } = require("../hub-wallpaper-protocol");

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);

class HubWallpaperManager {
    constructor(userDataPath) {
        this.dir = path.join(userDataPath, "hub-wallpaper");
        this.metaPath = path.join(this.dir, "meta.json");
        this._ensureDir();
        this.meta = this._loadMeta();
    }

    _ensureDir() {
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }
    }

    _loadMeta() {
        try {
            if (!fs.existsSync(this.metaPath)) return { fileName: null, storedName: null, revision: 0 };
            const parsed = JSON.parse(fs.readFileSync(this.metaPath, "utf-8"));
            return {
                fileName: typeof parsed?.fileName === "string" ? parsed.fileName : null,
                storedName: typeof parsed?.storedName === "string" ? parsed.storedName : null,
                revision: Number(parsed?.revision) || 0
            };
        } catch {
            return { fileName: null, storedName: null, revision: 0 };
        }
    }

    _saveMeta() {
        this._ensureDir();
        fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2), "utf-8");
    }

    getStoredPath() {
        if (!this.meta.storedName) return null;
        const full = path.join(this.dir, this.meta.storedName);
        return fs.existsSync(full) ? full : null;
    }

    getState() {
        const filePath = this.getStoredPath();
        const active = Boolean(filePath);
        return {
            active,
            fileName: active ? this.meta.fileName : null,
            url: active ? wallpaperUrl(this.meta.revision || Date.now()) : null
        };
    }

    clear() {
        try {
            const current = this.getStoredPath();
            if (current) fs.unlinkSync(current);
        } catch (_err) {
            /* ignore */
        }
        this.meta = { fileName: null, storedName: null, revision: Date.now() };
        this._saveMeta();
        return this.getState();
    }

    async pickFromDialog(parentWindow = null) {
        const win = parentWindow && !parentWindow.isDestroyed()
            ? parentWindow
            : BrowserWindow.getFocusedWindow();

        const result = await dialog.showOpenDialog(win || undefined, {
            title: "Choisir une image de fond",
            properties: ["openFile"],
            filters: [
                { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] },
                { name: "Tous les fichiers", extensions: ["*"] }
            ]
        });

        if (result.canceled || !result.filePaths?.[0]) {
            return { success: false, canceled: true, ...this.getState() };
        }

        return this.importFile(result.filePaths[0]);
    }

    importFile(sourcePath) {
        const resolved = path.resolve(sourcePath);
        if (!fs.existsSync(resolved)) {
            return { success: false, error: "file-missing", ...this.getState() };
        }

        const ext = path.extname(resolved).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) {
            return { success: false, error: "invalid-type", ...this.getState() };
        }

        let stat;
        try {
            stat = fs.statSync(resolved);
        } catch {
            return { success: false, error: "file-unreadable", ...this.getState() };
        }

        if (!stat.isFile() || stat.size <= 0) {
            return { success: false, error: "invalid-file", ...this.getState() };
        }
        if (stat.size > MAX_BYTES) {
            return { success: false, error: "file-too-large", ...this.getState() };
        }

        this._ensureDir();
        const previous = this.getStoredPath();
        const storedName = `wallpaper${ext}`;
        const dest = path.join(this.dir, storedName);

        try {
            fs.copyFileSync(resolved, dest);
        } catch {
            return { success: false, error: "copy-failed", ...this.getState() };
        }

        if (previous && previous !== dest) {
            try {
                fs.unlinkSync(previous);
            } catch (_err) {
                /* ignore */
            }
        }

        this.meta = {
            fileName: path.basename(resolved),
            storedName,
            revision: Date.now()
        };
        this._saveMeta();

        return { success: true, ...this.getState() };
    }
}

module.exports = { HubWallpaperManager, MAX_BYTES };
