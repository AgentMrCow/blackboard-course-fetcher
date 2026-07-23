const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const { currentArchiveSignature } = require("../src/adapters/filesystem/archive-signature");
const { FileIndexCacheRepository } = require("../src/adapters/filesystem/file-index-cache-repository");
const { NodeFileIndexRunner } = require("../src/adapters/system/node-file-index-runner");

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  return child;
}

test("file-index cache repository accepts only the current archive generation", (context) => {
  const root = temporaryDirectory(context, "blackboard-index-cache-");
  const archiveRoot = path.join(root, "archive");
  const courseRoot = path.join(archiveRoot, "term", "course");
  const indexFile = path.join(root, "runtime", "file-index.json");
  fs.mkdirSync(courseRoot, { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, "courses.json"), JSON.stringify({
    generatedAt: "2026-07-23T01:00:00.000Z",
    courses: [{ id: "_1_1", outputDirectory: "term/course" }],
  }));
  fs.writeFileSync(path.join(courseRoot, "manifest.json"), JSON.stringify({ generatedAt: "2026-07-23T01:00:00.000Z" }));
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const index = {
    schemaVersion: 3,
    generatedAt: "2026-07-23T01:01:00.000Z",
    archiveRoot,
    inventoryGeneratedAt: "2026-07-23T01:00:00.000Z",
    archiveSignature: currentArchiveSignature(archiveRoot),
    courseCount: 1,
    fileCount: 3,
    bytes: 100,
    courses: { "_1_1": [] },
  };
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const repository = new FileIndexCacheRepository({ file: indexFile });

  assert.deepEqual(repository.load({ archiveRoot }), index);
  fs.writeFileSync(path.join(courseRoot, "manifest.json"), JSON.stringify({ generatedAt: "2026-07-23T02:00:00.000Z" }));
  assert.equal(repository.load({ archiveRoot }), null);
  assert.equal(repository.load({ archiveRoot: path.join(root, "other") }), null);
});

test("file-index runner owns worker path, environment, IPC, stderr, and signals", () => {
  const child = fakeChild();
  const signals = [];
  let invocation;
  const runner = new NodeFileIndexRunner({
    dashboardDirectory: "/project/dashboard",
    environment: { EXISTING: "value" },
    forkImpl(modulePath, args, options) {
      invocation = { modulePath, args, options };
      return child;
    },
    scriptDirectory: "/project",
    signalImpl(handle, signal) {
      signals.push({ handle, signal });
      return true;
    },
  });
  const messages = [];
  let exit;
  runner.start({ archiveRoot: "/archive", outputFile: "/runtime/index.json" }, {
    onExit: (result) => { exit = result; },
    onMessage: (message) => messages.push(message),
  });
  child.emit("message", { type: "progress", fileCount: 2 });
  child.stderr.end("index failure details\n");
  child.emit("exit", 1, null);

  assert.equal(invocation.modulePath, path.resolve("/project/dashboard/file-index-worker.js"));
  assert.deepEqual(invocation.args, []);
  assert.equal(invocation.options.cwd, path.resolve("/project"));
  assert.equal(invocation.options.env.EXISTING, "value");
  assert.equal(invocation.options.env.BB_ARCHIVE_ROOT, "/archive");
  assert.equal(invocation.options.env.BB_FILE_INDEX, "/runtime/index.json");
  assert.deepEqual(messages, [{ type: "progress", fileCount: 2 }]);
  assert.match(exit.stderr, /index failure details/);
  assert.equal(runner.signal(child, "SIGTERM"), true);
  assert.deepEqual(signals, [{ handle: child, signal: "SIGTERM" }]);
});
