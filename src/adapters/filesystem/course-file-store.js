const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sanitizePart } = require("./blackboard-archive-layout");

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function createCourseFileStore({ cwd = process.cwd(), outputRoot }) {
  if (!outputRoot) throw new TypeError("createCourseFileStore requires outputRoot");
  const root = path.resolve(outputRoot);
  const workingDirectory = path.resolve(cwd);

  function containmentError(candidate) {
    return new Error(`Refusing to access ${candidate} outside the course output root ${root}`);
  }

  function lexicalPath(value) {
    const candidate = path.resolve(value);
    if (!isContained(root, candidate)) throw containmentError(candidate);
    return candidate;
  }

  function existingAncestor(value) {
    let candidate = value;
    while (!fs.existsSync(candidate)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
    return candidate;
  }

  function assertRealContainment(value) {
    const candidate = lexicalPath(value);
    if (!fs.existsSync(root)) return candidate;
    const ancestor = existingAncestor(candidate);
    if (!ancestor) throw containmentError(candidate);
    const realRoot = fs.realpathSync(root);
    const realAncestor = fs.realpathSync(ancestor);
    if (!isContained(realRoot, realAncestor)) throw containmentError(candidate);
    return candidate;
  }

  function ensureDirectory(directory) {
    const candidate = lexicalPath(directory);
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    assertRealContainment(candidate);
    fs.mkdirSync(candidate, { recursive: true });
    assertRealContainment(candidate);
    return candidate;
  }

  function preferredPath(directory, filename) {
    const containedDirectory = ensureDirectory(directory);
    return assertRealContainment(path.join(containedDirectory, sanitizePart(filename, "file")));
  }

  function uniquePath(directory, filename, reservedPaths = null) {
    const containedDirectory = ensureDirectory(directory);
    const parsed = path.parse(sanitizePart(filename, "file"));
    let candidate = assertRealContainment(path.join(containedDirectory, parsed.base));
    let index = 2;
    while (fs.existsSync(candidate) || reservedPaths?.has(candidate)) {
      candidate = assertRealContainment(
        path.join(containedDirectory, `${parsed.name} (${index})${parsed.ext}`)
      );
      index += 1;
    }
    return candidate;
  }

  function containedExistingFile(file) {
    const candidate = assertRealContainment(file);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
    return candidate;
  }

  function hashFile(file) {
    const candidate = containedExistingFile(file);
    if (!candidate) throw new Error(`Missing course file ${lexicalPath(file)}`);
    const hash = crypto.createHash("sha256");
    const descriptor = fs.openSync(candidate, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytesRead;
      do {
        bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(descriptor);
    }
    return hash.digest("hex");
  }

  function fileSize(file) {
    const candidate = containedExistingFile(file);
    if (!candidate) throw new Error(`Missing course file ${lexicalPath(file)}`);
    return fs.statSync(candidate).size;
  }

  function versionPaths(directory, filename) {
    const containedDirectory = assertRealContainment(directory);
    if (!fs.existsSync(containedDirectory)) return [];
    const parsed = path.parse(sanitizePart(filename, "file"));
    const escapedName = parsed.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedExtension = parsed.ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escapedName}(?: \\(\\d+\\))?${escapedExtension}$`);
    return fs
      .readdirSync(containedDirectory)
      .filter((entry) => pattern.test(entry))
      .map((entry) => path.join(containedDirectory, entry));
  }

  function findIdenticalFile(directory, filename, size, hash) {
    for (const candidate of versionPaths(directory, filename)) {
      try {
        if (fileSize(candidate) !== size) continue;
        if (hashFile(candidate) === hash) return candidate;
      } catch {}
    }
    return null;
  }

  function placeTemporaryFile(temporaryPath, directory, filename) {
    const temporary = containedExistingFile(temporaryPath);
    if (!temporary) throw new Error(`Missing temporary course file ${lexicalPath(temporaryPath)}`);
    const preferred = preferredPath(directory, filename);
    const output = fs.existsSync(preferred) ? uniquePath(directory, filename) : preferred;
    fs.renameSync(temporary, output);
    return output;
  }

  function previousLocalPath(record) {
    if (!record?.path) return null;
    try {
      const candidate = lexicalPath(path.resolve(root, record.path));
      return containedExistingFile(candidate);
    } catch {
      return null;
    }
  }

  function removeFile(file) {
    const candidate = assertRealContainment(file);
    fs.rmSync(candidate, { force: true });
  }

  function writeText(file, text) {
    const candidate = lexicalPath(file);
    ensureDirectory(path.dirname(candidate));
    assertRealContainment(candidate);
    fs.writeFileSync(candidate, text, "utf8");
  }

  function relativePath(file) {
    return path.relative(root, lexicalPath(file));
  }

  function displayPath(file) {
    return path.relative(workingDirectory, lexicalPath(file));
  }

  return {
    baseName: (file) => path.basename(file),
    displayPath,
    ensureDirectory,
    fileSize,
    findIdenticalFile,
    hashFile,
    outputRoot: root,
    placeTemporaryFile,
    preferredPath,
    previousLocalPath,
    relativePath,
    removeFile,
    uniquePath,
    writeText,
  };
}

module.exports = { createCourseFileStore };
