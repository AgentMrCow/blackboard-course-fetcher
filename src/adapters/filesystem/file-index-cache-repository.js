const path = require("path");
const { currentArchiveSignature } = require("./archive-signature");
const { readJson } = require("./json-file-store");

class FileIndexCacheRepository {
  constructor({ file, readJsonImpl = readJson, signatureImpl = currentArchiveSignature }) {
    if (!file) throw new TypeError("FileIndexCacheRepository requires a file");
    this.file = path.resolve(file);
    this.readJson = readJsonImpl;
    this.signature = signatureImpl;
  }

  load({ archiveRoot }) {
    if (!archiveRoot) return null;
    const root = path.resolve(archiveRoot);
    const index = this.readJson(this.file, null);
    if (!index || index.schemaVersion !== 3 || path.resolve(index.archiveRoot || "") !== root) return null;
    const inventoryGeneratedAt = this.readJson(path.join(root, "courses.json"), {})?.generatedAt || null;
    if ((index.inventoryGeneratedAt || null) !== inventoryGeneratedAt) return null;
    if ((index.archiveSignature || "") !== this.signature(root)) return null;
    return index;
  }
}

module.exports = { FileIndexCacheRepository };
