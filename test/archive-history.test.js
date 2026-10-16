const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { FileSystemArchiveRepository } = require("../src/adapters/filesystem/archive-repository");
const { HISTORY_LIMITS } = require("../src/adapters/filesystem/archive-history-reader");
const { createCourseFileStore } = require("../src/adapters/filesystem/course-file-store");

const CREATED_AT = "2026-07-23T12:00:00.000Z";

function fixture(context) {
  const archive = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-history-"));
  context.after(() => fs.rmSync(archive, { recursive: true, force: true }));
  const course = { id: "_1_1", outputDirectory: "2025-26/Example Course" };
  const root = path.join(archive, course.outputDirectory);
  fs.mkdirSync(root, { recursive: true });
  return { archive, course, root, repository: new FileSystemArchiveRepository({ archiveRoot: archive }) };
}

function record(relativePath = "manifest.json", overrides = {}) {
  return { path: relativePath, backupPath: `files/${relativePath}`, size: 3, sha256: "a".repeat(64), preservedAt: CREATED_AT, ...overrides };
}

function journal(root, id, files = [record()], overrides = {}) {
  const directory = path.join(root, ".fetch-history", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({ schemaVersion: 1, createdAt: CREATED_AT, files, ...overrides }));
  return directory;
}

function backup(directory, relativePath, contents = "old") {
  const target = path.join(directory, "files", relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

test("history reader discovers real replacement journals without indexing their contents", async (context) => {
  const { course, root, repository } = fixture(context);
  const original = path.join(root, "manifest.json");
  fs.writeFileSync(original, "original");
  const store = createCourseFileStore({ outputRoot: root, preserveHistory: true });
  store.writeText(original, "replacement");

  const list = await repository.listCourseHistory(course);
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0].fileCount, 1);
  assert.equal(list.runs[0].totalBytes, 8);
  assert.equal(list.runs[0].status, "available");
  assert.equal(list.runs[0].files, undefined);
  assert.deepEqual(list.warnings, []);
  const detail = await repository.readCourseHistoryRun(course, list.runs[0].id);
  assert.equal(detail.files[0].path, "manifest.json");
  assert.equal(detail.files[0].status, "available");
  assert.match(detail.files[0].sha256, /^[a-f0-9]{64}$/);
  const resolved = repository.resolveCourseFile(course, detail.files[0].backupPath);
  assert.equal(fs.readFileSync(resolved.file, "utf8"), "original");
  assert.deepEqual(repository.listCourseFiles(course).map((file) => file.path), ["manifest.json"]);
});

test("history summaries are ordered and never read archived file bodies or disclose journal extras", async (context) => {
  const { course, root, repository } = fixture(context);
  const older = journal(root, "old-run", [record()], { createdAt: "2026-07-22T12:00:00.000Z" });
  const newer = journal(root, "new-run", [record("gradebook.json")], { internalToken: "never-return-this-value" });
  backup(older, "manifest.json");
  backup(newer, "gradebook.json");
  context.mock.method(fs, "readFileSync", () => { throw new Error("File bodies must not be read"); });
  const list = await repository.listCourseHistory(course);
  assert.deepEqual(list.runs.map((run) => run.id), ["new-run", "old-run"]);
  const detail = await repository.readCourseHistoryRun(course, "new-run");
  assert.equal(detail.files[0].status, "available");
  assert.doesNotMatch(JSON.stringify([list, detail]), /never-return-this-value|internalToken/);
});

test("malformed journals remain visible without breaking other runs", async (context) => {
  const { course, root, repository } = fixture(context);
  const malformed = journal(root, "bad-json");
  fs.writeFileSync(path.join(malformed, "index.json"), "not json");
  journal(root, "wrong-schema", [], { schemaVersion: 99 });
  const missing = journal(root, "missing-index");
  fs.unlinkSync(path.join(missing, "index.json"));
  const oversized = journal(root, "oversized");
  fs.writeFileSync(path.join(oversized, "index.json"), Buffer.alloc(HISTORY_LIMITS.journalBytes + 1));
  journal(root, "valid");

  const list = await repository.listCourseHistory(course);
  assert.equal(list.runs.length, 5);
  assert.equal(list.runs.filter((run) => run.status === "unreadable").length, 4);
  assert.equal(list.runs.find((run) => run.id === "valid").status, "available");
  assert.equal(list.truncated, true);
  const detail = await repository.readCourseHistoryRun(course, "bad-json");
  assert.deepEqual(detail.files, []);
  assert.equal(detail.status, "unreadable");
  assert.doesNotMatch(JSON.stringify(list), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("journal records reject traversal, duplicate paths and unrelated backup targets", async (context) => {
  const { course, root, repository } = fixture(context);
  const entries = [
    record(), record(), record("../private.txt"), record("..\\private.txt"),
    record("/private.txt"), record("C:/private.txt"), record(".fetch-history/nested.json"),
    record("secret.json", { backupPath: "../../secret.json" }),
    record("invalid-size.json", { size: -1 }), record("invalid-hash.json", { sha256: "not-a-hash" }),
    record("nonstring-hash.json", { sha256: ["a".repeat(64)] }),
    record("invalid-date.json", { preservedAt: "no date" }),
  ];
  const directory = journal(root, "example-run", entries);
  backup(directory, "manifest.json");
  const detail = await repository.readCourseHistoryRun(course, "example-run");
  assert.equal(detail.status, "warning");
  assert.equal(detail.fileCount, 1);
  assert.equal(detail.totalBytes, 3);
  assert.deepEqual(detail.files.map((file) => file.path), ["manifest.json"]);
  for (const id of ["..", "../other", "bad/run", "bad\\run", "C:other", "", "x".repeat(129)]) {
    await assert.rejects(() => repository.readCourseHistoryRun(course, id), (error) => error.statusCode === 400);
  }
  await assert.rejects(() => repository.readCourseHistoryRun(course, "missing-run"), (error) => error.statusCode === 404);
});

test("detail reports missing or changed files and rejects contained and escaping symlinks", async (context) => {
  const { archive, course, root, repository } = fixture(context);
  const directory = journal(root, "example-run", [record(), record("missing.json"), record("changed.json"), record("linked.json"), record("nested/secret.json")]);
  backup(directory, "manifest.json");
  backup(directory, "changed.json", "different size");
  fs.symlinkSync(path.join(directory, "files", "manifest.json"), path.join(directory, "files", "linked.json"));
  fs.symlinkSync(archive, path.join(directory, "files", "nested"), "dir");
  const detail = await repository.readCourseHistoryRun(course, "example-run");
  assert.deepEqual(detail.files.map((file) => file.status), ["available", "missing", "changed", "unsafe", "unsafe"]);
  assert.ok(detail.files.filter((file) => ["missing", "unsafe"].includes(file.status)).every((file) => file.backupPath === null));
  assert.equal(detail.files[2].backupPath, ".fetch-history/example-run/files/changed.json");
  assert.equal(detail.status, "warning");
  for (const relativePath of [".fetch-history/example-run/files/linked.json", "./.fetch-history/example-run/files/linked.json", "unused/../.fetch-history/example-run/files/linked.json"]) {
    assert.throws(() => repository.resolveCourseFile(course, relativePath), (error) => error.statusCode === 400);
  }
  const target = path.join(directory, "files", "manifest.json");
  fs.unlinkSync(target);
  fs.symlinkSync(path.join(directory, "files", "changed.json"), target);
  assert.throws(() => repository.resolveCourseFile(course, detail.files[0].backupPath), (error) => error.statusCode === 400);
});

test("history root, run, and journal symlinks cannot be browsed", async (context) => {
  const { archive, course, root, repository } = fixture(context);
  assert.deepEqual(await repository.listCourseHistory(course), { runs: [], recordedBytes: 0, recordedFiles: 0, truncated: false, warnings: [] });
  const directory = journal(root, "valid-run");
  fs.symlinkSync(directory, path.join(root, ".fetch-history", "linked-run"), "dir");
  assert.equal((await repository.listCourseHistory(course)).runs.length, 1);
  assert.match((await repository.listCourseHistory(course)).warnings[0], /Symbolic links/);
  await assert.rejects(() => repository.readCourseHistoryRun(course, "linked-run"), (error) => error.statusCode === 400);
  fs.renameSync(path.join(directory, "index.json"), path.join(directory, "other.json"));
  fs.symlinkSync(path.join(directory, "other.json"), path.join(directory, "index.json"));
  assert.equal((await repository.readCourseHistoryRun(course, "valid-run")).status, "unreadable");
  fs.renameSync(path.join(root, ".fetch-history"), path.join(archive, "history"));
  fs.symlinkSync(path.join(archive, "history"), path.join(root, ".fetch-history"), "dir");
  const list = await repository.listCourseHistory(course);
  assert.deepEqual(list.runs, []);
  assert.match(list.warnings[0], /symbolic link/);
});

test("large histories have explicit enumeration, journal and displayed-file limits", async (context) => {
  const { course, root, repository } = fixture(context);
  journal(root, "many-files", Array.from({ length: HISTORY_LIMITS.files + 1 }, (_, index) => record(`file-${index}.json`)));
  const detail = await repository.readCourseHistoryRun(course, "many-files");
  assert.equal(detail.files.length, HISTORY_LIMITS.pageFiles);
  assert.equal(detail.total, HISTORY_LIMITS.files);
  assert.equal(detail.hasMore, true);
  assert.equal(detail.fileCount, HISTORY_LIMITS.files);
  assert.equal(detail.truncated, true);
  assert.match(detail.warnings[0], /shown and counted/);
  for (let index = 0; index < HISTORY_LIMITS.directoryEntries + 1; index += 1) {
    fs.mkdirSync(path.join(root, ".fetch-history", `run-${String(index).padStart(4, "0")}`));
  }
  const list = await repository.listCourseHistory(course);
  assert.equal(list.runs.length, HISTORY_LIMITS.runs);
  assert.equal(list.truncated, true);
  assert.match(list.warnings.join(" "), /1,000.*100 run names/);
});

test("history summaries enforce a total journal read budget without preventing direct inspection", async (context) => {
  const { course, root, repository } = fixture(context);
  for (let index = 0; index < 5; index += 1) {
    const directory = journal(root, `run-${index}`, []);
    const file = path.join(directory, "index.json");
    const body = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, body.padEnd(HISTORY_LIMITS.journalBytes, " "));
  }
  const list = await repository.listCourseHistory(course);
  assert.equal(list.runs.filter((run) => run.status === "available").length, 4);
  const limited = list.runs.find((run) => run.status === "unreadable");
  assert.match(limited.warnings[0], /read limit/);
  assert.equal(list.truncated, true);
  assert.equal((await repository.readCourseHistoryRun(course, limited.id)).status, "available");
});

test("history pagination checks only the returned page, with shared ancestors and server filtering", async (context) => {
  const { course, root, repository } = fixture(context);
  const directory = journal(root, "paged", Array.from({ length: 240 }, (_, index) => record(`notes/file-${String(index).padStart(3, "0")}.txt`)));
  for (let index = 100; index < 110; index += 1) backup(directory, `notes/file-${String(index).padStart(3, "0")}.txt`);
  const inspected = [];
  const original = fs.promises.lstat.bind(fs.promises);
  context.mock.method(fs.promises, "lstat", async (file) => { inspected.push(file); return original(file); });
  const detail = await repository.readCourseHistoryRun(course, "paged", { offset: 100, limit: 10 });
  assert.equal(detail.total, 240);
  assert.equal(detail.files.length, 10);
  assert.equal(detail.offset, 100);
  assert.equal(detail.limit, 10);
  assert.equal(detail.hasMore, true);
  assert.ok(detail.files.every((file) => file.status === "available"));
  assert.equal(inspected.filter((file) => /file-\d+\.txt$/.test(file)).length, 10);
  assert.equal(inspected.filter((file) => file.endsWith(path.join("files", "notes"))).length, 1);
  const filtered = await repository.readCourseHistoryRun(course, "paged", { query: "FILE-10", limit: 3, offset: 9 });
  assert.equal(filtered.total, 10);
  assert.equal(filtered.files.length, 1);
  assert.equal(filtered.files[0].path, "notes/file-109.txt");
  assert.equal(filtered.hasMore, false);
  const list = await repository.listCourseHistory(course);
  assert.equal(list.recordedFiles, 240);
  assert.equal(list.recordedBytes, 720);
  for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 1.5 }, { offset: "NaN" }, { query: "x".repeat(4097) }]) {
    await assert.rejects(() => repository.readCourseHistoryRun(course, "paged", options), (error) => error.statusCode === 400);
  }
});

test("history comparison reports real hashes, bounded text and missing current files without writes", async (context) => {
  const { createHash } = require("crypto");
  const { course, root, repository } = fixture(context);
  const previous = '<script>globalThis.unsafe = true</script>\nold';
  const sha256 = createHash("sha256").update(previous).digest("hex");
  const directory = journal(root, "compare", [record("notes.html", { size: Buffer.byteLength(previous), sha256 })]);
  backup(directory, "notes.html", previous);
  fs.writeFileSync(path.join(root, "notes.html"), "current");
  const result = await repository.compareCourseHistoryFile(course, "compare", "notes.html");
  assert.equal(result.comparison, "different");
  assert.equal(result.saved.text, previous);
  assert.equal(result.current.text, "current");
  assert.equal(result.saved.sha256, sha256);
  assert.equal(result.saved.status, "available");
  assert.equal(result.recorded.sha256, sha256);
  assert.equal(fs.readFileSync(path.join(root, "notes.html"), "utf8"), "current");
  fs.writeFileSync(path.join(root, "notes.html"), previous);
  assert.equal((await repository.compareCourseHistoryFile(course, "compare", "notes.html")).comparison, "identical");
  fs.unlinkSync(path.join(root, "notes.html"));
  assert.equal((await repository.compareCourseHistoryFile(course, "compare", "notes.html")).comparison, "missing-current");
  await assert.rejects(() => repository.compareCourseHistoryFile(course, "compare", "../private"), (error) => error.statusCode === 400);
  await assert.rejects(() => repository.compareCourseHistoryFile(course, "compare", "other.txt"), (error) => error.statusCode === 404);
});

test("history comparison detects saved hash changes and rejects current symlinks, binary or invalid UTF-8 text", async (context) => {
  const { course, root, repository } = fixture(context);
  const directory = journal(root, "compare", [record("notes.txt"), record("invalid.txt", { size: 3 })]);
  backup(directory, "notes.txt", "new");
  backup(directory, "invalid.txt", Buffer.from([0xff, 0xfe, 0x01]));
  fs.symlinkSync(path.join(directory, "files", "notes.txt"), path.join(root, "notes.txt"));
  const result = await repository.compareCourseHistoryFile(course, "compare", "notes.txt");
  assert.equal(result.saved.status, "changed");
  assert.equal(result.current.status, "unsafe");
  assert.match(result.warnings.join(" "), /Resolve that path/);
  assert.equal(result.current.text, null);
  assert.equal(result.comparison, "unavailable");
  assert.match(result.warnings.join(" "), /no longer matches/);
  assert.equal((await repository.compareCourseHistoryFile(course, "compare", "invalid.txt")).saved.text, null);
  fs.writeFileSync(path.join(directory, "files", "invalid.txt"), Buffer.from([65, 0, 66]));
  assert.equal((await repository.compareCourseHistoryFile(course, "compare", "invalid.txt")).saved.text, null);
});

test("history comparison caps text and reports metadata-only for large equal-size files", async (context) => {
  const { course, root, repository } = fixture(context);
  const text = "x".repeat(HISTORY_LIMITS.textBytes + 10);
  const big = "x".repeat(HISTORY_LIMITS.comparisonBytes + 1);
  const directory = journal(root, "compare", [record("long.txt", { size: text.length }), record("big.txt", { size: big.length })]);
  backup(directory, "long.txt", text);
  backup(directory, "big.txt", big);
  fs.writeFileSync(path.join(root, "big.txt"), big);
  const preview = await repository.compareCourseHistoryFile(course, "compare", "long.txt");
  assert.equal(preview.saved.text.length, HISTORY_LIMITS.textBytes);
  assert.equal(preview.saved.textTruncated, true);
  assert.match(preview.saved.sha256, /^[a-f0-9]{64}$/);
  const large = await repository.compareCourseHistoryFile(course, "compare", "big.txt");
  assert.equal(large.comparison, "metadata-only");
  assert.equal(large.saved.text, null);
  assert.equal(large.saved.sha256, null);
  assert.match(large.warnings.join(" "), /not hashed/);
});

test("history reads reject a replaced ancestor between inspection and open", async (context) => {
  const { archive, course, root, repository } = fixture(context);
  const directory = journal(root, "compare", [record("notes.txt")]);
  backup(directory, "notes.txt", "old");
  const outside = path.join(archive, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "notes.txt"), "secret");
  const originalOpen = fs.promises.open.bind(fs.promises);
  let replaced = false;
  context.mock.method(fs.promises, "open", async (file, flags) => {
    if (!replaced && file === path.join(directory, "files", "notes.txt")) {
      replaced = true;
      fs.renameSync(path.join(directory, "files"), path.join(directory, "original-files"));
      fs.symlinkSync(outside, path.join(directory, "files"), "dir");
    }
    return originalOpen(file, flags);
  });
  const result = await repository.compareCourseHistoryFile(course, "compare", "notes.txt");
  assert.equal(result.saved.status, "unsafe");
  assert.equal(result.saved.text, null);
  assert.equal(result.saved.sha256, null);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("history summary refuses an imprecise byte total from oversized recorded metadata", async (context) => {
  const { course, root, repository } = fixture(context);
  journal(root, "first", [record("first.txt", { size: Number.MAX_SAFE_INTEGER })]);
  journal(root, "second", [record("second.txt", { size: Number.MAX_SAFE_INTEGER })]);
  const list = await repository.listCourseHistory(course);
  assert.equal(list.recordedFiles, 2);
  assert.equal(list.recordedBytes, null);
  assert.match(list.warnings.join(" "), /cannot be displayed accurately/);
});

test("a current file changing during comparison is unavailable rather than a large-file result", async (context) => {
  const { createHash } = require("crypto");
  const { course, root, repository } = fixture(context);
  const originalBytes = "old";
  const directory = journal(root, "compare", [record("notes.txt", { sha256: createHash("sha256").update(originalBytes).digest("hex") })]);
  backup(directory, "notes.txt", originalBytes);
  const currentPath = path.join(root, "notes.txt");
  fs.writeFileSync(currentPath, originalBytes);
  const originalOpen = fs.promises.open.bind(fs.promises);
  context.mock.method(fs.promises, "open", async (file, flags) => {
    const handle = await originalOpen(file, flags);
    if (file === currentPath) fs.writeFileSync(currentPath, "different current content");
    return handle;
  });
  const result = await repository.compareCourseHistoryFile(course, "compare", "notes.txt");
  assert.equal(result.current.status, "changed");
  assert.equal(result.current.sha256, null);
  assert.equal(result.current.text, null);
  assert.equal(result.comparison, "unavailable");
  assert.match(result.warnings.join(" "), /current file changed.*Try the comparison again/);
  assert.doesNotMatch(result.warnings.join(" "), /larger than 2 MiB/);
});
