const test = require("node:test");
const assert = require("node:assert/strict");
const { JobManager, PROGRESS_PREFIX } = require("../src/application/fetch-jobs/job-manager");

const NOW = new Date("2026-07-23T01:00:00.000Z");

function memoryRepository(initial = []) {
  return {
    batches: structuredClone(initial),
    saves: 0,
    load() {
      return structuredClone(this.batches);
    },
    save(batches) {
      this.batches = structuredClone(batches);
      this.saves += 1;
    },
  };
}

function controlledScheduler() {
  const immediate = [];
  const delayed = new Set();
  return {
    cancel(timer) {
      delayed.delete(timer);
    },
    delay(callback, milliseconds) {
      const timer = { callback, milliseconds };
      delayed.add(timer);
      return timer;
    },
    flushSoon() {
      while (immediate.length) immediate.shift()();
    },
    soon(callback) {
      immediate.push(callback);
    },
  };
}

function archiveService() {
  const course = {
    id: "_1_1",
    code: "TEST1000",
    name: "Test Course",
    outputDirectory: "2025-26/1st Term/Test Course",
    term: { sourceName: "2025-26: 1st Term" },
    archive: null,
  };
  return {
    course,
    coursePath: () => "/archive/test-course",
    enrichCourse: (value) => ({ ...value, archive: { status: "complete", totalMs: 42_000 } }),
    getCourseRecord: () => course,
    getInventory: () => ({ courses: [course] }),
    invalidate() {},
  };
}

function fakeProcessRunner() {
  return {
    exits: [],
    handles: [],
    signals: [],
    specifications: [],
    supportsLivePause: true,
    signal(handle, signal) {
      this.signals.push({ handle, signal });
      return true;
    },
    startFetch(specification, handlers) {
      const handle = { id: this.handles.length + 1 };
      this.handles.push(handle);
      this.specifications.push(specification);
      this.exits.push(handlers);
      return handle;
    },
  };
}

test("application manager reconciles persisted jobs through its repository port", () => {
  const repository = memoryRepository([{
    id: "old",
    status: "running",
    tasks: [{ courseId: "_1_1", status: "running", processPaused: false }],
  }]);
  const manager = new JobManager({
    archiveService: archiveService(),
    clock: () => NOW,
    jobRepository: repository,
    processRunner: fakeProcessRunner(),
    scheduler: controlledScheduler(),
  });

  assert.equal(manager.batches[0].status, "interrupted");
  assert.equal(manager.batches[0].tasks[0].status, "interrupted");
  assert.equal(repository.saves, 1);
});

test("application manager starts a fetch through the runner port and records completion", () => {
  const repository = memoryRepository();
  const runner = fakeProcessRunner();
  const scheduler = controlledScheduler();
  const manager = new JobManager({
    archiveService: archiveService(),
    clock: () => NOW,
    idFactory: () => "fetch-test",
    jobRepository: repository,
    processRunner: runner,
    scheduler,
  });
  manager.createAndStart({
    attachmentConcurrency: 3,
    courseConcurrency: 1,
    courseIds: ["_1_1"],
    mode: "placeholder",
    reuseValidatedCache: false,
  }, { base: "https://blackboard.example.edu", stateFile: "/private/state.json" });
  scheduler.flushSoon();

  assert.equal(runner.specifications.length, 1);
  assert.equal(runner.specifications[0].courseId, "_1_1");
  assert.equal(runner.specifications[0].attachmentConcurrency, 3);
  runner.exits[0].onStdout(`${PROGRESS_PREFIX}${JSON.stringify({ type: "item", label: "Lecture 1" })}`);
  assert.equal(manager.batches[0].tasks[0].currentItem, "Lecture 1");
  runner.exits[0].onExit(0, null);

  assert.equal(manager.batches[0].tasks[0].status, "completed");
  assert.equal(manager.batches[0].status, "completed");
  assert.equal(manager.batches[0].tasks[0].result.status, "complete");
  assert.ok(repository.saves >= 3);
});

test("application manager delegates live pause and resume signals to the runner", () => {
  const runner = fakeProcessRunner();
  const scheduler = controlledScheduler();
  const manager = new JobManager({
    archiveService: archiveService(),
    clock: () => NOW,
    idFactory: () => "fetch-control",
    jobRepository: memoryRepository(),
    processRunner: runner,
    scheduler,
  });
  manager.createAndStart({ courseIds: ["_1_1"], mode: "placeholder" }, {
    base: "https://blackboard.example.edu",
    stateFile: "/private/state.json",
  });
  scheduler.flushSoon();

  manager.controlTask("fetch-control", "_1_1", "pause");
  assert.equal(manager.batches[0].tasks[0].status, "paused");
  manager.controlTask("fetch-control", "_1_1", "resume");
  assert.equal(manager.batches[0].tasks[0].status, "running");
  assert.deepEqual(runner.signals.map((entry) => entry.signal), ["SIGSTOP", "SIGCONT"]);
});

function startTestFetch({ runner = fakeProcessRunner(), service = archiveService(), clock = () => NOW } = {}) {
  const repository = memoryRepository();
  const scheduler = controlledScheduler();
  const manager = new JobManager({
    archiveService: service,
    clock,
    idFactory: () => "fetch-failure",
    jobRepository: repository,
    processRunner: runner,
    scheduler,
  });
  manager.createAndStart({ courseIds: ["_1_1"], mode: "placeholder" }, {
    base: "https://blackboard.example.edu",
    stateFile: "/private/state.json",
  });
  scheduler.flushSoon();
  return { manager, repository, runner, scheduler, task: manager.batches[0].tasks[0] };
}

test("fatal progress retains a long cause through process exit and persistence alongside an older usable archive", () => {
  const service = archiveService();
  service.enrichCourse = (course) => ({ ...course, archive: { status: "complete", fileCount: 54, errors: 0 } });
  const { task, runner, repository } = startTestFetch({ service });
  const message = `GET https://blackboard.example.edu/resource?query=${"x".repeat(1200)} failed: 403 Forbidden bb-rest-course-is-private`;
  runner.exits[0].onStdout(`${PROGRESS_PREFIX}${JSON.stringify({ type: "fatal", message })}`);
  assert.equal(task.failure.code, "course-unavailable");
  assert.equal(task.failure.details, message);
  runner.exits[0].onStderr("Previous manifest retained; failed attempt written to manifest.failed.json");
  runner.exits[0].onExit(1, null);
  assert.equal(task.status, "failed");
  assert.equal(task.currentItem, task.failure.message);
  assert.equal(task.exitCode, 1);
  assert.equal(task.result.status, "complete");
  assert.deepEqual(repository.batches[0].tasks[0].failure, task.failure);
});

test("plain startup stderr supplies an actionable reason when the worker cannot emit progress", () => {
  const { task, runner } = startTestFetch();
  runner.exits[0].onStderr("retrying API after HTTP 503");
  runner.exits[0].onStderr("Missing session state /private/state.json. Run playwright-cli state-save after logging in.");
  runner.exits[0].onExit(1, null);
  assert.equal(task.failure.code, "session-required");
  assert.match(task.currentItem, /Refresh the saved session/);
});

test("retry clears the previous failure and does not attribute old stderr to the new attempt", () => {
  let now = NOW;
  const { manager, task, runner, scheduler } = startTestFetch({ clock: () => now });
  runner.exits[0].onStderr("Error: 403 Forbidden bb-rest-course-is-private");
  runner.exits[0].onExit(1, null);
  assert.equal(task.failure.code, "course-unavailable");
  now = new Date(NOW.getTime() + 1000);
  manager.controlTask("fetch-failure", "_1_1", "resume");
  assert.equal(task.failure, null);
  scheduler.flushSoon();
  assert.equal(task.failure, null);
  assert.equal(task.status, "running");
  runner.exits[1].onExit(1, null);
  assert.equal(task.failure, null);
  assert.equal(task.currentItem, "Fetcher exited with code 1");
});

for (const mode of ["throw", "callback"]) {
  test(`runner startup failure (${mode}) preserves the cause and leaves no running child`, () => {
    const runner = fakeProcessRunner();
    runner.startFetch = (specification, handlers) => {
      const error = new Error("spawn node ENOENT");
      if (mode === "throw") throw error;
      handlers.onError(error);
      handlers.onExit(null, null);
      return { id: 1 };
    };
    const { task, manager } = startTestFetch({ runner });
    assert.equal(task.status, "failed");
    assert.equal(task.currentItem, "Unable to start fetch: spawn node ENOENT");
    assert.equal(manager.children.size, 0);
    assert.equal(manager.batches[0].status, "completed_with_issues");
  });
}
