const test = require("node:test");
const assert = require("node:assert/strict");
const { describeFetchFailure, failureFromTaskLogs } = require("../src/domain/fetch-jobs/fetch-failure");

test("fetch failures explain course access and sign-in errors while retaining the original cause", () => {
  const privateError = 'GET https://blackboard.example.edu/learn/api/v1/courses/_1_1/contents failed: 403 Forbidden {"code":"bb-rest-course-is-private","message":"The course is not available"}';
  const failure = describeFetchFailure(privateError);
  assert.equal(failure.code, "course-unavailable");
  assert.match(failure.message, /Course unavailable \(HTTP 403\).*before retrying/);
  assert.equal(failure.details, privateError);
  assert.equal(describeFetchFailure("BlackboardAuthenticationError: Blackboard authentication is required; refresh the saved session").code, "session-required");
  assert.equal(describeFetchFailure("Missing session state /private/state.json. Run playwright-cli state-save after logging in.").code, "session-required");
  assert.equal(describeFetchFailure("GET resource failed: 403 Forbidden").code, "permission-denied");
  assert.equal(describeFetchFailure("Error: ENOSPC: no space left on device").message, "ENOSPC: no space left on device");
});

test("historical failure recovery ignores earlier attempts, retry warnings, and the retained-manifest notice", () => {
  const task = {
    runStartedAt: "2026-07-23T01:00:00.000Z",
    logs: [
      { at: "2026-07-23T00:59:00.000Z", stream: "stderr", line: "Error: bb-rest-course-is-private" },
      { at: "2026-07-23T01:00:01.000Z", stream: "stderr", line: "retrying API after HTTP 503" },
      { at: "2026-07-23T01:00:02.000Z", stream: "stderr", line: "Error: ENOSPC: no space left on device" },
      { at: "2026-07-23T01:00:02.000Z", stream: "stderr", line: "at main (fetch.js:12:1)" },
      { at: "2026-07-23T01:00:03.000Z", stream: "stderr", line: "Previous manifest retained; failed attempt written to manifest.failed.json" },
    ],
  };
  assert.equal(failureFromTaskLogs(task).message, "ENOSPC: no space left on device");
  assert.equal(failureFromTaskLogs({ ...task, runStartedAt: "2026-07-23T01:00:04.000Z" }), null);
  assert.equal(failureFromTaskLogs({ logs: [{ stream: "stderr", line: "Unsupported download mode invalid" }] }).message, "Unsupported download mode invalid");
});
