const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AttachmentUrlRecoveryService,
} = require("../src/application/course-fetch/attachment-url-recovery-service");

const BASE = "https://blackboard.example.edu";
const ORIGINAL = `${BASE}/bbcswebdav/xid-68160866_1`;
const CANONICAL =
  `${BASE}/bbcswebdav/pid-414180-dt-announcement-rid-68160866_1/xid-68160866_1`;

function service(strategies) {
  return new AttachmentUrlRecoveryService({
    base: BASE,
    resolveUrl: (value) => new URL(value, BASE).toString(),
    strategies,
  });
}

test("stops recovery strategies after an exact replacement is found", async () => {
  let browserCalls = 0;
  const recovery = service([
    {
      method: "authenticated Blackboard HTML",
      gateway: {
        discover: async () => ({
          values: [
            "https://attacker.example/bbcswebdav/xid-68160866_1",
            `${BASE}/bbcswebdav/xid-111_1`,
            CANONICAL,
          ],
          diagnostics: ["HTTP inspected"],
        }),
      },
    },
    {
      method: "authenticated Blackboard browser UI",
      gateway: { discover: async () => { browserCalls += 1; } },
    },
  ]);

  const result = await recovery.recover({
    url: ORIGINAL,
    uiContext: { type: "content", uiUrls: [`${BASE}/ultra/courses/_1_1/outline`] },
  });

  assert.deepEqual(result, {
    candidates: [{ url: CANONICAL, method: "authenticated Blackboard HTML" }],
    diagnostics: ["HTTP inspected"],
  });
  assert.equal(browserCalls, 0);
});

test("uses later strategies after failure and preserves diagnostics", async () => {
  let browserCalls = 0;
  const recovery = service([
    {
      method: "authenticated Blackboard HTML",
      failureLabel: "HTML resolver",
      gateway: { discover: async () => { throw new Error("server unavailable"); } },
    },
    {
      method: "authenticated Blackboard browser UI",
      gateway: {
        discover: async () => {
          browserCalls += 1;
          return { values: [CANONICAL], diagnostics: ["browser inspected"] };
        },
      },
    },
  ]);

  const result = await recovery.recover({
    url: ORIGINAL,
    uiContext: { type: "content", uiUrls: [`${BASE}/ultra/courses/_1_1/outline`] },
  });

  assert.equal(browserCalls, 1);
  assert.deepEqual(result.candidates, [
    { url: CANONICAL, method: "authenticated Blackboard browser UI" },
  ]);
  assert.deepEqual(result.diagnostics, ["HTML resolver: server unavailable", "browser inspected"]);
});

test("applies the announcement owner rule without browser-specific assumptions", async () => {
  const result = await service([]).recover({
    url: ORIGINAL,
    uiContext: {
      type: "announcement",
      id: "_414180_1",
      uiUrls: [`${BASE}/ultra/courses/_1_1/announcements`],
    },
  });

  assert.deepEqual(result.candidates, [{ url: CANONICAL, method: "Blackboard owner URL rule" }]);
});

test("does not call recovery gateways without an exact xid or UI context", async () => {
  let calls = 0;
  const recovery = service([{ method: "gateway", gateway: { discover: async () => { calls += 1; } } }]);

  const noXid = await recovery.recover({
    url: `${BASE}/bbcswebdav/content/document.pdf`,
    uiContext: { type: "content", uiUrls: [`${BASE}/ultra/courses/_1_1/outline`] },
  });
  const noContext = await recovery.recover({ url: ORIGINAL });

  assert.equal(calls, 0);
  assert.match(noXid.diagnostics[0], /No Blackboard xid/);
  assert.match(noContext.diagnostics[0], /No authenticated UI page/);
});
