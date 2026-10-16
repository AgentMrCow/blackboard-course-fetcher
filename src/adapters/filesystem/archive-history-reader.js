const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { httpError } = require("../../shared/http-error");
const { TEXT_EXTENSIONS } = require("../../domain/archive/archive-metadata");

const HISTORY_LIMITS = Object.freeze({
  directoryEntries: 1000, runs: 100, files: 2000, pageFiles: 100,
  journalBytes: 2 * 1024 * 1024, listBytes: 8 * 1024 * 1024,
  comparisonBytes: 2 * 1024 * 1024, textBytes: 128 * 1024,
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

// The existing synchronous file-resolution contract rechecks every component.
// History queries below use asynchronous I/O and cache only ancestors for one request.
function resolveHistoryFile(root, relativePath) {
  if (!validRelativePath(relativePath) || relativePath.split("/")[0] !== ".fetch-history") {
    throw httpError(400, "Unsafe backup file path");
  }
  let candidate = root;
  for (const [index, segment] of relativePath.split("/").entries()) {
    candidate = path.join(candidate, segment);
    let stat;
    try { stat = fs.lstatSync(candidate); } catch (error) {
      if (error.code === "ENOENT") throw httpError(404, "Backup file not found");
      throw httpError(400, "Unsafe backup file path");
    }
    const final = index === relativePath.split("/").length - 1;
    if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) {
      throw httpError(400, "Unsafe backup file path");
    }
  }
  return candidate;
}

function pathInspector(root) {
  const ancestors = new Map();
  let rootCheck;
  const checkRoot = () => fs.promises.realpath(root).then(
    (realRoot) => realRoot === root ? "available" : "unsafe",
    (error) => error.code === "ENOENT" ? "missing" : "unsafe",
  );
  return async function inspect(relativePath, { fresh = false } = {}) {
    if (!validRelativePath(relativePath)) return { status: "unsafe" };
    const rootStatus = await (fresh ? checkRoot() : (rootCheck ||= checkRoot()));
    if (rootStatus !== "available") return { status: rootStatus };
    const segments = relativePath.split("/");
    let candidate = root;
    for (const [index, segment] of segments.entries()) {
      candidate = path.join(candidate, segment);
      const final = index === segments.length - 1;
      let pending = !fresh && !final ? ancestors.get(candidate) : null;
      if (!pending) {
        pending = fs.promises.lstat(candidate).then((stat) => ({ stat }), (error) => ({ error }));
        if (!fresh && !final) ancestors.set(candidate, pending);
      }
      const { stat, error } = await pending;
      if (error) return { status: error.code === "ENOENT" ? "missing" : "unsafe" };
      if (stat.isSymbolicLink() || (!final && !stat.isDirectory())) return { status: "unsafe" };
      if (final) return { status: "available", file: candidate, stat };
    }
    return { status: "unsafe" };
  };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

// Open once, never follow a leaf symlink, and recheck ancestors before reading.
// Bounded reads plus before/after stat comparisons reject replacement/growth races.
async function readCheckedFile(inspect, relativePath, checked, limit) {
  let handle;
  try {
    handle = await fs.promises.open(checked.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    const rechecked = await inspect(relativePath, { fresh: true });
    if (rechecked.status !== "available") return { error: rechecked.status };
    if (!opened.isFile() || !sameFile(opened, checked.stat) || !sameFile(opened, rechecked.stat)) {
      return { error: "changed" };
    }
    const buffer = Buffer.alloc(Math.min(opened.size, limit));
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) return { error: "changed" };
      position += bytesRead;
    }
    if (!sameFile(opened, await handle.stat())) return { error: "changed" };
    return { buffer, stat: opened };
  } catch (error) {
    return { error: error.code === "ENOENT" ? "missing" : error.code === "ELOOP" ? "unsafe" : "unreadable" };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function emptyRun(id, warning) {
  return { id, createdAt: null, fileCount: 0, totalBytes: 0, status: "unreadable", warnings: [warning], truncated: false };
}

async function readJournal(inspect, id, budget) {
  const relativePath = `.fetch-history/${id}/index.json`;
  const checked = await inspect(relativePath);
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
  const read = await readCheckedFile(inspect, relativePath, checked, HISTORY_LIMITS.journalBytes);
  if (read.error) return { error: "The backup journal changed or could not be read. Try again." };
  try {
    const journal = JSON.parse(read.buffer.toString("utf8"));
    if (!journal || journal.schemaVersion !== 1 || !dateValue(journal.createdAt) || !Array.isArray(journal.files)) {
      return { error: "The backup journal has an unsupported or invalid format." };
    }
    return { journal };
  } catch { return { error: "The backup journal could not be read as valid JSON." }; }
}

async function readRun(inspect, id, budget = { remaining: HISTORY_LIMITS.journalBytes }) {
  const result = await readJournal(inspect, id, budget);
  if (result.error) return { summary: { ...emptyRun(id, result.error), truncated: Boolean(result.truncated) }, entries: [] };
  const { journal } = result;
  const warnings = new Set();
  const entries = [];
  const paths = new Set();
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
    if (paths.has(entry.path)) { warnings.add("Duplicate journal records were omitted."); continue; }
    paths.add(entry.path);
    totalBytes += entry.size;
    entries.push({ path: entry.path, backupPath: `.fetch-history/${id}/${entry.backupPath}`, size: entry.size,
      sha256: entry.sha256.toLowerCase(), preservedAt: dateValue(entry.preservedAt) });
  }
  return { summary: {
    id, createdAt: dateValue(journal.createdAt), fileCount: entries.length, totalBytes,
    status: warnings.size ? "warning" : "available", warnings: [...warnings], truncated,
  }, entries };
}

async function mapLimited(items, mapper, concurrency = 8) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await mapper(items[index]);
    }
  }));
  return result;
}

async function listArchiveHistory({ root }) {
  const inspect = pathInspector(root);
  const history = await inspect(".fetch-history");
  const empty = { runs: [], recordedBytes: 0, recordedFiles: 0, truncated: false, warnings: [] };
  if (history.status === "missing") return empty;
  if (history.status !== "available" || !history.stat.isDirectory()) {
    return { ...empty, warnings: ["The backup history directory is unreadable or uses a symbolic link."] };
  }
  const ids = [];
  const warnings = [];
  let truncated = false;
  let directory;
  try {
    directory = await fs.promises.opendir(history.file);
    let count = 0;
    let entry;
    while ((entry = await directory.read())) {
      if (++count > HISTORY_LIMITS.directoryEntries) {
        truncated = true;
        warnings.push("Only the first 1,000 history directory entries were inspected.");
        break;
      }
      if (!validRunId(entry.name)) continue;
      if (entry.isSymbolicLink()) { warnings.push("Symbolic links in backup history were omitted."); continue; }
      if (entry.isDirectory()) ids.push(entry.name);
    }
  } catch { warnings.push("Some backup history entries could not be read."); }
  finally { if (directory) await directory.close().catch(() => {}); }
  ids.sort((left, right) => right.localeCompare(left));
  if (ids.length > HISTORY_LIMITS.runs) {
    truncated = true;
    warnings.push("Only the newest 100 run names in the inspected entries are shown.");
  }
  const budget = { remaining: HISTORY_LIMITS.listBytes };
  const runs = [];
  // Sequential reads keep the byte budget and run ordering deterministic.
  for (const id of ids.slice(0, HISTORY_LIMITS.runs)) {
    const { summary } = await readRun(inspect, id, budget);
    if (summary.truncated) truncated = true;
    runs.push(summary);
  }
  runs.sort((left, right) => String(right.createdAt || right.id).localeCompare(String(left.createdAt || left.id)));
  let recordedBytes = 0;
  for (const run of runs) {
    if (!Number.isSafeInteger(recordedBytes + run.totalBytes)) {
      recordedBytes = null;
      warnings.push("The recorded byte total exceeds the supported numeric range and cannot be displayed accurately.");
      break;
    }
    recordedBytes += run.totalBytes;
  }
  return { runs, recordedBytes,
    recordedFiles: runs.reduce((sum, run) => sum + run.fileCount, 0), truncated, warnings: [...new Set(warnings)] };
}

async function inspectRun(root, runId) {
  if (!validRunId(runId)) throw httpError(400, "Invalid backup run identifier");
  const inspect = pathInspector(root);
  const run = await inspect(`.fetch-history/${runId}`);
  if (run.status === "missing") throw httpError(404, "Backup run not found");
  if (run.status !== "available" || !run.stat.isDirectory()) throw httpError(400, "Unsafe backup run path");
  return inspect;
}

function pageOptions(options) {
  const offset = Number(options.offset ?? 0);
  const limit = Number(options.limit ?? HISTORY_LIMITS.pageFiles);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw httpError(400, "Invalid backup history page");
  }
  const query = String(options.query || "").trim().toLowerCase();
  if (query.length > 4096) throw httpError(400, "Backup history filter is too long");
  return { offset, limit: Math.min(limit, HISTORY_LIMITS.pageFiles), query };
}

async function readArchiveHistoryRun({ root }, runId, options = {}) {
  const { offset, limit, query } = pageOptions(options);
  const inspect = await inspectRun(root, runId);
  const { summary, entries } = await readRun(inspect, runId);
  const matching = entries.filter((entry) => !query || entry.path.toLowerCase().includes(query));
  const files = await mapLimited(matching.slice(offset, offset + limit), async (entry) => {
    const checked = await inspect(entry.backupPath);
    const status = checked.status !== "available" ? checked.status
      : !checked.stat.isFile() ? "unsafe" : checked.stat.size !== entry.size ? "changed" : "available";
    return { ...entry, backupPath: ["available", "changed"].includes(status) ? entry.backupPath : null, status };
  });
  if (files.some((file) => file.status !== "available")) {
    summary.warnings.push("Some files on this page are missing, unsafe, or no longer match their recorded size.");
    if (summary.status === "available") summary.status = "warning";
  }
  return { ...summary, files, offset, limit, total: matching.length, hasMore: offset + files.length < matching.length };
}

function emptyComparisonFile(status) {
  return { status, size: null, modifiedAt: null, sha256: null, text: null, textTruncated: false };
}

async function comparisonFile(inspect, relativePath, recorded) {
  const checked = await inspect(relativePath, { fresh: true });
  if (checked.status !== "available") return emptyComparisonFile(checked.status);
  if (!checked.stat.isFile()) return emptyComparisonFile("unsafe");
  const file = { ...emptyComparisonFile("available"), size: checked.stat.size, modifiedAt: checked.stat.mtime.toISOString() };
  if (recorded && recorded.size !== file.size) file.status = "changed";
  if (file.size > HISTORY_LIMITS.comparisonBytes) return file;
  const read = await readCheckedFile(inspect, relativePath, checked, HISTORY_LIMITS.comparisonBytes);
  if (read.error) return { ...file, status: read.error };
  file.sha256 = createHash("sha256").update(read.buffer).digest("hex");
  if (recorded && recorded.sha256 !== file.sha256) file.status = "changed";
  if (TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) || path.extname(relativePath).toLowerCase() === ".svg") {
    try {
      // Reject binary/invalid UTF-8 rather than displaying replacement characters as a text diff.
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
      if (!decoded.includes("\0")) {
        file.textTruncated = read.buffer.length > HISTORY_LIMITS.textBytes;
        file.text = file.textTruncated
          ? new TextDecoder("utf-8", { fatal: true }).decode(read.buffer.subarray(0, HISTORY_LIMITS.textBytes), { stream: true })
          : decoded;
      }
    } catch { /* Binary data remains downloadable without an inaccurate text preview. */ }
  }
  return file;
}

async function compareArchiveHistoryFile({ root }, runId, relativePath) {
  if (!validRelativePath(relativePath)) throw httpError(400, "Invalid backup file path");
  const inspect = await inspectRun(root, runId);
  const { summary, entries } = await readRun(inspect, runId);
  if (summary.status === "unreadable") throw httpError(409, "The backup journal cannot be read for comparison");
  const entry = entries.find((item) => item.path === relativePath);
  if (!entry) throw httpError(404, "File not found in the displayed backup journal records");
  const [saved, current] = await Promise.all([
    comparisonFile(inspect, entry.backupPath, entry), comparisonFile(inspect, entry.path),
  ]);
  // A changed saved file with a completed hash still has comparable bytes. A
  // read race has no hash, so neither that saved file nor a raced current file
  // can be treated as a successful metadata-only comparison.
  const savedReadable = saved.status === "available" || (saved.status === "changed" && Boolean(saved.sha256));
  const available = savedReadable && current.status === "available";
  let comparison = "unavailable";
  if (savedReadable && current.status === "missing") comparison = "missing-current";
  else if (available) {
    comparison = saved.sha256 && current.sha256
      ? saved.sha256 === current.sha256 ? "identical" : "different"
      : saved.size !== current.size ? "different" : "metadata-only";
  }
  const warnings = [...summary.warnings];
  if (saved.status === "changed") warnings.push("The saved file no longer matches its journal or changed while being read. Inspect it before using it for recovery.");
  const currentWarnings = {
    changed: "The current file changed while it was being read. Try the comparison again before planning recovery.",
    missing: "The current file is missing. Recovery would add a file at this path.",
    unsafe: "The current path is unsafe or uses a symbolic link. Resolve that path before planning recovery.",
    unreadable: "The current file could not be read. Check its access permissions and try again.",
  };
  if (currentWarnings[current.status]) warnings.push(currentWarnings[current.status]);
  if (saved.size > HISTORY_LIMITS.comparisonBytes || current.size > HISTORY_LIMITS.comparisonBytes) {
    warnings.push("Files larger than 2 MiB are not hashed or read; only their size metadata is available.");
  }
  if (saved.textTruncated || current.textTruncated) warnings.push("Text previews show only the first 128 KiB; hashes cover the complete file when shown.");
  return { path: entry.path, backupPath: ["available", "changed"].includes(saved.status) ? entry.backupPath : null,
    recorded: { size: entry.size, sha256: entry.sha256, preservedAt: entry.preservedAt }, saved, current, comparison, warnings };
}

module.exports = { HISTORY_LIMITS, listArchiveHistory, readArchiveHistoryRun, compareArchiveHistoryFile, resolveHistoryFile };
