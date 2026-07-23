const fs = require("fs");
const path = require("path");

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDirectory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

module.exports = { ensureDirectory, readJson, writeJson };
