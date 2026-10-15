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

test("history reader discovers real replacement journals without indexing their contents", (context) => {
  const { course, root, repository } = fixture(context);
  const original = path.join(root, "manifest.json");
  fs.writeFileSync(original, "original");
  const store = createCourseFileStore({ outputRoot: root, preserveHistory: true });
  store.writeText(original, "replacement");

  const list = repository.listCourseHistory(course);
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0].fileCount, 1);
  assert.equal(list.runs[0].totalBytes, 8);
  assert.equal(list.runs[0].status, "available");
  assert.equal(list.runs[0].files, undefined);
  assert.deepEqual(list.warnings, []);
  const detail = repository.readCourseHistoryRun(course, list.runs[0].id);
  assert.equal(detail.files[0].path, "manifest.json");
  assert.equal(detail.files[0].status, "available");
  assert.match(detail.files[0].sha256, /^[a-f0-9]{64}$/);
  const resolved = repository.resolveCourseFile(course, detail.files[0].backupPath);
  assert.equal(fs.readFileSync(resolved.file, "utf8"), "original");
  assert.deepEqual(repository.listCourseFiles(course).map((file) => file.path), ["manifest.json"]);
});

test("history summaries are ordered and never read archived file bodies or disclose journal extras", (context) => {
  const { course, root, repository } = fixture(context);
  const older = journal(root, "old-run", [record()], { createdAt: "2026-07-22T12:00:00.000Z" });
  const newer = journal(root, "new-run", [record("gradebook.json")], { internalToken: "never-return-this-value" });
  backup(older, "manifest.json");
  backup(newer, "gradebook.json");
  context.mock.method(fs, "readFileSync", () => { throw new Error("File bodies must not be read"); });
  const list = repository.listCourseHistory(course);
  assert.deepEqual(list.runs.map((run) => run.id), ["new-run", "old-run"]);
  const detail = repository.readCourseHistoryRun(course, "new-run");
  assert.equal(detail.files[0].status, "available");
  assert.doesNotMatch(JSON.stringify([list, detail]), /never-return-this-value|internalToken/);
});

test("malformed journals remain visible without breaking other runs", (context) => {
  const { course, root, repository } = fixture(context);
  const malformed = journal(root, "bad-json");
  fs.writeFileSync(path.join(malformed, "index.json"), "not json");
  journal(root, "wrong-schema", [], { schemaVersion: 99 });
  const missing = journal(root, "missing-index");
  fs.unlinkSync(path.join(missing, "index.json"));
  const oversized = journal(root, "oversized");
  fs.writeFileSync(path.join(oversized, "index.json"), Buffer.alloc(HISTORY_LIMITS.journalBytes + 1));
  journal(root, "valid");

  const list = repository.listCourseHistory(course);
  assert.equal(list.runs.length, 5);
  assert.equal(list.runs.filter((run) => run.status === "unreadable").length, 4);
  assert.equal(list.runs.find((run) => run.id === "valid").status, "available");
  assert.equal(list.truncated, true);
  const detail = repository.readCourseHistoryRun(course, "bad-json");
  assert.deepEqual(detail.files, []);
  assert.equal(detail.status, "unreadable");
  assert.doesNotMatch(JSON.stringify(list), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("journal records reject traversal, duplicate paths and unrelated backup targets", (context) => {
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
  const detail = repository.readCourseHistoryRun(course, "example-run");
  assert.equal(detail.status, "warning");
  assert.equal(detail.fileCount, 1);
  assert.equal(detail.totalBytes, 3);
  assert.deepEqual(detail.files.map((file) => file.path), ["manifest.json"]);
  for (const id of ["..", "../other", "bad/run", "bad\\run", "C:other", "", "x".repeat(129)]) {
    assert.throws(() => repository.readCourseHistoryRun(course, id), (error) => error.statusCode === 400);
  }
  assert.throws(() => repository.readCourseHistoryRun(course, "missing-run"), (error) => error.statusCode === 404);
});

test("detail reports missing or changed files and rejects contained and escaping symlinks", (context) => {
  const { archive, course, root, repository } = fixture(context);
  const directory = journal(root, "example-run", [record(), record("missing.json"), record("changed.json"), record("linked.json"), record("nested/secret.json")]);
  backup(directory, "manifest.json");
  backup(directory, "changed.json", "different size");
  fs.symlinkSync(path.join(directory, "files", "manifest.json"), path.join(directory, "files", "linked.json"));
  fs.symlinkSync(archive, path.join(directory, "files", "nested"), "dir");
  const detail = repository.readCourseHistoryRun(course, "example-run");
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

test("history root, run, and journal symlinks cannot be browsed", (context) => {
  const { archive, course, root, repository } = fixture(context);
  assert.deepEqual(repository.listCourseHistory(course), { runs: [], truncated: false, warnings: [] });
  const directory = journal(root, "valid-run");
  fs.symlinkSync(directory, path.join(root, ".fetch-history", "linked-run"), "dir");
  assert.equal(repository.listCourseHistory(course).runs.length, 1);
  assert.match(repository.listCourseHistory(course).warnings[0], /Symbolic links/);
  assert.throws(() => repository.readCourseHistoryRun(course, "linked-run"), (error) => error.statusCode === 400);
  fs.renameSync(path.join(directory, "index.json"), path.join(directory, "other.json"));
  fs.symlinkSync(path.join(directory, "other.json"), path.join(directory, "index.json"));
  assert.equal(repository.readCourseHistoryRun(course, "valid-run").status, "unreadable");
  fs.renameSync(path.join(root, ".fetch-history"), path.join(archive, "history"));
  fs.symlinkSync(path.join(archive, "history"), path.join(root, ".fetch-history"), "dir");
  const list = repository.listCourseHistory(course);
  assert.deepEqual(list.runs, []);
  assert.match(list.warnings[0], /symbolic link/);
});

test("large histories have explicit enumeration, journal and displayed-file limits", (context) => {
  const { course, root, repository } = fixture(context);
  journal(root, "many-files", Array.from({ length: HISTORY_LIMITS.files + 1 }, (_, index) => record(`file-${index}.json`)));
  const detail = repository.readCourseHistoryRun(course, "many-files");
  assert.equal(detail.files.length, HISTORY_LIMITS.files);
  assert.equal(detail.fileCount, HISTORY_LIMITS.files);
  assert.equal(detail.truncated, true);
  assert.match(detail.warnings[0], /shown and counted/);
  for (let index = 0; index < HISTORY_LIMITS.directoryEntries + 1; index += 1) {
    fs.mkdirSync(path.join(root, ".fetch-history", `run-${String(index).padStart(4, "0")}`));
  }
  const list = repository.listCourseHistory(course);
  assert.equal(list.runs.length, HISTORY_LIMITS.runs);
  assert.equal(list.truncated, true);
  assert.match(list.warnings.join(" "), /1,000.*100 run names/);
});

test("history summaries enforce a total journal read budget without preventing direct inspection", (context) => {
  const { course, root, repository } = fixture(context);
  for (let index = 0; index < 5; index += 1) {
    const directory = journal(root, `run-${index}`, []);
    const file = path.join(directory, "index.json");
    const body = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, body.padEnd(HISTORY_LIMITS.journalBytes, " "));
  }
  const list = repository.listCourseHistory(course);
  assert.equal(list.runs.filter((run) => run.status === "available").length, 4);
  const limited = list.runs.find((run) => run.status === "unreadable");
  assert.match(limited.warnings[0], /read limit/);
  assert.equal(list.truncated, true);
  assert.equal(repository.readCourseHistoryRun(course, limited.id).status, "available");
});
