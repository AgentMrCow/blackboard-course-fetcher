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
  assert.equal(transitionBatchAfterTaskExit({ ...running, tasks: [{ status: "completed" }, { status: "interrupted" }] }, { activeChildren: 0, timestamp: TIMESTAMP }).status, "completed_with_issues");
  assert.equal(transitionBatchAfterTaskExit({ ...running, tasks: [{ status: "paused" }] }, { activeChildren: 0, timestamp: TIMESTAMP }).status, "paused");
});

test("specific failures survive exit while signals, success, pause, and cancellation take precedence", () => {
  const failure = { code: "course-unavailable", message: "Course unavailable (HTTP 403)", details: "bb-rest-course-is-private" };
  const task = { status: "running", failure };
  const failed = transitionTaskAfterExit(task, { code: 1, signal: null, timestamp: TIMESTAMP });
  assert.deepEqual(failed.failure, failure);
  assert.equal(failed.currentItem, failure.message);
  for (const desiredAfterExit of ["paused", "cancelled"]) {
    const stopped = transitionTaskAfterExit({ ...task, desiredAfterExit }, { code: 1, signal: null, timestamp: TIMESTAMP });
    assert.equal(stopped.status, desiredAfterExit);
    assert.equal(stopped.failure, null);
  }
  const signalled = transitionTaskAfterExit(task, { code: null, signal: "SIGTERM", timestamp: TIMESTAMP });
  assert.equal(signalled.failure, null);
  assert.match(signalled.currentItem, /SIGTERM/);
  assert.equal(transitionTaskAfterExit(task, { code: 0, signal: null, timestamp: TIMESTAMP }).failure, null);
  assert.equal(transitionTaskAfterExit(task, { code: 2, signal: null, timestamp: TIMESTAMP }).failure, null);
});

test("restart reconciliation upgrades generic historical failures without changing retained archive results", () => {
  const original = [{ status: "completed_with_issues", tasks: [{
    status: "failed",
    currentItem: "Fetcher exited with code 1",
    result: { fileCount: 54, errors: 0, status: "complete" },
    logs: [{ stream: "stderr", line: "Error: 403 Forbidden bb-rest-course-is-private" }],
  }] }];
  const result = reconcilePersistedBatches(original, TIMESTAMP);
  const task = result.batches[0].tasks[0];
  assert.equal(result.changed, true);
  assert.equal(task.failure.code, "course-unavailable");
  assert.match(task.currentItem, /Course unavailable/);
  assert.deepEqual(task.result, original[0].tasks[0].result);
  assert.equal(original[0].tasks[0].failure, undefined);
  assert.equal(reconcilePersistedBatches(result.batches, TIMESTAMP).changed, false);
});
