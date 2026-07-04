/** Palette de couleurs par appareil — 10 teintes visuellement distinctes. */
const DEVICE_COLORS = Object.freeze([
    { id: 0, hex: "#E74C3C", name: "Rouge" },
    { id: 1, hex: "#E67E22", name: "Orange" },
    { id: 2, hex: "#F1C40F", name: "Jaune" },
    { id: 3, hex: "#2ECC71", name: "Vert" },
    { id: 4, hex: "#1ABC9C", name: "Turquoise" },
    { id: 5, hex: "#3498DB", name: "Bleu" },
    { id: 6, hex: "#9B59B6", name: "Violet" },
    { id: 7, hex: "#E91E63", name: "Rose" },
    { id: 8, hex: "#795548", name: "Marron" },
    { id: 9, hex: "#607D8B", name: "Ardoise" }
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

module.exports = {
    DEVICE_COLORS,
    DEVICE_COLOR_BY_ID,
    getDeviceColorById,
    isValidDeviceColorId
};
