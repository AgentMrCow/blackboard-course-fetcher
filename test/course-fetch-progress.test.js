const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CourseFetchProgressReporter,
  PROGRESS_PREFIX,
} = require("../src/application/course-fetch/course-fetch-progress");

test("single-course progress reporter preserves phase and transfer frames", async () => {
  const frames = [];
  const logs = [];
  const elapsed = [100, 125.4];
  const timestamps = [
    new Date("2026-07-23T10:00:00.000Z"),
    new Date("2026-07-23T10:00:00.025Z"),
    new Date("2026-07-23T10:00:00.026Z"),
  ];
  const manifest = {
    timings: { phases: {} },
    transfer: { networkFiles: 1, networkBytes: 42 },
  };
  const reporter = new CourseFetchProgressReporter({
    clock: () => timestamps.shift(),
    elapsedNow: () => elapsed.shift(),
    enabled: true,
    log: (value) => logs.push(value),
    manifest,
    output: (value) => frames.push(value),
    relativePath: (value) => value.replace("/archive/course/", ""),
  });

  assert.equal(await reporter.runPhase("bootstrap", async () => "result"), "result");
  reporter.transfer("downloaded", "/archive/course/files/one.pdf", 42, "One");

  assert.equal(manifest.timings.phases.bootstrap, 25);
  assert.deepEqual(logs, ["phase bootstrap: 0.03s"]);
  assert.deepEqual(frames.map((line) => JSON.parse(line.slice(PROGRESS_PREFIX.length))), [
    {
      type: "phase-start",
      at: "2026-07-23T10:00:00.000Z",
      phase: "bootstrap",
    },
    {
      type: "phase-end",
      at: "2026-07-23T10:00:00.025Z",
      phase: "bootstrap",
      durationMs: 25,
    },
    {
      type: "transfer",
      at: "2026-07-23T10:00:00.026Z",
      kind: "downloaded",
      path: "files/one.pdf",
      size: 42,
      label: "One",
      transfer: { networkFiles: 1, networkBytes: 42 },
    },
  ]);
  assert.ok(frames.every((line) => line.endsWith("\n")));
});

test("phase timing is recorded when an operation fails and events are disabled", async () => {
  const logs = [];
  const elapsed = [10, 14.6];
  const manifest = { timings: { phases: {} }, transfer: {} };
  const reporter = new CourseFetchProgressReporter({
    elapsedNow: () => elapsed.shift(),
    enabled: false,
    log: (value) => logs.push(value),
    manifest,
  });

  await assert.rejects(
    () => reporter.runPhase("content", async () => { throw new Error("failed"); }),
    /failed/
  );
  assert.equal(manifest.timings.phases.content, 5);
  assert.deepEqual(logs, ["phase content: 0.01s"]);
});
