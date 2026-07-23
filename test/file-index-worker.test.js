const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const PROJECT_ROOT = path.resolve(__dirname, "..");

test("file-index worker composes the archive query service and writes schema v3", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-index-worker-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveRoot = path.join(root, "archive");
  const outputDirectory = "2025-26/1st Term/Test Course";
  const courseRoot = path.join(archiveRoot, outputDirectory);
  const outputFile = path.join(root, "runtime", "file-index.json");
  fs.mkdirSync(path.join(courseRoot, "01_Course_Contents"), { recursive: true });
  fs.writeFileSync(path.join(courseRoot, "01_Course_Contents", "notes.txt"), "worker searchable text");
  fs.writeFileSync(path.join(courseRoot, "manifest.json"), JSON.stringify({
    generatedAt: "2026-07-23T00:00:00.000Z",
    coverage: { complete: true },
    downloads: [{ path: "01_Course_Contents/notes.txt", size: 22 }],
  }));
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, "courses.json"), JSON.stringify({
    generatedAt: "2026-07-23T00:00:00.000Z",
    courses: [{
      id: "_1_1",
      externalId: "2025R1-TEST1000-ULTRA",
      name: "Test Course",
      outputDirectory,
      term: { name: "2025-26: 1st Term" },
    }],
  }));

  const messages = [];
  let stderr = "";
  const worker = fork(path.join(PROJECT_ROOT, "dashboard", "file-index-worker.js"), [], {
    env: { ...process.env, BB_ARCHIVE_ROOT: archiveRoot, BB_FILE_INDEX: outputFile },
    silent: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.kill("SIGKILL");
      reject(new Error("file-index worker timed out"));
    }, 10_000);
    worker.on("message", (message) => messages.push(message));
    worker.stderr.on("data", (chunk) => { stderr += chunk; });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(exitCode, 0, stderr);
  assert.equal(messages.some((message) => message.type === "complete"), true);
  const index = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(index.schemaVersion, 3);
  assert.equal(index.fileCount, 2);
  assert.equal(index.searchDocuments["_1_1"]["01_Course_Contents/notes.txt"], "worker searchable text");
});
