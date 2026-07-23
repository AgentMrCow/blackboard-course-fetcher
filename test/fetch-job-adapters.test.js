const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const { JsonJobRepository } = require("../src/adapters/filesystem/json-job-repository");
const { NodeCourseFetchRunner } = require("../src/adapters/system/node-course-fetch-runner");
const { NodeFetchProcessRunner } = require("../src/adapters/system/node-fetch-process-runner");

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("JSON job repository preserves schema compatibility and bounds history", (context) => {
  const root = temporaryDirectory(context, "blackboard-job-repository-");
  const file = path.join(root, "runtime", "jobs.json");
  const repository = new JsonJobRepository({ file, historyLimit: 2 });
  repository.save([
    { id: "one", tasks: [{ status: "paused", processPaused: 1 }] },
    { id: "two", tasks: [] },
    { id: "old", tasks: [] },
  ]);

  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(persisted.batches.map((batch) => batch.id), ["one", "two"]);
  assert.equal(persisted.batches[0].tasks[0].processPaused, true);
  assert.deepEqual(repository.load().map((batch) => batch.id), ["one", "two"]);
});

test("Node fetch process runner owns CLI arguments, line streaming, and process-group signals", async (context) => {
  const root = temporaryDirectory(context, "blackboard-process-runner-");
  const child = new EventEmitter();
  child.pid = 4321;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { throw new Error("fallback should not be used"); };
  let invocation;
  const signals = [];
  const runner = new NodeFetchProcessRunner({
    environment: { EXISTING: "value" },
    executable: "/node",
    killImpl: (pid, signal) => signals.push({ pid, signal }),
    platform: "linux",
    scriptDirectory: root,
    spawnImpl(command, args, options) {
      invocation = { args, command, options };
      return child;
    },
  });
  const stdout = [];
  const stderr = [];
  let exit;
  runner.startFetch({
    attachmentConcurrency: 3,
    base: "https://blackboard.example.edu",
    courseId: "_1_1",
    courseName: "Test Course",
    courseTerm: "2025-26: 1st Term",
    mode: "full",
    outputPath: path.join(root, "archive"),
    reuseValidatedCache: true,
    stateFile: path.join(root, "state.json"),
  }, {
    onExit: (code, signal) => { exit = { code, signal }; },
    onStderr: (line) => stderr.push(line),
    onStdout: (line) => stdout.push(line),
  });
  child.stdout.write("first\npart");
  child.stdout.end("ial\n");
  child.stderr.end("warning\n");
  child.emit("close", 2, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(invocation.command, "/node");
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.env.BB_COURSE_NAME, "Test Course");
  assert.equal(invocation.options.env.BB_PROGRESS_EVENTS, "1");
  assert.deepEqual(invocation.args, [
    path.join(root, "bin", "fetch-blackboard-course.js"),
    "--course-id", "_1_1",
    "--output", path.join(root, "archive"),
    "--state", path.join(root, "state.json"),
    "--download-mode", "full",
    "--attachment-concurrency", "3",
    "--base", "https://blackboard.example.edu",
    "--reuse-validated-cache",
  ]);
  assert.deepEqual(stdout, ["first", "partial"]);
  assert.deepEqual(stderr, ["warning"]);
  assert.deepEqual(exit, { code: 2, signal: null });
  assert.equal(runner.signal(child, "SIGSTOP"), true);
  assert.deepEqual(signals, [{ pid: -4321, signal: "SIGSTOP" }]);
});

test("Node CLI course runner shares the worker protocol and resolves process results", async (context) => {
  const root = temporaryDirectory(context, "blackboard-cli-course-runner-");
  const child = new EventEmitter();
  let invocation;
  const runner = new NodeCourseFetchRunner({
    environment: { EXISTING: "value" },
    executable: "/node",
    scriptDirectory: root,
    spawnImpl(command, args, options) {
      invocation = { args, command, options };
      return child;
    },
  });
  const specification = {
    attachmentConcurrency: 3,
    base: "https://blackboard.example.edu",
    courseId: "_1_1",
    courseName: "Test Course",
    courseTerm: "2025-26: 1st Term",
    mode: "full",
    outputPath: path.join(root, "archive"),
    reuseValidatedCache: true,
    stateFile: path.join(root, "state.json"),
  };
  const pending = runner.run(specification);
  child.emit("exit", 2, null);
  const result = await pending;

  assert.equal(invocation.command, "/node");
  assert.deepEqual(invocation.args, [
    path.join(root, "bin", "fetch-blackboard-course.js"),
    "--course-id", "_1_1",
    "--output", path.join(root, "archive"),
    "--state", path.join(root, "state.json"),
    "--download-mode", "full",
    "--attachment-concurrency", "3",
    "--base", "https://blackboard.example.edu",
    "--reuse-validated-cache",
  ]);
  assert.equal(invocation.options.cwd, root);
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.env.BB_COURSE_NAME, "Test Course");
  assert.equal(invocation.options.env.BB_PROGRESS_EVENTS, undefined);
  assert.deepEqual(result, { exitCode: 2, signal: null, startError: null });
  assert.equal(fs.existsSync(specification.outputPath), true);
});

test("Node fetch process runner maps Windows control signals to supported child signals", () => {
  const delivered = [];
  const runner = new NodeFetchProcessRunner({ platform: "win32", scriptDirectory: "." });
  const child = {
    killed: false,
    kill: (signal) => delivered.push(signal),
  };

  assert.equal(runner.supportsLivePause, false);
  assert.equal(runner.signal(child, "SIGSTOP"), true);
  assert.equal(runner.signal(child, "SIGKILL"), true);
  assert.deepEqual(delivered, ["SIGTERM", "SIGKILL"]);
});
