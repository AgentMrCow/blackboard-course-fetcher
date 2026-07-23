const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BlackboardAttachmentHtmlGateway,
} = require("../src/adapters/blackboard/blackboard-attachment-html-gateway");
const {
  PlaywrightAttachmentResourceGateway,
} = require("../src/adapters/blackboard/playwright-attachment-resource-gateway");

const BASE = "https://blackboard.example.edu";
const TARGET = `${BASE}/bbcswebdav/xid-68160866_1`;
const CANONICAL =
  `${BASE}/bbcswebdav/pid-414180-dt-announcement-rid-68160866_1/xid-68160866_1`;

test("HTML gateway uses scoped cookies and stops at the first exact replacement", async () => {
  const requests = [];
  const client = {
    cookieHeaderFor: (url) => `session-for=${new URL(url).pathname}`,
    request: async (url, options, label) => {
      requests.push({ label, options, url });
      return new Response(`<img src="${CANONICAL}">`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  };
  const gateway = new BlackboardAttachmentHtmlGateway({ base: BASE, client });
  const result = await gateway.discover({
    targetUrl: TARGET,
    uiUrls: [`${BASE}/first`, `${BASE}/second`],
  });

  assert.deepEqual(result.values, [CANONICAL]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Cookie, "session-for=/first");
  assert.equal(requests[0].label, "attachment resolver /first");
  assert.match(result.diagnostics[0], /1 exact resource match/);
});

test("HTML gateway records page failures and continues to the next UI URL", async () => {
  let calls = 0;
  const gateway = new BlackboardAttachmentHtmlGateway({
    base: BASE,
    client: {
      cookieHeaderFor: () => "session=expected",
      request: async () => {
        calls += 1;
        if (calls === 1) return new Response("failed", { status: 503, statusText: "Busy" });
        return new Response("<html>no attachment here</html>", { status: 200 });
      },
    },
  });

  const result = await gateway.discover({
    targetUrl: TARGET,
    uiUrls: [`${BASE}/first`, `${BASE}/second`],
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.values, []);
  assert.match(result.diagnostics[0], /HTTP resolver failed \(HTTP 503 Busy\)/);
  assert.match(result.diagnostics[1], /0 exact resource match/);
});

test("browser gateway observes requests and always closes its resources", async () => {
  const listeners = new Map();
  const closed = { browser: 0, context: 0 };
  const page = {
    currentUrl: `${BASE}/ultra/courses/_1_1/outline`,
    evaluate: async () => [
      `data-resource={"url":"${CANONICAL}"}`,
      "https://attacker.example/bbcswebdav/xid-68160866_1",
    ],
    goto: async () => {
      listeners.get("request")?.({ url: () => CANONICAL });
      return { status: () => 200 };
    },
    off: (event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    on: (event, listener) => listeners.set(event, listener),
    url() { return this.currentUrl; },
    waitForTimeout: async () => {},
  };
  const context = {
    close: async () => { closed.context += 1; },
    newPage: async () => page,
  };
  const gateway = new PlaywrightAttachmentResourceGateway({
    base: BASE,
    stateFile: "/private/state.json",
    launchBrowser: async () => ({
      close: async () => { closed.browser += 1; },
      newContext: async (options) => {
        assert.deepEqual(options, { storageState: "/private/state.json" });
        return context;
      },
    }),
    settleMs: 0,
  });

  const result = await gateway.discover({
    targetUrl: TARGET,
    uiUrls: [`${BASE}/ultra/courses/_1_1/outline`],
    xid: "68160866_1",
  });

  assert.deepEqual(result.values, [CANONICAL]);
  assert.match(result.diagnostics[0], /1 matching request\(s\), 2 matching DOM value\(s\)/);
  assert.deepEqual(closed, { browser: 1, context: 1 });
  assert.equal(listeners.size, 0);
});

test("browser gateway reports an authentication redirect without leaking resources", async () => {
  const closed = { browser: 0, context: 0 };
  const page = {
    goto: async () => ({ status: () => 302 }),
    off: () => {},
    on: () => {},
    url: () => "https://sso.example.edu/login",
  };
  const gateway = new PlaywrightAttachmentResourceGateway({
    base: BASE,
    stateFile: "/private/state.json",
    launchBrowser: async () => ({
      close: async () => { closed.browser += 1; },
      newContext: async () => ({
        close: async () => { closed.context += 1; },
        newPage: async () => page,
      }),
    }),
  });

  const result = await gateway.discover({
    targetUrl: TARGET,
    uiUrls: [`${BASE}/ultra/courses/_1_1/outline`],
    xid: "68160866_1",
  });

  assert.deepEqual(result.values, []);
  assert.match(result.diagnostics[0], /redirected outside the authenticated Blackboard UI/);
  assert.deepEqual(closed, { browser: 1, context: 1 });
});
