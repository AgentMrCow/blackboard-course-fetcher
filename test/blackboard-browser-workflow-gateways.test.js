const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PlaywrightClassicSubmissionGateway,
} = require("../src/adapters/blackboard/playwright-classic-submission-gateway");
const {
  PlaywrightFeedbackDownloadGateway,
} = require("../src/adapters/blackboard/playwright-feedback-download-gateway");
const {
  PlaywrightQuizReviewGateway,
} = require("../src/adapters/blackboard/playwright-quiz-review-gateway");

const BASE = "https://blackboard.example.edu";

test("quiz review gateway returns per-page HTML and errors while reusing one browser", async () => {
  const closed = { browser: 0, context: 0 };
  let currentUrl = BASE;
  const page = {
    content: async () => `<html data-url="${currentUrl}"></html>`,
    goto: async (url) => {
      currentUrl = url;
      return url.endsWith("/missing")
        ? { ok: () => false, status: () => 404 }
        : { ok: () => true, status: () => 200 };
    },
    url: () => currentUrl,
  };
  const gateway = new PlaywrightQuizReviewGateway({
    base: BASE,
    stateFile: "/private/state.json",
    launchBrowser: async (options) => {
      assert.deepEqual(options, { headless: true });
      return {
        close: async () => { closed.browser += 1; },
        newContext: async (contextOptions) => {
          assert.deepEqual(contextOptions, { storageState: "/private/state.json" });
          return {
            close: async () => { closed.context += 1; },
            newPage: async () => page,
          };
        },
      };
    },
  });

  const results = await gateway.fetchAll([
    { id: 1, url: `${BASE}/review/ok` },
    { id: 2, url: `${BASE}/review/missing` },
  ]);

  assert.equal(results[0].id, 1);
  assert.equal(results[0].finalUrl, `${BASE}/review/ok`);
  assert.match(results[0].html, /review\/ok/);
  assert.deepEqual(results[1], { id: 2, error: "Classic quiz review returned HTTP 404" });
  assert.deepEqual(closed, { browser: 1, context: 1 });
});

test("quiz review gateway closes a launched browser when context setup fails", async () => {
  let closed = 0;
  const gateway = new PlaywrightQuizReviewGateway({
    base: BASE,
    stateFile: "/private/state.json",
    launchBrowser: async () => ({
      close: async () => { closed += 1; },
      newContext: async () => { throw new Error("context failed"); },
    }),
  });

  await assert.rejects(() => gateway.fetchAll([{ id: 1, url: `${BASE}/review` }]), /context failed/);
  assert.equal(closed, 1);
});

test("feedback gateway performs the Blackboard menu flow and saves the download", async () => {
  const actions = [];
  let currentUrl = BASE;
  const download = {
    failure: async () => null,
    saveAs: async (destination) => { actions.push(["saveAs", destination]); },
    url: () => `${BASE}/download?token=private`,
  };
  const locator = (role, options) => ({
    click: async () => { actions.push(["click", role, options.name]); },
    waitFor: async (waitOptions) => { actions.push(["waitFor", role, options.name, waitOptions.state]); },
  });
  const page = {
    getByRole: locator,
    goto: async (url) => { currentUrl = url; },
    url: () => currentUrl,
    waitForEvent: async (event) => {
      actions.push(["event", event]);
      return download;
    },
  };
  const gateway = new PlaywrightFeedbackDownloadGateway({
    base: BASE,
    stateFile: "/private/state.json",
    launchBrowser: async () => ({
      close: async () => { actions.push(["close", "browser"]); },
      newContext: async (options) => {
        assert.deepEqual(options, { storageState: "/private/state.json", acceptDownloads: true });
        return {
          close: async () => { actions.push(["close", "context"]); },
          newPage: async () => page,
        };
      },
    }),
  });

  const results = await gateway.downloadAll([{
    id: "feedback-1",
    url: `${BASE}/grades/feedback`,
    attemptNumber: 2,
    fileName: "rubric.pdf",
    destination: "/archive/rubric.pdf",
  }]);

  assert.deepEqual(results, [{
    id: "feedback-1",
    downloadUrl: `${BASE}/download?token=private`,
  }]);
  assert.deepEqual(actions.slice(0, 7), [
    ["waitFor", "button", "Feedback for attempt 2", "visible"],
    ["click", "button", "Feedback for attempt 2"],
    ["waitFor", "button", "More options for rubric.pdf", "visible"],
    ["click", "button", "More options for rubric.pdf"],
    ["event", "download"],
    ["click", "menuitem", "Download"],
    ["saveAs", "/archive/rubric.pdf"],
  ]);
  assert.deepEqual(actions.slice(-2), [["close", "context"], ["close", "browser"]]);
});

test("Classic submission gateway filters attempts, deduplicates files, and captures Annotate", async () => {
  const routeActions = [];
  const files = [
    {
      attemptId: "_attempt_1",
      fileId: "_file_1",
      fileName: "report.pdf",
      url: `${BASE}/webapps/assignment/download?attempt_id=_attempt_1&file_id=_file_1`,
    },
    {
      attemptId: "_attempt_1",
      fileId: "_file_1",
      fileName: "duplicate.pdf",
      url: `${BASE}/webapps/assignment/download?attempt_id=_attempt_1&file_id=_file_1`,
    },
    {
      attemptId: "_other_1",
      fileId: "_file_2",
      fileName: "other.pdf",
      url: `${BASE}/webapps/assignment/download?attempt_id=_other_1&file_id=_file_2`,
    },
  ];
  let currentUrl = BASE;
  const page = {
    frames: () => [
      { url: () => `${BASE}/ordinary-frame` },
      { url: () => "https://annotate.example/view?ticket=secret" },
    ],
    goto: async (url) => {
      currentUrl = url;
      return { ok: () => true, status: () => 200 };
    },
    locator: () => ({ evaluateAll: async () => files }),
    url: () => currentUrl,
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
  };
  const context = {
    close: async () => {},
    newPage: async () => page,
    route: async (_pattern, handler) => {
      const exercise = async (url, type) => {
        await handler({
          abort: async () => { routeActions.push([url, "abort"]); },
          continue: async () => { routeActions.push([url, "continue"]); },
          request: () => ({ resourceType: () => type, url: () => url }),
        });
      };
      await exercise("https://annotate.example/view", "document");
      await exercise(`${BASE}/icon.png`, "image");
      await exercise(`${BASE}/page`, "document");
    },
  };
  const gateway = new PlaywrightClassicSubmissionGateway({
    base: BASE,
    stateFile: "/private/state.json",
    launchBrowser: async () => ({ close: async () => {}, newContext: async () => context }),
    settleMs: 0,
  });

  const results = await gateway.discoverAll([{
    id: 4,
    url: `${BASE}/webapps/assignment/uploadAssignment?attempt_id=_attempt_1`,
    attemptId: "_attempt_1",
  }], { blockHeavyResources: true });

  assert.deepEqual(results, [{
    id: 4,
    files: [files[0]],
    annotateUrl: "https://annotate.example/view?ticket=secret",
  }]);
  assert.deepEqual(routeActions, [
    ["https://annotate.example/view", "abort"],
    [`${BASE}/icon.png`, "abort"],
    [`${BASE}/page`, "continue"],
  ]);
});
