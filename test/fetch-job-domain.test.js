const test = require("node:test");
const assert = require("node:assert/strict");
const {
  reconcilePersistedBatches,
  transitionBatchAfterTaskExit,
  transitionTaskAfterExit,
} = require("../src/domain/fetch-jobs/job-state");

const TIMESTAMP = "2026-07-23T00:00:00.000Z";

test("restart reconciliation interrupts only tasks that depended on a live process", () => {
  const original = [{
    id: "batch",
    status: "running",
    finishedAt: null,
    tasks: [
      { courseId: "running", status: "running", processPaused: false },
      { courseId: "paused-process", status: "paused", processPaused: true },
      { courseId: "paused-queue", status: "paused", processPaused: false },
      { courseId: "complete", status: "completed", processPaused: false },
    ],
  }];
  const result = reconcilePersistedBatches(original, TIMESTAMP);

  assert.equal(result.changed, true);
  assert.equal(result.batches[0].status, "interrupted");
  assert.deepEqual(result.batches[0].tasks.map((task) => task.status), [
    "interrupted",
    "interrupted",
    "paused",
    "completed",
  ]);
  assert.equal(original[0].tasks[0].status, "running");
});

test("task exit transitions distinguish success, incomplete coverage, failure, pause, and cancel", () => {
  const base = { status: "running", progress: 63, desiredAfterExit: null, processPaused: false };
  assert.equal(transitionTaskAfterExit(base, { code: 0, signal: null, timestamp: TIMESTAMP }).status, "completed");
  assert.equal(transitionTaskAfterExit(base, { code: 2, signal: null, timestamp: TIMESTAMP }).status, "incomplete");
  assert.match(transitionTaskAfterExit(base, { code: 1, signal: null, timestamp: TIMESTAMP }).currentItem, /code 1/);
  assert.match(transitionTaskAfterExit(base, { code: null, signal: "SIGTERM", timestamp: TIMESTAMP }).currentItem, /SIGTERM/);
  assert.equal(transitionTaskAfterExit({ ...base, desiredAfterExit: "paused" }, { code: null, signal: "SIGTERM", timestamp: TIMESTAMP }).finishedAt, null);
  assert.equal(transitionTaskAfterExit({ ...base, desiredAfterExit: "cancelled" }, { code: null, signal: "SIGTERM", timestamp: TIMESTAMP }).status, "cancelled");
});

test("batch completion waits for children and reports terminal task issues", () => {
  const running = { status: "running", finishedAt: null, tasks: [{ status: "completed" }] };
  assert.equal(transitionBatchAfterTaskExit(running, { activeChildren: 1, timestamp: TIMESTAMP }).status, "running");
  assert.equal(transitionBatchAfterTaskExit({ ...running, tasks: [{ status: "queued" }] }, { activeChildren: 0, timestamp: TIMESTAMP }).status, "running");
  assert.equal(transitionBatchAfterTaskExit(running, { activeChildren: 0, timestamp: TIMESTAMP }).status, "completed");
  assert.equal(transitionBatchAfterTaskExit({ ...running, tasks: [{ status: "incomplete" }] }, { activeChildren: 0, timestamp: TIMESTAMP }).status, "completed_with_issues");
  assert.equal(transitionBatchAfterTaskExit({ ...running, tasks: [{ status: "paused" }] }, { activeChildren: 0, timestamp: TIMESTAMP }).status, "paused");
});
