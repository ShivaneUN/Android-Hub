/** Palette de couleurs par appareil — 10 teintes visuellement distinctes. */
const DEVICE_COLORS = Object.freeze([
    { id: 0, hex: "#E74C3C", name: "Rouge", key: "red" },
    { id: 1, hex: "#E67E22", name: "Orange", key: "orange" },
    { id: 2, hex: "#F1C40F", name: "Jaune", key: "yellow" },
    { id: 3, hex: "#2ECC71", name: "Vert", key: "green" },
    { id: 4, hex: "#1ABC9C", name: "Turquoise", key: "teal" },
    { id: 5, hex: "#3498DB", name: "Bleu", key: "blue" },
    { id: 6, hex: "#9B59B6", name: "Violet", key: "purple" },
    { id: 7, hex: "#E91E63", name: "Rose", key: "pink" },
    { id: 8, hex: "#795548", name: "Marron", key: "brown" },
    { id: 9, hex: "#607D8B", name: "Ardoise", key: "slate" }
]);

const DEVICE_COLOR_BY_ID = Object.freeze(
    Object.fromEntries(DEVICE_COLORS.map((color) => [color.id, color]))
);

function getDeviceColorById(colorId) {
    return DEVICE_COLOR_BY_ID[colorId] || DEVICE_COLORS[0];
}

function isValidDeviceColorId(colorId) {
    return Number.isInteger(colorId) && colorId >= 0 && colorId < DEVICE_COLORS.length;
}

const api = {
    DEVICE_COLORS,
    DEVICE_COLOR_BY_ID,
    getDeviceColorById,
    isValidDeviceColorId
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
} else {
    globalThis.DeviceColors = api;
}
