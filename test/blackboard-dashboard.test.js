const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDashboardSettings } = require("../src/application/dashboard-settings");
const { JobManager } = require("../src/application/fetch-jobs/job-manager");
const { stateMetadata } = require("../src/adapters/blackboard/session-state");
const { currentArchiveSignature } = require("../src/adapters/filesystem/archive-signature");
const { parseByteRange } = require("../src/adapters/http/responses");
const { assertLocalRequestHost, assertMutationOrigin, isLoopbackHost } = require("../src/adapters/http/security");
const { createFileSystemArchiveService } = require("../src/composition/archive-service-factory");
const { previewKind } = require("../src/domain/archive/archive-metadata");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-dashboard-"));
  const outputDirectory = path.join("2025-26", "1st Term", "TEST1000 - Test Course");
  const courseRoot = path.join(root, outputDirectory);
  fs.mkdirSync(path.join(courseRoot, "01_Course_Contents"), { recursive: true });
  fs.writeFileSync(path.join(courseRoot, "01_Course_Contents", "notes.txt"), "local archive search phrase\n");
  fs.writeFileSync(path.join(courseRoot, "01_Course_Contents", "slides.pdf.placeholder.json"), JSON.stringify({ placeholder: true, originalFileName: "slides.pdf" }));
  fs.writeFileSync(path.join(courseRoot, "README.md"), "# Test\n");
  fs.writeFileSync(path.join(courseRoot, "manifest.json"), JSON.stringify({
    generatedAt: "2026-07-20T00:00:00.000Z",
    downloadMode: "placeholder",
    course: { id: "_1_1", courseId: "2025R1-TEST1000-ULTRA", displayName: "Test Course" },
    contents: [{ id: "content", title: "Notes", path: "Notes", files: ["01_Course_Contents/notes.txt"] }],
    downloads: [{ path: "01_Course_Contents/notes.txt" }, { path: "01_Course_Contents/slides.pdf.placeholder.json", placeholder: true }],
    assessments: [],
    announcements: [],
    gradebook: { items: [] },
    coverage: { complete: true, content: { discovered: 1 }, courseFiles: { expected: 2, covered: 2 } },
    warnings: [],
    errors: [],
  }));
  fs.writeFileSync(path.join(root, "courses.json"), JSON.stringify({
    generatedAt: "2026-07-20T00:00:00.000Z",
    blackboardBase: "https://blackboard.example.edu",
    courses: [{
      id: "_1_1",
      externalId: "2025R1-TEST1000-ULTRA",
      name: "2025R1 Test Course (TEST1000-ULTRA)",
      term: { sourceName: "Old 2025-26: 1st Term", name: "2025-26: 1st Term" },
      view: "ULTRA",
      available: true,
      outputDirectory,
    }],
  }));
  return { root, courseRoot };
}

function createTestJobManager(archiveService) {
  let persisted = { schemaVersion: 1, batches: [] };
  return new JobManager({
    archiveService,
    jobRepository: {
      load: () => persisted,
      save(value) { persisted = value; },
    },
    processRunner: { supportsLivePause: true },
  });
}

test("archive service indexes every course file and searches text", (context) => {
  const { root } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createFileSystemArchiveService(root);
  const inventory = service.getInventory();
  assert.equal(inventory.courses.length, 1);
  assert.equal(inventory.courses[0].archive.status, "complete");
  assert.equal(inventory.courses[0].code, "TEST1000");
  const files = service.listFiles("_1_1");
  assert.equal(files.length, 4);
  assert.equal(files.find((file) => file.name.endsWith("placeholder.json")).preview, "placeholder");
  assert.equal(service.search("search phrase")[0].path, "01_Course_Contents/notes.txt");
  assert.equal(service.allFiles({ limit: 20 }).total, 2);
  assert.equal(service.allFiles({ limit: 20, scope: "all" }).total, 4);
});

test("archive search uses the background text index when available", (context) => {
  const { root, courseRoot } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createFileSystemArchiveService(root);
  const files = service.listFiles("_1_1");
  assert.equal(service.setFileIndex({
    archiveRoot: root,
    courses: { "_1_1": files },
    searchDocuments: { "_1_1": { "01_Course_Contents/notes.txt": "indexed-only phrase" } },
  }), true);
  fs.rmSync(path.join(courseRoot, "01_Course_Contents", "notes.txt"));
  const result = service.search("indexed-only");
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "01_Course_Contents/notes.txt");
});

test("archive signature changes when a course manifest changes", (context) => {
  const { root, courseRoot } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = currentArchiveSignature(root);
  const manifestFile = path.join(courseRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.generatedAt = "2026-07-20T01:00:00.000Z";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const after = currentArchiveSignature(root);
  assert.notEqual(after, before);
});

test("archive file resolution rejects traversal", (context) => {
  const { root } = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createFileSystemArchiveService(root);
  assert.throws(() => service.resolveCourseFile("_1_1", "../../outside.txt"), /Invalid archive file path/);
});

test("archive file resolution rejects symlinks leaving the course", (context) => {
  const { root, courseRoot } = fixture();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  context.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });
  fs.writeFileSync(outside, "private");
  fs.symlinkSync(outside, path.join(courseRoot, "outside-link.txt"));
  const service = createFileSystemArchiveService(root);
  assert.throws(() => service.resolveCourseFile("_1_1", "outside-link.txt"), /outside the course directory/);
});

test("preview kinds cover local learning-file formats", () => {
  assert.equal(previewKind("lecture.pdf"), "pdf");
  assert.equal(previewKind("submission.docx"), "office");
  assert.equal(previewKind("photo.jpeg"), "image");
  assert.equal(previewKind("lecture.pdf.placeholder.json"), "placeholder");
});

test("settings validation preserves conservative concurrency limits", () => {
  const current = {
    blackboardBase: "",
    archiveRoot: "/tmp/archive",
    stateFile: "/tmp/state.json",
    downloadMode: "placeholder",
    courseConcurrency: 1,
    attachmentConcurrency: 2,
  };
  const settings = normalizeDashboardSettings({
    blackboardBase: "https://blackboard.example.edu/",
    courseConcurrency: 2,
    attachmentConcurrency: 4,
  }, current, { scriptDirectory: PROJECT_ROOT });
  assert.equal(settings.blackboardBase, "https://blackboard.example.edu");
  assert.equal(settings.courseConcurrency, 2);
  assert.throws(() => normalizeDashboardSettings({ courseConcurrency: 5 }, current, { scriptDirectory: PROJECT_ROOT }), /1 to 4/);
});

test("session metadata does not expose cookie values", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-session-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [{ name: "secret", value: "private", expires: Date.now() / 1000 + 3600 }] }));
  const metadata = stateMetadata({ stateFile });
  assert.equal(metadata.cookieCount, 1);
  assert.equal(JSON.stringify(metadata).includes("private"), false);
});

test("dashboard request guards allow local same-origin use only", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.doesNotThrow(() => assertLocalRequestHost({ headers: { host: "127.0.0.1:4173" } }));
  assert.throws(() => assertLocalRequestHost({ headers: { host: "example.com:4173" } }), /loopback host/);
  assert.doesNotThrow(() => assertMutationOrigin({ method: "POST", headers: { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173", "sec-fetch-site": "same-origin" } }));
  assert.throws(() => assertMutationOrigin({ method: "POST", headers: { host: "127.0.0.1:4173", origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), /Cross-origin/);
});

test("byte ranges support bounded, open-ended, and suffix requests", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { valid: true, start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { valid: true, start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { valid: true, start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-200", 100), { valid: true, start: 0, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100).valid, false);
  assert.equal(parseByteRange("bytes=10-5", 100).valid, false);
});

test("an interrupted batch cannot resume over another active batch", () => {
  const manager = createTestJobManager({ getInventory: () => ({ courses: [] }) });
  manager.batches = [
    { id: "active", status: "running", options: { courseConcurrency: 1 }, tasks: [] },
    { id: "interrupted", status: "interrupted", options: { courseConcurrency: 1 }, tasks: [] },
  ];
  assert.throws(() => manager.controlBatch("interrupted", "resume"), /Another fetch batch is active/);
  assert.equal(manager.batches[1].status, "interrupted");
});

test("cancelling a queued batch preserves its explicit cancelled state", () => {
  const manager = createTestJobManager({ getInventory: () => ({ courses: [] }) });
  manager.batches = [{
    id: "queued",
    status: "queued",
    options: { courseConcurrency: 1 },
    tasks: [
      { id: "queued:a", courseId: "a", status: "queued", logs: [], progress: 0 },
      { id: "queued:b", courseId: "b", status: "queued", logs: [], progress: 0 },
    ],
  }];
  const result = manager.controlBatch("queued", "cancel");
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.tasks.map((task) => task.status), ["cancelled", "cancelled"]);
});
