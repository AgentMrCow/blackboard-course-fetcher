const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createFetchAllObserver,
  parseFetchAllArguments,
  reportFetchAllResult,
  resolveFetchAllInput,
} = require("../src/adapters/cli/fetch-all-cli");
const { runFetchAllCli } = require("../src/composition/fetch-all-runtime");

test("fetch-all CLI adapter parses repeated values and resolves environment defaults", () => {
  const options = parseFetchAllArguments([
    "--course-id", "one",
    "--course-id=two",
    "--all",
    "--term", "2025-26",
    "--reuse-validated-cache",
  ]);
  assert.deepEqual(options.courseIds, ["one", "two"]);
  assert.equal(options.all, true);
  const input = resolveFetchAllInput(options, {
    cwd: "/workspace",
    environment: {
      BB_ATTACHMENT_CONCURRENCY: "4",
      BB_BASE: "https://blackboard.example.edu/",
      BB_COURSE_CONCURRENCY: "2",
      BB_STATE_FILE: "private/state.json",
    },
  });
  assert.equal(input.base, "https://blackboard.example.edu");
  assert.equal(input.stateFile, path.resolve("/workspace/private/state.json"));
  assert.equal(input.outputRoot, path.resolve("/workspace/Blackboard_Archive"));
  assert.equal(input.courseConcurrency, 2);
  assert.equal(input.attachmentConcurrency, 4);
  assert.equal(input.reuseValidatedCache, true);
});

test("fetch-all CLI observer and result reporter preserve public output", () => {
  const output = [];
  const errors = [];
  const observer = createFetchAllObserver({
    writeError: (value) => errors.push(value),
    writeOutput: (value) => output.push(value),
  });
  const item = { id: "_1_1", name: "Test Course", view: "ULTRA" };
  observer.onCourseStart({ course: item, position: 0, total: 1 });
  observer.onCourseSignal({ course: item, signal: "SIGTERM" });
  observer.onCourseStartError({ course: item, error: new Error("spawn failed") });
  reportFetchAllResult({
    batchRan: false,
    index: { courses: [item] },
    noMatches: true,
  }, { outputRoot: "/archive" }, (value) => output.push(value));

  assert.deepEqual(output, [
    "COURSE 1/1: Test Course (_1_1, ULTRA)",
    `INVENTORY 1 courses -> ${path.join("/archive", "courses.json")}`,
    "No courses matched the selection filters.",
  ]);
  assert.deepEqual(errors, [
    "COURSE STOPPED Test Course: signal SIGTERM",
    "FAILED TO START Test Course: spawn failed",
  ]);
});

test("fetch-all composition executes the command and returns its exit code", async () => {
  const output = [];
  let receivedInput;
  const exitCode = await runFetchAllCli([
    "--base", "https://blackboard.example.edu",
    "--inventory-only",
  ], {
    createRuntime: ({ archiveRoot }) => ({
      commandService: {
        async execute(input) {
          receivedInput = input;
          return {
            batchRan: false,
            exitCode: 0,
            index: { courses: [] },
            noMatches: false,
          };
        },
      },
      archiveRoot,
    }),
    cwd: "/workspace",
    environment: { BB_STATE_FILE: "/private/state.json" },
    writeError: () => {},
    writeOutput: (value) => output.push(value),
  });

  assert.equal(exitCode, 0);
  assert.equal(receivedInput.outputRoot, path.resolve("/workspace/Blackboard_Archive"));
  assert.match(output[0], /INVENTORY 0 courses/);
});
