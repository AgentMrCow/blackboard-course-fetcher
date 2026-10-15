const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCourseFileStore } = require("../src/adapters/filesystem/course-file-store");

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("course file store owns unique paths, hashing, placement, and prior-file lookup", (context) => {
  const outputRoot = temporaryDirectory(context, "course-file-store-");
  const store = createCourseFileStore({ cwd: outputRoot, outputRoot });
  const directory = path.join(outputRoot, "files");
  const preferred = store.preferredPath(directory, "report.txt");
  store.writeText(preferred, "same content");

  assert.equal(store.fileSize(preferred), 12);
  assert.equal(
    store.hashFile(preferred),
    crypto.createHash("sha256").update("same content").digest("hex")
  );
  assert.equal(store.relativePath(preferred), path.join("files", "report.txt"));
  assert.equal(store.uniquePath(directory, "report.txt"), path.join(directory, "report (2).txt"));
  assert.equal(
    store.uniquePath(directory, "report.txt", new Set([path.join(directory, "report (2).txt")])),
    path.join(directory, "report (3).txt")
  );
  assert.equal(
    store.findIdenticalFile(directory, "report.txt", 12, store.hashFile(preferred)),
    preferred
  );
  assert.equal(store.previousLocalPath({ path: path.join("files", "report.txt") }), preferred);
  assert.equal(store.previousLocalPath({ path: path.join("..", "outside.txt") }), null);

  const temporaryPath = path.join(directory, ".report.txt.part-test");
  fs.writeFileSync(temporaryPath, "new content");
  assert.equal(store.placeTemporaryFile(temporaryPath, directory, "report.txt"), path.join(directory, "report (2).txt"));
});

test("course file store rejects cache reads and writes through escaping symlinks", (context) => {
  const parent = temporaryDirectory(context, "course-file-store-links-");
  const outputRoot = path.join(parent, "course");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.txt"), "private");
  fs.symlinkSync(outside, path.join(outputRoot, "linked"), "dir");
  const store = createCourseFileStore({ outputRoot });

  assert.equal(store.previousLocalPath({ path: path.join("linked", "private.txt") }), null);
  assert.throws(
    () => store.writeText(path.join(outputRoot, "linked", "created.txt"), "blocked"),
    /outside the course output root/
  );
  assert.equal(fs.existsSync(path.join(outside, "created.txt")), false);
});

test("history preserves the first original bytes once across repeated atomic writes", (context) => {
  const outputRoot = temporaryDirectory(context, "course-file-history-");
  const original = Buffer.from([0, 1, 2, 255, 10]);
  const target = path.join(outputRoot, "records", "grades.json");
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, original);
  const store = createCourseFileStore({ outputRoot, preserveHistory: true });
  assert.equal(store.historyPath(), null);
  store.writeBuffer(target, Buffer.from("first replacement"));
  const historyPath = path.join(outputRoot, store.historyPath());
  store.writeText(target, "second replacement");
  const index = JSON.parse(fs.readFileSync(path.join(historyPath, "index.json"), "utf8"));
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.files.length, 1);
  assert.equal(index.files[0].path, "records/grades.json");
  assert.equal(index.files[0].size, original.length);
  assert.equal(index.files[0].sha256, crypto.createHash("sha256").update(original).digest("hex"));
  assert.ok(Number.isFinite(Date.parse(index.files[0].preservedAt)));
  assert.deepEqual(fs.readFileSync(path.join(historyPath, index.files[0].backupPath)), original);
  assert.equal(fs.readFileSync(target, "utf8"), "second replacement");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["grades.json"]);
});

test("proactive preservation records an original manifest before any write", (context) => {
  const outputRoot = temporaryDirectory(context, "course-file-baseline-");
  const target = path.join(outputRoot, "manifest.json");
  const original = '{"contents":[{"id":"original"}]}\n';
  fs.writeFileSync(target, original);
  const firstStore = createCourseFileStore({ outputRoot, preserveHistory: true });
  let entry;
  fs.chmodSync(target, 0o444);
  try {
    entry = firstStore.preserveFile(target);
  } finally {
    fs.chmodSync(target, 0o600);
  }
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(entry.path, "manifest.json");
  assert.equal(fs.readFileSync(path.join(outputRoot, firstStore.historyPath(), entry.backupPath), "utf8"), original);
  const secondStore = createCourseFileStore({ outputRoot, preserveHistory: true });
  secondStore.preserveFile(target);
  assert.notEqual(secondStore.historyPath(), firstStore.historyPath());
  assert.equal(fs.readdirSync(path.join(outputRoot, ".fetch-history")).length, 2);
});

test("new files, unchanged writes and default operation do not create history", (context) => {
  const outputRoot = temporaryDirectory(context, "course-file-no-history-");
  const existing = path.join(outputRoot, "original.txt");
  fs.writeFileSync(existing, "unchanged");
  const store = createCourseFileStore({ outputRoot, preserveHistory: true });
  store.writeText(existing, "unchanged");
  const fresh = path.join(outputRoot, "fresh.txt");
  store.writeText(fresh, "first new version");
  store.writeText(fresh, "second new version");
  assert.equal(store.preserveFile(fresh), null);
  assert.equal(store.historyPath(), null);
  assert.equal(fs.existsSync(path.join(outputRoot, ".fetch-history")), false);
  const ordinary = createCourseFileStore({ outputRoot });
  ordinary.writeText(existing, "changed without history enabled");
  assert.equal(ordinary.preserveFile(existing), null);
  assert.equal(fs.existsSync(path.join(outputRoot, ".fetch-history")), false);
});

test("a backup or journal failure leaves the original file unchanged", (context) => {
  const outputRoot = temporaryDirectory(context, "course-file-history-failure-");
  const target = path.join(outputRoot, "manifest.json");
  fs.writeFileSync(target, "original manifest");
  const store = createCourseFileStore({ outputRoot, preserveHistory: true });
  const originalCopy = fs.copyFileSync;
  context.mock.method(fs, "copyFileSync", () => { throw new Error("backup failed"); });
  assert.throws(() => store.writeText(target, "replacement"), /backup failed/);
  assert.equal(fs.readFileSync(target, "utf8"), "original manifest");
  fs.copyFileSync.mock.restore();
  assert.equal(fs.copyFileSync, originalCopy);

  context.mock.method(fs, "fsyncSync", () => { throw new Error("backup flush failed"); });
  assert.throws(() => store.writeText(target, "replacement"), /backup flush failed/);
  assert.equal(fs.readFileSync(target, "utf8"), "original manifest");
  fs.fsyncSync.mock.restore();

  const originalRename = fs.renameSync;
  context.mock.method(fs, "renameSync", (source, destination) => {
    if (destination.endsWith(`${path.sep}index.json`)) throw new Error("journal failed");
    return originalRename(source, destination);
  });
  assert.throws(() => store.writeText(target, "replacement"), /journal failed/);
  assert.equal(fs.readFileSync(target, "utf8"), "original manifest");
  assert.equal(store.historyPath(), null);
  fs.renameSync.mock.restore();
  store.writeText(target, "replacement");
  const directory = path.join(outputRoot, store.historyPath());
  const index = JSON.parse(fs.readFileSync(path.join(directory, "index.json"), "utf8"));
  assert.equal(index.files.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, index.files[0].backupPath), "utf8"), "original manifest");
  assert.equal(fs.readFileSync(target, "utf8"), "replacement");
});

test("failed atomic replacement keeps the original and removes its temporary file", (context) => {
  const outputRoot = temporaryDirectory(context, "course-file-atomic-failure-");
  const target = path.join(outputRoot, "manifest.json");
  fs.writeFileSync(target, "original");
  const store = createCourseFileStore({ outputRoot });
  context.mock.method(fs, "renameSync", () => { throw new Error("rename failed"); });
  assert.throws(() => store.writeText(target, "replacement"), /rename failed/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(outputRoot), ["manifest.json"]);
});

test("history rejects traversal, symlinks and mutation of reserved backup paths", (context) => {
  const parent = temporaryDirectory(context, "course-file-history-links-");
  const outputRoot = path.join(parent, "course");
  fs.mkdirSync(outputRoot);
  const store = createCourseFileStore({ outputRoot, preserveHistory: true });
  const target = path.join(outputRoot, "manifest.json");
  fs.writeFileSync(target, "original");
  for (const operation of [store.writeText, store.preserveFile]) {
    assert.throws(() => operation(path.join(parent, "outside.txt"), "blocked"), /outside the course output root/);
  }
  const linked = path.join(outputRoot, "linked.json");
  fs.symlinkSync(target, linked);
  assert.throws(() => store.writeText(linked, "blocked"), /symbolic link/);
  assert.throws(() => store.preserveFile(linked), /symbolic link/);
  const historyRoot = path.join(outputRoot, ".fetch-history");
  assert.throws(() => store.writeText(path.join(historyRoot, "index.json"), "blocked"), /reserved/);
  assert.throws(() => store.ensureDirectory(historyRoot), /reserved/);
  fs.mkdirSync(path.join(parent, "outside"));
  fs.symlinkSync(path.join(parent, "outside"), historyRoot, "dir");
  assert.throws(() => store.writeText(target, "blocked"), /outside the course output root/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(path.join(parent, "outside")), []);
});
