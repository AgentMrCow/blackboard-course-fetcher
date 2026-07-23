const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCourseFetchArguments,
  resolveCourseFetchInput,
} = require("../src/adapters/cli/course-fetch-cli");
const {
  validateCourseFetchInput,
} = require("../src/application/course-fetch/course-fetch-configuration");

test("single-course CLI parsing preserves permissive worker arguments", () => {
  assert.deepEqual(parseCourseFetchArguments([
    "ignored-positional",
    "--course-id", "_123_1",
    "--base=https://blackboard.example.edu/",
    "--reuse-validated-cache",
    "--output", "archive/course",
  ]), {
    base: "https://blackboard.example.edu/",
    "course-id": "_123_1",
    output: "archive/course",
    "reuse-validated-cache": true,
  });
});

test("single-course CLI input resolves paths and environment defaults", () => {
  const input = resolveCourseFetchInput({
    "attachment-concurrency": "4",
    "course-id": " _123_1 ",
    "download-mode": "FULL",
    "reuse-validated-cache": true,
  }, {
    cwd: "/workspace",
    environment: {
      BB_BASE: "https://blackboard.example.edu/",
      BB_COURSE_NAME: "Example Course",
      BB_COURSE_TERM: "2025-26: 2nd Term",
      BB_OUT_ROOT: "archive/course",
      BB_PROGRESS_EVENTS: "1",
      BB_STATE_FILE: "private/state.json",
    },
  });

  assert.deepEqual(input, {
    attachmentConcurrency: 4,
    base: "https://blackboard.example.edu",
    courseId: "_123_1",
    courseNameHint: "Example Course",
    courseTermHint: "2025-26: 2nd Term",
    downloadMode: "full",
    outputRoot: path.resolve("/workspace/archive/course"),
    progressEvents: true,
    reuseValidatedCache: true,
    stateFile: path.resolve("/workspace/private/state.json"),
  });
});

test("single-course input validation preserves public CLI failures", () => {
  const valid = {
    attachmentConcurrency: 2,
    base: "https://blackboard.example.edu",
    courseId: "_123_1",
    downloadMode: "placeholder",
    stateFile: "/private/state.json",
  };
  const presentState = { exists: () => true };

  assert.doesNotThrow(() => validateCourseFetchInput(valid, presentState));
  assert.throws(
    () => validateCourseFetchInput({ ...valid, courseId: "" }, presentState),
    { message: "Missing --course-id (or BB_COURSE_ID)." }
  );
  assert.throws(
    () => validateCourseFetchInput({ ...valid, base: "blackboard.example.edu" }, presentState),
    { message: "Missing or invalid --base Blackboard URL (or BB_BASE)." }
  );
  assert.throws(
    () => validateCourseFetchInput({ ...valid, downloadMode: "metadata" }, presentState),
    { message: "Unsupported download mode metadata; expected full or placeholder." }
  );
  assert.throws(
    () => validateCourseFetchInput({ ...valid, attachmentConcurrency: 9 }, presentState),
    { message: "Invalid --attachment-concurrency; expected an integer from 1 to 8." }
  );
  assert.throws(
    () => validateCourseFetchInput(valid, { exists: () => false }),
    { message: "Missing session state /private/state.json. Run playwright-cli state-save after logging in." }
  );
});
