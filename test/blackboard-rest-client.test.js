const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateRetryDelay,
  createBlackboardRestClient,
  INVENTORY_PAGINATION_POLICY,
} = require("../src/adapters/blackboard/blackboard-rest-client");

function sessionState() {
  return {
    cookies: [
      { name: "session", value: "expected", domain: ".example.edu", path: "/learn" },
      { name: "wrong-domain", value: "private", domain: ".invalid.example", path: "/" },
      { name: "wrong-path", value: "private", domain: ".example.edu", path: "/webapps" },
    ],
  };
}

test("Blackboard REST client authenticates matching requests and retries transient failures", async () => {
  const delays = [];
  const requests = [];
  const warnings = [];
  let attempt = 0;
  let cancelled = 0;
  const client = createBlackboardRestClient({
    base: "https://blackboard.example.edu",
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async (url, options) => {
      requests.push({ options, url: String(url) });
      attempt += 1;
      if (attempt === 1) {
        return {
          body: { cancel: async () => { cancelled += 1; } },
          headers: new Headers({ "retry-after": "2" }),
          status: 429,
        };
      }
      if (attempt === 2) throw new Error("socket closed");
      return Response.json({ id: "_user_1" });
    },
    state: sessionState(),
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(await client.get("/learn/api/v1/users/me"), { id: "_user_1" });
  assert.deepEqual(delays, [2000, 1000]);
  assert.equal(cancelled, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => request.options.headers.Cookie === "session=expected"), true);
  assert.deepEqual(warnings, [
    "retrying Blackboard API /learn/api/v1/users/me after HTTP 429 (1/4, 2000 ms)",
    "retrying Blackboard API /learn/api/v1/users/me after socket closed (2/4, 1000 ms)",
  ]);
});

test("retry delay honors HTTP dates and bounded exponential fallback", () => {
  const now = Date.parse("2026-07-23T10:00:00.000Z");
  assert.equal(
    calculateRetryDelay(
      { headers: new Headers({ "retry-after": "Thu, 23 Jul 2026 10:00:03 GMT" }) },
      1,
      now
    ),
    3000
  );
  assert.equal(calculateRetryDelay({ headers: new Headers({ "retry-after": "30" }) }, 1, now), 10000);
  assert.equal(calculateRetryDelay(null, 1, now), 500);
  assert.equal(calculateRetryDelay(null, 8, now), 5000);
});

test("Blackboard REST client does not retry non-transient HTTP errors", async () => {
  const delays = [];
  let requests = 0;
  const client = createBlackboardRestClient({
    base: "https://blackboard.example.edu",
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      requests += 1;
      return new Response("x".repeat(250), { status: 404, statusText: "Not Found" });
    },
    state: sessionState(),
  });

  await assert.rejects(
    () => client.get("/learn/api/v1/missing?secret=visible-to-existing-error-contract"),
    (error) => {
      assert.match(
        error.message,
        /^GET https:\/\/blackboard\.example\.edu\/learn\/api\/v1\/missing\?secret=visible-to-existing-error-contract failed: 404 Not Found /
      );
      assert.equal(error.message.endsWith("x".repeat(200)), true);
      return true;
    }
  );
  assert.equal(requests, 1);
  assert.deepEqual(delays, []);
});

test("strict pagination follows nextPage and synthesizes a missing next offset", async () => {
  const requests = [];
  const client = createBlackboardRestClient({
    base: "https://blackboard.example.edu",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed.toString());
      const offset = parsed.searchParams.get("offset");
      if (offset === "0") {
        return Response.json({
          results: [{ id: "one" }],
          paging: { count: 3, nextPage: "/learn/api/v1/items?limit=1&offset=1" },
        });
      }
      if (offset === "1") {
        return Response.json({
          results: [{ id: "two" }],
          paging: { count: 3, limit: 1, offset: 1 },
        });
      }
      return Response.json({ results: [{ id: "three" }], paging: { count: 3 } });
    },
    state: sessionState(),
  });

  assert.deepEqual((await client.all("/learn/api/v1/items")).map((item) => item.id), [
    "one",
    "two",
    "three",
  ]);
  assert.equal(new URL(requests[0]).searchParams.get("limit"), "100");
  assert.equal(new URL(requests[0]).searchParams.get("offset"), "0");
  assert.equal(new URL(requests[2]).searchParams.get("offset"), "2");
});

test("inventory pagination can continue without count or nextPage until an empty page", async () => {
  const offsets = [];
  const client = createBlackboardRestClient({
    base: "https://blackboard.example.edu",
    fetchImpl: async (url) => {
      const offset = new URL(url).searchParams.get("offset");
      offsets.push(offset);
      return Response.json({ results: offset === "0" ? [{ id: "one" }] : [] });
    },
    paginationPolicy: INVENTORY_PAGINATION_POLICY,
    state: sessionState(),
  });

  assert.deepEqual(await client.all("/learn/api/v1/items"), [{ id: "one" }]);
  assert.deepEqual(offsets, ["0", "100"]);
});

test("permissive inventory pagination stops when a reported count becomes stale", async () => {
  const offsets = [];
  const client = createBlackboardRestClient({
    base: "https://blackboard.example.edu",
    fetchImpl: async (url) => {
      const offset = new URL(url).searchParams.get("offset");
      offsets.push(offset);
      return Response.json({
        results: offset === "0" ? [{ id: "one" }] : [],
        paging: { count: 5 },
      });
    },
    paginationPolicy: INVENTORY_PAGINATION_POLICY,
    state: sessionState(),
  });

  assert.deepEqual(await client.all("/learn/api/v1/items"), [{ id: "one" }]);
  assert.deepEqual(offsets, ["0", "100"]);
});

test("strict pagination rejects duplicate result IDs", async () => {
  const client = createBlackboardRestClient({
    base: "https://blackboard.example.edu",
    fetchImpl: async (url) => {
      const offset = new URL(url).searchParams.get("offset");
      return offset === "0"
        ? Response.json({
            results: [{ id: "duplicate" }],
            paging: { count: 2, nextPage: "/learn/api/v1/items?limit=1&offset=1" },
          })
        : Response.json({ results: [{ id: "duplicate" }], paging: { count: 2 } });
    },
    state: sessionState(),
  });

  await assert.rejects(
    () => client.all("/learn/api/v1/items"),
    { message: "Duplicate result duplicate while paginating /learn/api/v1/items" }
  );
});

test("strict pagination rejects count mismatches and repeated pages", async (context) => {
  await context.test("count mismatch", async () => {
    const client = createBlackboardRestClient({
      base: "https://blackboard.example.edu",
      fetchImpl: async () => Response.json({
        results: [{ id: "one" }, { id: "two" }],
        paging: { count: 1 },
      }),
      state: sessionState(),
    });
    await assert.rejects(
      () => client.all("/learn/api/v1/items"),
      { message: "Pagination count mismatch for /learn/api/v1/items: expected 1, received 2" }
    );
  });

  await context.test("page loop", async () => {
    const client = createBlackboardRestClient({
      base: "https://blackboard.example.edu",
      fetchImpl: async () => Response.json({
        results: [{ value: "no stable id" }],
        paging: { count: 2, nextPage: "/learn/api/v1/items?limit=100&offset=0" },
      }),
      state: sessionState(),
    });
    await assert.rejects(
      () => client.all("/learn/api/v1/items"),
      { message: "Pagination loop detected for /learn/api/v1/items" }
    );
  });
});

test("strict pagination rejects payloads without a results array", async () => {
  const client = createBlackboardRestClient({
    base: "https://blackboard.example.edu",
    fetchImpl: async () => Response.json({ paging: { count: 1 } }),
    state: sessionState(),
  });
  await assert.rejects(
    () => client.all("/learn/api/v1/items"),
    /Paginated response has no results array: https:\/\/blackboard\.example\.edu\/learn\/api\/v1\/items\?limit=100&offset=0/
  );
});
