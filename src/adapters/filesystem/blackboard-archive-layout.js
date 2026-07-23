const fs = require("fs");
const path = require("path");

const CURRENT_ARCHIVE_LAYOUT_VERSION = 2;
const ARCHIVE_DIRECTORIES = Object.freeze({
  courseOutline: "00_Course_Outline",
  courseContents: "01_Course_Contents",
  announcements: "02_Announcements",
  calendar: "03_Calendar",
  discussions: "04_Discussions",
  messages: "05_Messages",
  groups: "06_Groups",
  achievements: "07_Achievements",
  library: "08_Library",
});

const LEGACY_DIRECTORY_MAPPINGS = Object.freeze([
  ["02_Library", ARCHIVE_DIRECTORIES.library],
  ["03_Announcements", ARCHIVE_DIRECTORIES.announcements],
  ["04_Calendar", ARCHIVE_DIRECTORIES.calendar],
  ["05_Discussions", ARCHIVE_DIRECTORIES.discussions],
  ["06_Messages", ARCHIVE_DIRECTORIES.messages],
  ["07_Groups", ARCHIVE_DIRECTORIES.groups],
  ["08_Achievements", ARCHIVE_DIRECTORIES.achievements],
]);

const TOP_LEVEL_ALIASES = new Map([
  ["course outline", ARCHIVE_DIRECTORIES.courseOutline],
  ["course syllabus", ARCHIVE_DIRECTORIES.courseOutline],
  ["syllabus", ARCHIVE_DIRECTORIES.courseOutline],
  ["course content", ARCHIVE_DIRECTORIES.courseContents],
  ["course contents", ARCHIVE_DIRECTORIES.courseContents],
  ["content", ARCHIVE_DIRECTORIES.courseContents],
  ["contents", ARCHIVE_DIRECTORIES.courseContents],
  ["course library", ARCHIVE_DIRECTORIES.library],
  ["library", ARCHIVE_DIRECTORIES.library],
]);

function sanitizePart(name, fallback = "untitled", max = 150) {
  let value = String(name || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!value) value = fallback;
  if (value.length > max) value = value.slice(0, max).trim().replace(/[. ]+$/g, "");
  return value || fallback;
}

function normalizedTopLevelTitle(title) {
  return String(title || "")
    .normalize("NFKC")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function knownTopLevelDirectory(title) {
  return TOP_LEVEL_ALIASES.get(normalizedTopLevelTitle(title)) || null;
}

function relativeDirectoryForAncestors(ancestors) {
  if (!Array.isArray(ancestors) || ancestors.length === 0) {
    return ARCHIVE_DIRECTORIES.courseContents;
  }

  const [topLevel, ...rest] = ancestors;
  const knownDirectory = knownTopLevelDirectory(topLevel);
  const parts = knownDirectory
    ? [knownDirectory]
    : [ARCHIVE_DIRECTORIES.courseContents, sanitizePart(topLevel)];
  return path.join(...parts, ...rest.map((part) => sanitizePart(part)));
}

function relativeDirectoryForItem(ancestors, title, ownDirectory = false) {
  if (!Array.isArray(ancestors) || ancestors.length === 0) {
    const knownDirectory = knownTopLevelDirectory(title);
    if (knownDirectory) return knownDirectory;
    return ownDirectory
      ? path.join(ARCHIVE_DIRECTORIES.courseContents, sanitizePart(title))
      : ARCHIVE_DIRECTORIES.courseContents;
  }

  const base = relativeDirectoryForAncestors(ancestors);
  return ownDirectory ? path.join(base, sanitizePart(title)) : base;
}

function createArchiveLayout(outputRoot) {
  return {
    directoryForAncestors(ancestors) {
      return path.join(outputRoot, relativeDirectoryForAncestors(ancestors));
    },
    directoryForItem(ancestors, title, ownDirectory = false) {
      return path.join(outputRoot, relativeDirectoryForItem(ancestors, title, ownDirectory));
    },
  };
}

function uniqueMigrationPath(destination) {
  const parsed = path.parse(destination);
  for (let index = 2; ; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (legacy ${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function mergeMigratedPath(source, destination) {
  if (!fs.existsSync(destination)) {
    fs.renameSync(source, destination);
    return;
  }

  const sourceStat = fs.statSync(source);
  const destinationStat = fs.statSync(destination);
  if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) {
    fs.renameSync(source, uniqueMigrationPath(destination));
    return;
  }

  for (const entry of fs.readdirSync(source)) {
    mergeMigratedPath(path.join(source, entry), path.join(destination, entry));
  }
  fs.rmdirSync(source);
}

function migratedRelativePath(value) {
  if (typeof value !== "string") return value;
  const normalized = value.replace(/\\/g, "/");
  for (const [legacyDirectory, currentDirectory] of LEGACY_DIRECTORY_MAPPINGS) {
    if (normalized === legacyDirectory || normalized.startsWith(`${legacyDirectory}/`)) {
      return `${currentDirectory}${normalized.slice(legacyDirectory.length)}`;
    }
  }
  return value;
}

function migrateLegacyArchiveLayout(outputRoot, previousManifest) {
  if (!previousManifest || Number(previousManifest.archiveLayoutVersion || 1) >= CURRENT_ARCHIVE_LAYOUT_VERSION) {
    return [];
  }

  for (const download of previousManifest.downloads || []) {
    download.path = migratedRelativePath(download.path);
  }

  if (!fs.existsSync(outputRoot)) return [];
  const pending = LEGACY_DIRECTORY_MAPPINGS.filter(([legacyDirectory]) =>
    fs.existsSync(path.join(outputRoot, legacyDirectory))
  );
  if (pending.length === 0) return [];

  const stagingRoot = path.join(outputRoot, `.blackboard-layout-migration-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staged = [];
  try {
    for (const [legacyDirectory, currentDirectory] of pending) {
      const stagedPath = path.join(stagingRoot, legacyDirectory);
      fs.renameSync(path.join(outputRoot, legacyDirectory), stagedPath);
      staged.push({ legacyDirectory, currentDirectory, stagedPath });
    }
    for (const item of staged) {
      mergeMigratedPath(item.stagedPath, path.join(outputRoot, item.currentDirectory));
    }
    fs.rmdirSync(stagingRoot);
  } catch (error) {
    throw new Error(`Unable to migrate archive layout; preserved staged data at ${stagingRoot}: ${error.message}`);
  }

  return staged.map(({ legacyDirectory, currentDirectory }) => ({ from: legacyDirectory, to: currentDirectory }));
}

module.exports = {
  ARCHIVE_DIRECTORIES,
  CURRENT_ARCHIVE_LAYOUT_VERSION,
  createArchiveLayout,
  knownTopLevelDirectory,
  migrateLegacyArchiveLayout,
  normalizedTopLevelTitle,
  relativeDirectoryForAncestors,
  relativeDirectoryForItem,
  sanitizePart,
};
