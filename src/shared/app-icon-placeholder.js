const MIN_ICON_FILE_BYTES = 1024;

const APP_ICON_PLACEHOLDER_SVG = `<svg class="hub-app-icon-placeholder" viewBox="0 0 24 24" aria-hidden="true" role="img"><rect x="3" y="3" width="18" height="18" rx="5" fill="#3d4f6f"/><rect x="7" y="7" width="4" height="4" rx="1" fill="#cbd5e1"/><rect x="13" y="7" width="4" height="4" rx="1" fill="#94a3b8"/><rect x="7" y="13" width="4" height="4" rx="1" fill="#94a3b8"/><rect x="13" y="13" width="4" height="4" rx="1" fill="#64748b"/></svg>`;

function isValidIconFileSize(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    try {
        const fs = require("fs");
        return fs.statSync(filePath).size >= MIN_ICON_FILE_BYTES;
    } catch (_err) {
        return false;
    }
}

function wrapNewInstanceAppIconPlaceholder() {
    return `<span class="new-instance-app-icon is-placeholder">${APP_ICON_PLACEHOLDER_SVG}</span>`;
}

function wrapTabAppIconPlaceholder() {
    return `<span class="tab-app-icon is-placeholder">${APP_ICON_PLACEHOLDER_SVG}</span>`;
}

const appIconPlaceholderApi = {
    MIN_ICON_FILE_BYTES,
    APP_ICON_PLACEHOLDER_SVG,
    isValidIconFileSize,
    wrapNewInstanceAppIconPlaceholder,
    wrapTabAppIconPlaceholder
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = appIconPlaceholderApi;
} else {
    globalThis.HubAppIconPlaceholder = appIconPlaceholderApi;
}
