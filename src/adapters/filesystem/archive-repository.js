const fs = require("fs");
const path = require("path");
const { httpError } = require("../../shared/http-error");
const { createArtifactClassifier } = require("../../domain/archive/archive-artifact");
const {
  fileCategory,
  fileExtension,
  mimeType,
  normalizeArchivePath,
  previewKind,
} = require("../../domain/archive/archive-metadata");
const { readJson } = require("./json-file-store");

function readText(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveFilesAtLocation(course, { root, realRoot }, relativePaths) {
  return relativePaths.map((relativePath) => {
    const normalized = normalizeArchivePath(relativePath).replace(/^\/+/, "");
    const candidate = path.resolve(root, normalized);
    if (!normalized || !isInside(root, candidate)) throw httpError(400, "Invalid archive file path");
    if (fs.existsSync(candidate)) {
      const realCandidate = fs.realpathSync.native(candidate);
      if (!isInside(realRoot || fs.realpathSync.native(root), realCandidate)) {
        throw httpError(400, "Archive file resolves outside the course directory");
      }
    }
    return { course, root, file: candidate, relativePath: normalized };
  });
}

function directorySize(directory) {
  let bytes = 0;
  let files = 0;
  if (!fs.existsSync(directory)) return { bytes, files };
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(fullPath).size;
          files += 1;
        } catch {}
      }
    }
  }
  return { bytes, files };
}

class FileSystemArchiveRepository {
  constructor({ archiveRoot }) {
    this.setRoot(archiveRoot);
  }

  setRoot(archiveRoot) {
    this.archiveRoot = path.resolve(archiveRoot);
  }

  matchesRoot(candidate) {
    return Boolean(candidate) && path.resolve(candidate) === this.archiveRoot;
  }

  inventoryFile() {
    return path.join(this.archiveRoot, "courses.json");
  }

  readInventory() {
    return readJson(this.inventoryFile(), null);
  }

  inventoryVersion() {
    try {
      const stat = fs.statSync(this.inventoryFile());
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "0:0";
    }
  }

  coursePath(course) {
    return this.courseLocation(course).root;
  }

  courseLocation(course) {
    const outputDirectory = normalizeArchivePath(course.outputDirectory);
    const candidate = path.resolve(this.archiveRoot, outputDirectory);
    const relative = path.relative(this.archiveRoot, candidate);
    if (!outputDirectory || !relative || !isInside(this.archiveRoot, candidate)) {
      throw new Error(`Unsafe or missing archive path for ${course.id}`);
    }
    let realRoot = null;
    if (fs.existsSync(candidate) && fs.existsSync(this.archiveRoot)) {
      // Native resolution avoids walking every path component through JavaScript,
      // which is especially expensive on network and WSL-mounted archives.
      const realArchive = fs.realpathSync.native(this.archiveRoot);
      realRoot = fs.realpathSync.native(candidate);
      if (!isInside(realArchive, realRoot)) throw new Error(`Unsafe or missing archive path for ${course.id}`);
    }
    return { root: candidate, realRoot };
  }

  courseExists(course) {
    return fs.existsSync(this.coursePath(course));
  }

  loadManifest(course) {
    return readJson(path.join(this.coursePath(course), "manifest.json"), null);
  }

  loadFailedManifest(course) {
    return readJson(path.join(this.coursePath(course), "manifest.failed.json"), null);
  }

  courseVersion(course) {
    const root = this.coursePath(course);
    let modified = 0;
    try {
      modified = fs.statSync(root).mtimeMs;
    } catch {}
    return `${modified}:${this.loadManifest(course)?.generatedAt || ""}`;
  }

  resolveCourseFile(course, relativePath) {
    return this.resolveCourseFiles(course, [relativePath])[0];
  }

  resolveCourseFiles(course, relativePaths) {
    return resolveFilesAtLocation(course, this.courseLocation(course), relativePaths);
  }

  scanCourseFiles(course, { includeSearchDocuments = false } = {}) {
    const root = this.coursePath(course);
    const classifyArtifact = createArtifactClassifier(this.loadManifest(course) || {});
    const files = [];
    const searchDocuments = {};
    let rootStat = null;
    try {
      rootStat = fs.statSync(root);
    } catch {}
    if (!rootStat?.isDirectory()) return { files, searchDocuments };
    const pending = [root];
    while (pending.length) {
      const current = pending.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (current === root && entry.name === ".fetch-history") continue;
          pending.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const stat = fs.statSync(fullPath);
          const relativePath = normalizeArchivePath(path.relative(root, fullPath));
          const artifact = classifyArtifact(relativePath);
          const file = {
            ...artifact,
            path: relativePath,
            name: entry.name,
            extension: fileExtension(entry.name),
            category: fileCategory(relativePath),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            mimeType: mimeType(entry.name),
            preview: previewKind(entry.name),
          };
          files.push(file);
          if (
            includeSearchDocuments &&
            file.searchable !== false &&
            ["text", "json", "link"].includes(file.preview) &&
            file.size <= 2_000_000
          ) {
            try {
              searchDocuments[relativePath] = fs.readFileSync(fullPath, "utf8");
            } catch {}
          }
        } catch {}
      }
    }
    const paths = new Set(files.map((file) => file.path));
    for (const file of files) {
      if (!paths.has(file.primaryPath)) file.primaryPath = file.path;
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { files, searchDocuments };
  }

  listCourseFiles(course) {
    return this.scanCourseFiles(course).files;
  }

  indexCourseFiles(course) {
    return this.scanCourseFiles(course, { includeSearchDocuments: true });
  }

  readCourseJson(course, candidates, fallback) {
    for (const relativePath of candidates) {
      const resolved = this.resolveCourseFile(course, relativePath);
      if (fs.existsSync(resolved.file)) return readJson(resolved.file, fallback);
    }
    return fallback;
  }

  readCourseText(course, relativePath, fallback = "") {
    const resolved = this.resolveCourseFile(course, relativePath);
    return readText(resolved.file, fallback);
  }

  loadAnnouncement(course, announcement) {
    return this.loadAnnouncements(course, [announcement])[0];
  }

  loadAnnouncements(course, announcements) {
    if (!announcements.length) return [];
    let location;
    try {
      // Share the checked boundary only within this synchronous batch, never
      // across requests. Every announcement target still gets its own check.
      location = this.courseLocation(course);
    } catch {
      return announcements.map((announcement) => ({ ...announcement, text: "", htmlPath: null }));
    }
    return announcements.map((announcement) => {
      if (!announcement.directory) return { ...announcement, text: "", htmlPath: null };
      try {
        const textPath = `${normalizeArchivePath(announcement.directory)}/announcement.txt`;
        const htmlPath = `${normalizeArchivePath(announcement.directory)}/announcement.html`;
        const [resolvedText, resolvedHtml] = resolveFilesAtLocation(course, location, [textPath, htmlPath]);
        return {
          ...announcement,
          text: readText(resolvedText.file, "").trim(),
          htmlPath: fs.existsSync(resolvedHtml.file) ? htmlPath : null,
        };
      } catch {
        return { ...announcement, text: "", htmlPath: null };
      }
    });
  }
}

module.exports = {
  FileSystemArchiveRepository,
  directorySize,
  isInside,
  readText,
};
