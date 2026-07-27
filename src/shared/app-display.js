const GENERIC_APP_LABELS = new Set([
    "android app",
    "android application",
    "application",
    "applications",
    "app",
    "apps",
    "mobile app",
    "mobile application",
    "unknown",
    "null",
    "undefined",
    "test",
    "none",
    "n/a"
]);

const GENERIC_PACKAGE_SEGMENTS = new Set([
    "app",
    "apps",
    "android",
    "mobile",
    "client",
    "main",
    "lite",
    "prod",
    "application",
    "tv",
    "phone",
    "tablet"
]);

const PACKAGE_PREFIXES = new Set(["com", "org", "net", "io", "app", "dev", "me", "co", "fr", "de", "uk"]);

function looksLikePackageName(value) {
    if (!value || typeof value !== "string") return true;
    const trimmed = value.trim();
    if (!trimmed) return true;
    return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]+)+$/.test(trimmed);
}

function isGenericAppLabel(value) {
    if (!value || typeof value !== "string") return true;
    const trimmed = value.trim();
    if (!trimmed) return true;
    if (looksLikePackageName(trimmed)) return true;

    const normalized = trimmed.toLowerCase();
    if (GENERIC_APP_LABELS.has(normalized)) return true;
    if (/^android(\s+(app|application))?$/i.test(normalized)) return true;
    if (/^(mobile\s+)?(app|application)$/i.test(normalized)) return true;

    return false;
}

function titleCaseWords(text) {
    return String(text || "")
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
}

function humanizePackageName(packageName) {
    if (!packageName || typeof packageName !== "string") return "";

    let parts = packageName.split(".").filter(Boolean);
    if (parts.length === 0) return packageName;

    while (parts.length > 1 && PACKAGE_PREFIXES.has(parts[0].toLowerCase())) {
        parts.shift();
    }

    while (parts.length > 1 && GENERIC_PACKAGE_SEGMENTS.has(parts[parts.length - 1].toLowerCase())) {
        parts.pop();
    }

    if (parts.length === 0) {
        parts = packageName.split(".").filter(Boolean);
    }

    const meaningful = parts.filter((part) => !GENERIC_PACKAGE_SEGMENTS.has(part.toLowerCase()));
    const segments = (meaningful.length > 0 ? meaningful : parts).slice(-2);

    return titleCaseWords(
        segments
            .map((segment) => segment.replace(/[_-]+/g, " "))
            .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
            .join(" ")
    );
}

function normalizeLabelValue(value) {
    return String(value || "")
        .replace(/^'|'$/g, "")
        .replace(/\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}/gi, "")
        .trim();
}

function isUsableAppLabel(value) {
    const normalized = normalizeLabelValue(value);
    return normalized.length > 0 && !isGenericAppLabel(normalized);
}

function pickDisplayName(candidates, packageFallback = "") {
    const scored = [];

    for (const candidate of candidates) {
        const value = normalizeLabelValue(candidate);
        if (!isUsableAppLabel(value)) continue;
        scored.push(value);
    }

    if (scored.length > 0) {
        const unique = Array.from(new Set(scored));
        unique.sort((a, b) => b.length - a.length);
        return unique[0];
    }

    return humanizePackageName(packageFallback || candidates.find(Boolean) || "");
}

function extractLabelsFromDumpOutput(dumpOutput) {
    if (!dumpOutput) return [];

    const labels = [];
    const patterns = [
        /application-label(?:-[a-zA-Z0-9-]+)?:'([^']+)'/g,
        /applicationLabel=([^\n\r]+)/g,
        /nonLocalizedLabel=([^\n\r]+)/g,
        /android:label="([^"]+)"/g,
        /android:label='([^']+)'/g
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(dumpOutput)) !== null) {
            const value = normalizeLabelValue(match[1]);
            if (value) labels.push(value);
        }
    }

    return labels;
}

function extractLabelFromDumpOutput(dumpOutput) {
    const labels = extractLabelsFromDumpOutput(dumpOutput);
    return pickDisplayName(labels, "");
}

function buildAppLabel(app, siblings = []) {
    const baseName = pickDisplayName([app.displayName], app.package);
    if (!app.isDuplicate || siblings.length === 0) {
        return { labelName: baseName, variantType: "original", displayName: baseName };
    }

    const hasClone = siblings.some(
        (entry) => entry.package === app.package && entry.userId !== app.userId
    );
    const hasDifferentPackage = siblings.some(
        (entry) => entry.package !== app.package
    );

    if (hasClone) {
        const profilesForPackage = siblings
            .filter((entry) => entry.package === app.package)
            .map((entry) => entry.userId ?? 0);
        const primaryUserId = Math.min(...profilesForPackage);
        if ((app.userId ?? 0) > primaryUserId) {
            return { labelName: `${baseName} (clonée)`, variantType: "clone", displayName: baseName };
        }
        return { labelName: baseName, variantType: "original", displayName: baseName };
    }

    if (hasDifferentPackage) {
        const sorted = [...siblings].sort((a, b) => {
            const userDelta = (a.userId ?? 0) - (b.userId ?? 0);
            if (userDelta !== 0) return userDelta;
            return String(a.package).localeCompare(String(b.package));
        });
        if (sorted[0]?.appKey === app.appKey) {
            return { labelName: baseName, variantType: "original", displayName: baseName };
        }
        return { labelName: `${baseName} (dupliquée)`, variantType: "duplicate", displayName: baseName };
    }

    return { labelName: baseName, variantType: "original", displayName: baseName };
}

function getAppLabel(app = {}) {
    return app.labelName || app.displayName || humanizePackageName(app.package || "");
}

/**
 * Strip Type-B tab labels like "Device — App" (or nested "Device — Device — App")
 * down to the final app segment. Always take the part after the *last* separator.
 */
function extractAppNameFromTabLabel(tabLabel) {
    const raw = String(tabLabel || "").trim();
    if (!raw) return "";

    const separators = [" — ", " – ", " - "];
    let cut = -1;
    let sepLen = 0;
    for (const sep of separators) {
        const idx = raw.lastIndexOf(sep);
        if (idx > cut) {
            cut = idx;
            sepLen = sep.length;
        }
    }
    if (cut < 0) return "";
    return normalizeLabelValue(raw.slice(cut + sepLen));
}

function normalizeDeviceAliases(deviceLabel) {
    if (Array.isArray(deviceLabel)) {
        return deviceLabel.map((value) => normalizeLabelValue(value)).filter(Boolean);
    }
    const single = normalizeLabelValue(deviceLabel);
    return single ? [single] : [];
}

function matchesDeviceAlias(value, aliases) {
    const normalized = normalizeLabelValue(value).toLowerCase();
    if (!normalized) return false;
    return aliases.some((alias) => alias.toLowerCase() === normalized);
}

/**
 * Resolve a display label for launch-history entries.
 * Rejects device names and compound / nested tab labels accidentally stored as appName.
 */
function resolveHistoryAppName(entry = {}, deviceLabel = "") {
    const pkg = String(entry?.packageName || "").trim();
    const aliases = normalizeDeviceAliases(deviceLabel);
    let candidate = normalizeLabelValue(entry?.appName);

    const fromTab = extractAppNameFromTabLabel(candidate);
    if (fromTab) {
        candidate = fromTab;
    }

    // Nested leftovers can still equal the device name after a bad extract.
    if (matchesDeviceAlias(candidate, aliases)) {
        candidate = "";
    }

    if (isUsableAppLabel(candidate) && !matchesDeviceAlias(candidate, aliases)) {
        return candidate;
    }
    return humanizePackageName(pkg) || pkg || candidate || "";
}

const appDisplayApi = {
    GENERIC_APP_LABELS,
    looksLikePackageName,
    isGenericAppLabel,
    isUsableAppLabel,
    humanizePackageName,
    pickDisplayName,
    extractLabelsFromDumpOutput,
    extractLabelFromDumpOutput,
    buildAppLabel,
    getAppLabel,
    extractAppNameFromTabLabel,
    resolveHistoryAppName
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = appDisplayApi;
} else {
    globalThis.AppDisplay = appDisplayApi;
}
