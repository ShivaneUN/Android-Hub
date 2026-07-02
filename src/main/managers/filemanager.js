const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "../data.json");

function save(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function load() {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath));
}

module.exports = { save, load };