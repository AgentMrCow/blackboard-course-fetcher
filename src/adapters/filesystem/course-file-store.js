const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sanitizePart } = require("./blackboard-archive-layout");

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function createCourseFileStore({ cwd = process.cwd(), outputRoot, preserveHistory = false }) {
  if (!outputRoot) throw new TypeError("createCourseFileStore requires outputRoot");
  const root = path.resolve(outputRoot);
  const workingDirectory = path.resolve(cwd);
  const historyRoot = path.join(root, ".fetch-history");
  const historyCreatedAt = new Date().toISOString();
  const historyDirectory = path.join(historyRoot, `${historyCreatedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`);
  const preserved = new Map();
  const pending = new Map();
  const originallyMissing = new Set();
  let historyInitialized = false;
  let historyIndexed = false;

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
    const realRoot = fs.realpathSync.native(root);
    const realAncestor = fs.realpathSync.native(ancestor);
    if (!isContained(realRoot, realAncestor)) throw containmentError(candidate);
    return candidate;
  }

  function statOrNull(file) {
    try {
      return fs.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function writablePath(value, allowHistory = false) {
    const candidate = lexicalPath(value);
    const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
    if (!allowHistory && segments[0]?.toLowerCase() === ".fetch-history") {
      throw new Error("The .fetch-history directory is reserved for original file backups");
    }
    let ancestor = root;
    for (const segment of segments) {
      ancestor = path.join(ancestor, segment);
      if (statOrNull(ancestor)?.isSymbolicLink()) {
        // Check containment first to retain the more useful error for escapes.
        assertRealContainment(ancestor);
        throw new Error(`Refusing to write through symbolic link ${ancestor}`);
      }
    }
    return assertRealContainment(candidate);
  }

  function ensureWritableDirectory(directory, allowHistory = false) {
    const candidate = lexicalPath(directory);
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    writablePath(candidate, allowHistory);
    fs.mkdirSync(candidate, { recursive: true });
    writablePath(candidate, allowHistory);
    return candidate;
  }

  function ensureDirectory(directory) {
    return ensureWritableDirectory(directory);
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
    writablePath(temporaryPath);
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
    const candidate = writablePath(file);
    fs.rmSync(candidate, { force: true });
  }

  function atomicWrite(file, buffer, allowHistory = false) {
    const candidate = writablePath(file, allowHistory);
    ensureWritableDirectory(path.dirname(candidate), allowHistory);
    const original = statOrNull(candidate);
    if (original && !original.isFile()) throw new Error(`Expected a regular course file ${candidate}`);
    const temporary = path.join(path.dirname(candidate), `.${path.basename(candidate)}.tmp-${crypto.randomUUID()}`);
    let descriptor;
    let created = false;
    try {
      descriptor = fs.openSync(temporary, "wx", original ? original.mode & 0o777 : 0o666);
      created = true;
      fs.writeFileSync(descriptor, buffer);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      writablePath(candidate, allowHistory);
      fs.renameSync(temporary, candidate);
      created = false;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (created) fs.unlinkSync(temporary);
    }
    return candidate;
  }

  function preserveFile(file) {
    const candidate = writablePath(file);
    if (!preserveHistory) return null;
    if (originallyMissing.has(candidate)) return null;
    const original = statOrNull(candidate);
    if (!original) {
      originallyMissing.add(candidate);
      return null;
    }
    if (!original.isFile()) throw new Error(`Expected a regular course file ${candidate}`);
    const relative = path.relative(root, candidate).split(path.sep).join("/");
    if (preserved.has(relative)) return preserved.get(relative);
    if (!historyInitialized) {
      ensureWritableDirectory(historyRoot, true);
      // A run directory must be new; never reopen or overwrite another run.
      fs.mkdirSync(historyDirectory);
      historyInitialized = true;
    }
    if (!pending.has(relative)) {
      const backupPath = `files/${relative}`;
      const backup = path.join(historyDirectory, ...backupPath.split("/"));
      ensureWritableDirectory(path.dirname(backup), true);
      writablePath(candidate);
      writablePath(backup, true);
      let backupCreated = false;
      try {
        fs.copyFileSync(candidate, backup, fs.constants.COPYFILE_EXCL);
        backupCreated = true;
        // Windows requires write access for FlushFileBuffers. A copied read-only
        // source must still allow its private backup to be flushed and cleaned up.
        fs.chmodSync(backup, (fs.statSync(backup).mode & 0o777) | 0o200);
        const descriptor = fs.openSync(backup, "r+");
        try {
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        pending.set(relative, {
          path: relative,
          backupPath,
          size: fs.statSync(backup).size,
          sha256: hashFile(backup),
          preservedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (backupCreated) {
          try {
            writablePath(backup, true);
            fs.unlinkSync(backup);
          } catch {}
        }
        throw error;
      }
    }
    // If journaling fails, the original remains untouched. Retain pending copies
    // so a retry can journal them without replacing the first saved bytes.
    const entries = [...preserved.values(), ...pending.values()];
    atomicWrite(path.join(historyDirectory, "index.json"), Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      createdAt: historyCreatedAt,
      files: entries,
    }, null, 2)}\n`), true);
    for (const [key, entry] of pending) preserved.set(key, entry);
    pending.clear();
    historyIndexed = true;
    return preserved.get(relative);
  }

  function writeBuffer(file, buffer) {
    const candidate = writablePath(file);
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const original = statOrNull(candidate);
    if (original && !original.isFile()) throw new Error(`Expected a regular course file ${candidate}`);
    if (original?.size === data.length && hashFile(candidate) === crypto.createHash("sha256").update(data).digest("hex")) {
      return candidate;
    }
    preserveFile(candidate);
    return atomicWrite(candidate, data);
  }

  function writeText(file, text) {
    return writeBuffer(file, Buffer.from(text, "utf8"));
  }

  function historyPath() {
    return historyIndexed ? path.relative(root, historyDirectory).split(path.sep).join("/") : null;
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
    historyPath,
    outputRoot: root,
    placeTemporaryFile,
    preferredPath,
    preserveFile,
    previousLocalPath,
    relativePath,
    removeFile,
    uniquePath,
    writeBuffer,
    writeText,
  };
}

module.exports = { createCourseFileStore };
