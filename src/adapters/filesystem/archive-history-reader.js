const fs = require("fs");
const path = require("path");
const { httpError } = require("../../shared/http-error");

const HISTORY_LIMITS = Object.freeze({
  directoryEntries: 1000,
  runs: 100,
  files: 2000,
  journalBytes: 2 * 1024 * 1024,
  listBytes: 8 * 1024 * 1024,
});

function validRunId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function validRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\\\x00-\x1f\x7f:]/.test(value) &&
    value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function dateValue(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// History never follows symlinks, even to another location inside the course.
// Check every component again on each request so a replaced link is not cached.
function inspectHistoryPath(root, relativePath) {
  if (!validRelativePath(relativePath) || relativePath.split("/")[0] !== ".fetch-history") {
    return { status: "unsafe" };
  }
  let candidate = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      return { status: error.code === "ENOENT" ? "missing" : "unsafe" };
    }
    if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) {
      return { status: "unsafe" };
    }
    if (index === segments.length - 1) return { status: "available", file: candidate, stat };
  }
  return { status: "unsafe" };
}

function resolveHistoryFile(root, relativePath) {
  const inspected = inspectHistoryPath(root, relativePath);
  if (inspected.status === "missing") throw httpError(404, "Backup file not found");
  if (inspected.status !== "available" || !inspected.stat.isFile()) {
    throw httpError(400, "Unsafe backup file path");
  }
  return inspected.file;
}

function emptyRun(id, warning) {
  return { id, createdAt: null, fileCount: 0, totalBytes: 0, status: "unreadable", warnings: [warning], truncated: false, files: [] };
}

function readJournal(root, id, budget) {
  const checked = inspectHistoryPath(root, `.fetch-history/${id}/index.json`);
  if (checked.status !== "available" || !checked.stat.isFile()) {
    return { error: "The backup journal is missing, unreadable, or uses a symbolic link." };
  }
  if (checked.stat.size > HISTORY_LIMITS.journalBytes) {
    return { error: "The backup journal exceeds the 2 MiB display limit.", truncated: true };
  }
  if (checked.stat.size > budget.remaining) {
    return { error: "The history list reached its read limit. Open this run to inspect its journal.", truncated: true };
  }
  budget.remaining -= checked.stat.size;
  let descriptor;
  try {
    descriptor = fs.openSync(checked.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== checked.stat.size || opened.ino !== checked.stat.ino || opened.dev !== checked.stat.dev) {
      return { error: "The backup journal changed while it was being opened. Try again." };
    }
    // Read only the checked size, even if another process starts growing the file.
    const buffer = Buffer.alloc(opened.size);
    let position = 0;
    while (position < buffer.length) {
      const count = fs.readSync(descriptor, buffer, position, buffer.length - position, position);
      if (!count) return { error: "The backup journal changed while it was being read. Try again." };
      position += count;
    }
    const journal = JSON.parse(buffer.toString("utf8"));
    if (!journal || journal.schemaVersion !== 1 || !dateValue(journal.createdAt) || !Array.isArray(journal.files)) {
      return { error: "The backup journal has an unsupported or invalid format." };
    }
    return { journal };
  } catch {
    return { error: "The backup journal could not be read as valid JSON." };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readRun(root, id, { includeFiles = false, budget = { remaining: HISTORY_LIMITS.journalBytes } } = {}) {
  const result = readJournal(root, id, budget);
  if (result.error) return { ...emptyRun(id, result.error), truncated: Boolean(result.truncated) };
  const { journal } = result;
  const warnings = new Set();
  const files = [];
  const paths = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  const truncated = journal.files.length > HISTORY_LIMITS.files;
  if (truncated) warnings.add(`Only the first ${HISTORY_LIMITS.files.toLocaleString("en-US")} journal records are shown and counted.`);
  for (const entry of journal.files.slice(0, HISTORY_LIMITS.files)) {
    if (!entry || !validRelativePath(entry.path) || entry.path.split("/")[0].toLowerCase() === ".fetch-history" ||
      entry.backupPath !== `files/${entry.path}` || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      !Number.isSafeInteger(totalBytes + entry.size) || typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256) || !dateValue(entry.preservedAt)) {
      warnings.add("Invalid journal records were omitted.");
      continue;
    }
    if (paths.has(entry.path)) {
      warnings.add("Duplicate journal records were omitted.");
      continue;
    }
    paths.add(entry.path);
    fileCount += 1;
    totalBytes += entry.size;
    if (!includeFiles) continue;
    const backupPath = `.fetch-history/${id}/${entry.backupPath}`;
    const checked = inspectHistoryPath(root, backupPath);
    const status = checked.status !== "available" ? checked.status
      : !checked.stat.isFile() ? "unsafe"
        : checked.stat.size !== entry.size ? "changed" : "available";
    if (status !== "available") warnings.add("Some backup files are missing, unsafe, or no longer match their recorded size.");
    files.push({
      path: entry.path,
      backupPath: ["available", "changed"].includes(status) ? backupPath : null,
      size: entry.size,
      sha256: entry.sha256.toLowerCase(),
      preservedAt: dateValue(entry.preservedAt),
      status,
    });
  }
  return {
    id, createdAt: dateValue(journal.createdAt), fileCount, totalBytes,
    status: warnings.size ? "warning" : "available", warnings: [...warnings], truncated,
    ...(includeFiles ? { files } : {}),
  };
}

function listArchiveHistory({ root }) {
  const history = inspectHistoryPath(root, ".fetch-history");
  if (history.status === "missing") return { runs: [], truncated: false, warnings: [] };
  if (history.status !== "available" || !history.stat.isDirectory()) {
    return { runs: [], truncated: false, warnings: ["The backup history directory is unreadable or uses a symbolic link."] };
  }
  const ids = [];
  const warnings = [];
  let truncated = false;
  let directory;
  try {
    directory = fs.opendirSync(history.file);
    let count = 0;
    let entry;
    while ((entry = directory.readSync())) {
      count += 1;
      if (count > HISTORY_LIMITS.directoryEntries) {
        truncated = true;
        warnings.push("Only the first 1,000 history directory entries were inspected.");
        break;
      }
      if (!validRunId(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        warnings.push("Symbolic links in backup history were omitted.");
        continue;
      }
      if (entry.isDirectory()) ids.push(entry.name);
    }
  } catch {
    warnings.push("Some backup history entries could not be read.");
  } finally {
    if (directory) directory.closeSync();
  }
  ids.sort((left, right) => right.localeCompare(left));
  if (ids.length > HISTORY_LIMITS.runs) {
    truncated = true;
    warnings.push("Only the newest 100 run names in the inspected entries are shown.");
  }
  const budget = { remaining: HISTORY_LIMITS.listBytes };
  const runs = ids.slice(0, HISTORY_LIMITS.runs).map((id) => {
    const run = readRun(root, id, { budget });
    const { files: _files, ...summary } = run;
    if (run.truncated) truncated = true;
    return summary;
  });
  runs.sort((left, right) => String(right.createdAt || right.id).localeCompare(String(left.createdAt || left.id)));
  return { runs, truncated, warnings: [...new Set(warnings)] };
}

function readArchiveHistoryRun({ root }, runId) {
  if (!validRunId(runId)) throw httpError(400, "Invalid backup run identifier");
  const run = inspectHistoryPath(root, `.fetch-history/${runId}`);
  if (run.status === "missing") throw httpError(404, "Backup run not found");
  if (run.status !== "available" || !run.stat.isDirectory()) throw httpError(400, "Unsafe backup run path");
  return readRun(root, runId, { includeFiles: true });
}

module.exports = { HISTORY_LIMITS, listArchiveHistory, readArchiveHistoryRun, resolveHistoryFile };
