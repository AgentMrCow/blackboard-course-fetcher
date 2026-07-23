const test = require("node:test");
const assert = require("node:assert/strict");
const { FetchAllCommandService, validateFetchAllInput } = require("../src/application/fetch-all/fetch-all-command-service");
const { CourseFetchBatchService } = require("../src/application/fetch-jobs/course-fetch-batch-service");

const INPUT = {
  all: false,
  attachmentConcurrency: 2,
  base: "https://blackboard.example.edu",
  confirmFull: false,
  courseConcurrency: 2,
  courseIds: [],
  downloadMode: "placeholder",
  includeUnavailable: false,
  inventoryOnly: true,
  limit: null,
  outputRoot: "/archive",
  reuseValidatedCache: false,
  stateFile: "/private/state.json",
  term: undefined,
  view: "ALL",
};

function course(id) {
  return {
    id,
    name: `Course ${id}`,
    outputPath: `/archive/${id}`,
    term: { sourceName: "2025-26: 1st Term" },
    view: "ULTRA",
  };
}

test("course fetch batch service bounds concurrency and persists every transition", async () => {
  const courses = [course("one"), course("two"), course("three")];
  const index = { courses };
  let active = 0;
  let maximumActive = 0;
  const specifications = [];
  const saves = [];
  const refreshed = [];
  const starts = [];
  const signals = [];
  const service = new CourseFetchBatchService({
    courseRunner: {
      async run(specification) {
        specifications.push(specification);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, specification.courseId === "one" ? 15 : 5));
        active -= 1;
        return specification.courseId === "two"
          ? { exitCode: 1, signal: "SIGTERM", startError: null }
          : { exitCode: 0, signal: null, startError: null };
      },
    },
    inventoryService: {
      refreshArchiveStatus(item) { refreshed.push(item.id); return null; },
      save(value) { saves.push(value.courses.map((item) => item.fetchStatus)); },
    },
  });

  const result = await service.run({
    attachmentConcurrency: 3,
    base: INPUT.base,
    courseConcurrency: 2,
    downloadMode: "full",
    index,
    reuseValidatedCache: true,
    selected: courses,
    stateFile: INPUT.stateFile,
  }, {
    onCourseSignal: ({ course: item, signal }) => signals.push([item.id, signal]),
    onCourseStart: ({ course: item, position, total }) => starts.push([item.id, position, total]),
  });

  assert.deepEqual(result, { completed: 2, failures: 1, total: 3 });
  assert.equal(maximumActive, 2);
  assert.equal(saves.length, 6);
  assert.deepEqual(refreshed.sort(), ["one", "three", "two"]);
  assert.deepEqual(courses.map((item) => item.fetchStatus), ["complete", "incomplete (exit 1)", "complete"]);
  assert.deepEqual(signals, [["two", "SIGTERM"]]);
  assert.deepEqual(starts.map(([id]) => id), ["one", "two", "three"]);
  assert.equal(specifications[0].attachmentConcurrency, 3);
  assert.equal(specifications[0].reuseValidatedCache, true);
});

test("fetch-all command validates, prepares, and returns inventory-only results", async () => {
  const calls = [];
  const index = { courses: [course("one")] };
  const command = new FetchAllCommandService({
    batchService: { run: async () => { throw new Error("batch should not run"); } },
    inventoryService: {
      prepare: () => calls.push("prepare"),
      refresh: async (specification) => {
        calls.push(["refresh", specification]);
        return { index, selected: [] };
      },
    },
    stateRepository: { exists: () => true },
  });

  const result = await command.execute(INPUT);
  assert.equal(result.batchRan, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.index, index);
  assert.equal(calls[0], "prepare");
  assert.equal(calls[1][1].selection.view, "ALL");
});

test("fetch-all command delegates selected courses and maps failures to exit code 2", async () => {
  const selected = [course("one")];
  let batchSpecification;
  const command = new FetchAllCommandService({
    batchService: {
      async run(specification) {
        batchSpecification = specification;
        return { completed: 0, failures: 1, total: 1 };
      },
    },
    inventoryService: {
      prepare() {},
      refresh: async () => ({ index: { courses: selected }, selected }),
    },
    stateRepository: { exists: () => true },
  });

  const result = await command.execute({ ...INPUT, courseIds: ["one"], inventoryOnly: false });
  assert.equal(result.batchRan, true);
  assert.equal(result.exitCode, 2);
  assert.equal(batchSpecification.selected, selected);
});

test("fetch-all validation preserves CLI safety checks", () => {
  assert.throws(
    () => validateFetchAllInput({ ...INPUT, base: "" }, { exists: () => true }),
    /Missing or invalid --base/
  );
  assert.throws(
    () => validateFetchAllInput(INPUT, { exists: () => false }),
    /Missing session state/
  );
  assert.throws(
    () => validateFetchAllInput({ ...INPUT, all: true, downloadMode: "full" }, { exists: () => true }),
    /Refusing an all-course full download/
  );
  assert.throws(
    () => validateFetchAllInput({ ...INPUT, courseConcurrency: 5 }, { exists: () => true }),
    /course-concurrency/
  );
});
