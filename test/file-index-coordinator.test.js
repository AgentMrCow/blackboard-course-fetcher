const test = require("node:test");
const assert = require("node:assert/strict");
const { FileIndexCoordinator } = require("../src/application/file-index/file-index-coordinator");

const SETTINGS = { archiveRoot: "/archive" };
const NOW = new Date("2026-07-23T02:00:00.000Z");

function index(overrides = {}) {
  return {
    schemaVersion: 3,
    generatedAt: "2026-07-23T01:00:00.000Z",
    archiveRoot: "/archive",
    courseCount: 2,
    fileCount: 10,
    bytes: 500,
    courses: {},
    ...overrides,
  };
}

function cacheRepository(value = null) {
  return {
    value,
    loads: [],
    load(specification) {
      this.loads.push(specification);
      return this.value;
    },
  };
}

function archiveService() {
  return {
    indexes: [],
    invalidations: [],
    invalidate(options) { this.invalidations.push(options); },
    setFileIndex(value) { this.indexes.push(value); return true; },
  };
}

function runner() {
  return {
    handlers: [],
    signals: [],
    specifications: [],
    signal(handle, signal) { this.signals.push({ handle, signal }); return true; },
    start(specification, handlers) {
      const handle = { id: this.handlers.length + 1 };
      this.specifications.push(specification);
      this.handlers.push(handlers);
      return handle;
    },
  };
}

function scheduler() {
  return {
    callbacks: [],
    defer(callback) { this.callbacks.push(callback); },
    runNext() { this.callbacks.shift()?.(); },
  };
}

test("file-index coordinator loads a valid cache without starting a worker", () => {
  const cache = cacheRepository(index());
  const archive = archiveService();
  const processRunner = runner();
  const coordinator = new FileIndexCoordinator({
    archiveService: archive,
    cacheRepository: cache,
    outputFile: "/runtime/index.json",
    runner: processRunner,
    settings: SETTINGS,
  });

  const snapshot = coordinator.initialize();
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.fileCount, 10);
  assert.deepEqual(cache.loads, [{ archiveRoot: "/archive" }]);
  assert.equal(archive.indexes.length, 1);
  assert.equal(processRunner.specifications.length, 0);
});

test("file-index coordinator reports worker progress and installs its completed cache", () => {
  const cache = cacheRepository(null);
  const archive = archiveService();
  const processRunner = runner();
  const controlledScheduler = scheduler();
  const coordinator = new FileIndexCoordinator({
    archiveService: archive,
    cacheRepository: cache,
    clock: () => NOW,
    outputFile: "/runtime/index.json",
    runner: processRunner,
    scheduler: controlledScheduler,
    settings: SETTINGS,
  });
  const updates = [];
  let ready;
  coordinator.on("update", (snapshot) => updates.push(snapshot.status));
  coordinator.on("ready", (snapshot) => { ready = snapshot; });

  assert.equal(coordinator.initialize().status, "idle");
  controlledScheduler.runNext();
  assert.equal(coordinator.snapshot().status, "running");
  assert.deepEqual(processRunner.specifications[0], { archiveRoot: "/archive", outputFile: "/runtime/index.json" });
  processRunner.handlers[0].onMessage({ type: "progress", scannedCourses: 1, totalCourses: 2, fileCount: 4 });
  assert.equal(coordinator.snapshot().scannedCourses, 1);
  processRunner.handlers[0].onMessage({ type: "complete", fileCount: 10, bytes: 500 });
  cache.value = index();
  processRunner.handlers[0].onExit({ code: 0, signal: null, stderr: "" });

  assert.equal(coordinator.active(), false);
  assert.equal(coordinator.snapshot().status, "complete");
  assert.equal(ready.fileCount, 10);
  assert.ok(updates.includes("running"));
  assert.equal(archive.indexes.length, 1);
});

test("file-index coordinator queues one replacement build and follows archive-root changes", () => {
  const cache = cacheRepository(null);
  const firstArchive = archiveService();
  const nextArchive = archiveService();
  const processRunner = runner();
  const controlledScheduler = scheduler();
  const coordinator = new FileIndexCoordinator({
    archiveService: firstArchive,
    cacheRepository: cache,
    outputFile: "/runtime/index.json",
    runner: processRunner,
    scheduler: controlledScheduler,
    settings: SETTINGS,
  });

  coordinator.start(true);
  coordinator.requestRebuild();
  assert.equal(processRunner.specifications.length, 1);
  coordinator.reconfigure({ archiveService: nextArchive, settings: { archiveRoot: "/next-archive" } });
  assert.deepEqual(processRunner.signals.map((entry) => entry.signal), ["SIGTERM"]);
  processRunner.handlers[0].onExit({ code: null, signal: "SIGTERM", stderr: "" });
  assert.deepEqual(nextArchive.invalidations, [{ fileIndex: true }]);
  assert.equal(controlledScheduler.callbacks.length, 1);
  controlledScheduler.runNext();
  assert.equal(processRunner.specifications.length, 2);
  assert.deepEqual(processRunner.specifications[1], { archiveRoot: "/next-archive", outputFile: "/runtime/index.json" });
});
