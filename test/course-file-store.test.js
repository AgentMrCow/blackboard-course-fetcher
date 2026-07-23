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
