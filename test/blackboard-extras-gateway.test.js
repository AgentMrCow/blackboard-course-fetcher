const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PlaywrightBlackboardExtrasGateway,
  waitWithTimeout,
} = require("../src/adapters/blackboard/playwright-blackboard-extras-gateway");

const BASE = "https://blackboard.example.edu";

function response({ method = "GET", ok = true, url, value }) {
  return {
    json: async () => value,
    ok: () => ok,
    request: () => ({ method: () => method }),
    url: () => url,
  };
}

function annotationPage({ document = { data: { id: "document" } }, sync = { record_rev: 4 } } = {}) {
  const listeners = new Map();
  return {
    close: async () => {},
    goto: async () => {
      const handler = listeners.get("response");
      handler(response({
        url: "https://annotate.example.edu/api/document.json",
        value: document,
      }));
      handler(response({
        method: "POST",
        url: "https://annotate.example.edu/api/sync",
        value: sync,
      }));
      return { ok: () => true, status: () => 200 };
    },
    off: (event, handler) => {
      if (listeners.get(event) === handler) listeners.delete(event);
    },
    on: (event, handler) => listeners.set(event, handler),
    waitForTimeout: async () => {},
  };
}

test("Extras gateway captures achievements and annotations in one browser context", async () => {
  const closed = { browser: 0, context: 0, pages: 0 };
  const listResponse = response({
    url: `${BASE}/lms-achievements/api/courses/_1_1/achievements`,
    value: { results: [{ id: "award-1" }] },
  });
  const unreadResponse = response({
    url: `${BASE}/lms-achievements/api/courses/_1_1/achievements/unread`,
    value: { unreadAchievementIds: ["award-1"] },
  });
  let waitIndex = 0;
  const waitTimeouts = [];
  const achievementsPage = {
    close: async () => { closed.pages += 1; },
    goto: async () => {},
    url: () => `${BASE}/ultra/courses/_1_1/achievements`,
    waitForResponse: async (predicate, options) => {
      waitTimeouts.push(options.timeout);
      const candidate = waitIndex++ === 0 ? listResponse : unreadResponse;
      assert.equal(predicate(candidate), true);
      return candidate;
    },
  };
  const capturePage = annotationPage();
  capturePage.close = async () => { closed.pages += 1; };
  const pages = [achievementsPage, capturePage];
  const gateway = new PlaywrightBlackboardExtrasGateway({
    base: BASE,
    stateFile: "/private/state.json",
    annotationSettleMs: 0,
    launchBrowser: async () => ({
      close: async () => { closed.browser += 1; },
      newContext: async (options) => {
        assert.deepEqual(options, { storageState: "/private/state.json", acceptDownloads: true });
        return {
          close: async () => { closed.context += 1; },
          newPage: async () => pages.shift(),
        };
      },
    }),
  });

  const result = await gateway.collect({
    achievementsUrl: `${BASE}/ultra/courses/_1_1/achievements`,
    annotationRequests: [{ id: 7 }],
    refreshAnnotationViewUrl: async () => "https://annotate.example.edu/view?ticket=private",
    onAnnotationCapture: async (request, capture) => ({
      requestId: request.id,
      revision: capture.syncData.record_rev,
      documentId: capture.documentMetadata.data.id,
    }),
  });

  assert.deepEqual(result.achievements.value, {
    list: { results: [{ id: "award-1" }] },
    unread: { unreadAchievementIds: ["award-1"] },
  });
  assert.deepEqual(result.annotations, [{
    id: 7,
    value: { requestId: 7, revision: 4, documentId: "document" },
  }]);
  assert.deepEqual(waitTimeouts, [30000, 5000]);
  assert.deepEqual(closed, { browser: 1, context: 1, pages: 2 });
});

test("annotation capture refreshes and retries after the archive callback fails", async () => {
  let captureCalls = 0;
  let refreshCalls = 0;
  const pages = [annotationPage(), annotationPage({ sync: { record_rev: 5 } })];
  const gateway = new PlaywrightBlackboardExtrasGateway({
    base: BASE,
    stateFile: "/private/state.json",
    annotationSettleMs: 0,
    launchBrowser: async () => ({
      close: async () => {},
      newContext: async () => ({ close: async () => {}, newPage: async () => pages.shift() }),
    }),
  });

  const result = await gateway.collect({
    annotationRequests: [{ id: 2 }],
    refreshAnnotationViewUrl: async () => {
      refreshCalls += 1;
      return `https://annotate.example.edu/view?ticket=${refreshCalls}`;
    },
    onAnnotationCapture: async (_request, capture) => {
      captureCalls += 1;
      if (captureCalls === 1) throw new Error("archive write failed");
      return capture.syncData.record_rev;
    },
  });

  assert.deepEqual(result.annotations, [{ id: 2, value: 5 }]);
  assert.equal(refreshCalls, 2);
  assert.equal(captureCalls, 2);
});

test("Classic annotation capture discovers a fresh frame without the REST callback", async () => {
  const capturePage = annotationPage();
  let classicClosed = 0;
  const classicPage = {
    close: async () => { classicClosed += 1; },
    frames: () => [{ url: () => "https://annotate.example.edu/view?ticket=fresh" }],
    goto: async () => ({ ok: () => true, status: () => 200 }),
    url: () => `${BASE}/webapps/assignment/uploadAssignment`,
    waitForTimeout: async () => {},
  };
  const pages = [capturePage, classicPage];
  const gateway = new PlaywrightBlackboardExtrasGateway({
    base: BASE,
    stateFile: "/private/state.json",
    annotationSettleMs: 0,
    launchBrowser: async () => ({
      close: async () => {},
      newContext: async () => ({ close: async () => {}, newPage: async () => pages.shift() }),
    }),
  });

  const result = await gateway.collect({
    annotationRequests: [{ id: 3, classicHistoryUrl: `${BASE}/webapps/assignment/uploadAssignment` }],
    refreshAnnotationViewUrl: async () => { throw new Error("should not be called"); },
    onAnnotationCapture: async (_request, capture) => capture.syncData.record_rev,
  });

  assert.deepEqual(result.annotations, [{ id: 3, value: 4 }]);
  assert.equal(classicClosed, 1);
});

test("Extras gateway records two annotation failures and closes setup resources", async () => {
  const closed = { browser: 0, context: 0 };
  const gateway = new PlaywrightBlackboardExtrasGateway({
    base: BASE,
    stateFile: "/private/state.json",
    annotationSyncTimeoutMs: 1,
    launchBrowser: async () => ({
      close: async () => { closed.browser += 1; },
      newContext: async () => ({
        close: async () => { closed.context += 1; },
        newPage: async () => ({
          close: async () => {},
          goto: async () => {},
          off: () => {},
          on: () => {},
          waitForTimeout: async () => {},
        }),
      }),
    }),
  });

  const result = await gateway.collect({
    annotationRequests: [{ id: 9 }],
    refreshAnnotationViewUrl: async () => "https://annotate.example.edu/view?ticket=private",
  });

  assert.equal(result.annotations[0].id, 9);
  assert.match(result.annotations[0].firstError, /Annotate sync timed out/);
  assert.match(result.annotations[0].retryError, /Annotate sync timed out/);
  assert.deepEqual(closed, { browser: 1, context: 1 });
});

test("waitWithTimeout resolves promptly and rejects stalled work", async () => {
  assert.equal(await waitWithTimeout(Promise.resolve("done"), 100, "late"), "done");
  await assert.rejects(() => waitWithTimeout(new Promise(() => {}), 1, "timed out"), /timed out/);
});
