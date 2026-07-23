const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const {
  BlackboardAuthenticationError,
  BlackboardResponseFormatError,
  createBlackboardRestClient,
} = require("../src/adapters/blackboard/blackboard-rest-client");
const {
  PlaywrightClassicSubmissionGateway,
} = require("../src/adapters/blackboard/playwright-classic-submission-gateway");

const BASE = "https://blackboard.example.edu";
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "blackboard");

function fixture(relativePath) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), "utf8");
}

function fixtureJson(relativePath) {
  return JSON.parse(fixture(relativePath));
}

function fixtureResponse(relativePath, {
  contentType = relativePath.endsWith(".html") ? "text/html" : "application/json",
  headers = {},
  redirected = false,
  status = 200,
  statusText = status === 200 ? "OK" : "",
  url = "",
} = {}) {
  const body = fixture(relativePath);
  return {
    body: { cancel: async () => {} },
    headers: new Headers({ "content-type": contentType, ...headers }),
    ok: status >= 200 && status < 300,
    redirected,
    status,
    statusText,
    text: async () => body,
    url,
  };
}

function client(fetchImpl) {
  return createBlackboardRestClient({ base: BASE, fetchImpl });
}

test("recorded Ultra content pages retain Blackboard pagination and nullable fields", async () => {
  const offsets = [];
  const rest = client(async (url) => {
    const offset = url.searchParams.get("offset");
    offsets.push(offset);
    return fixtureResponse(
      offset === "0" ? "rest/ultra-content-page-1.json" : "rest/ultra-content-page-2.json"
    );
  });

  const results = await rest.all(
    "/learn/api/v1/courses/_course_fixture_1/contents/ROOT/children?limit=1&offset=0"
  );

  assert.deepEqual(offsets, ["0", "1"]);
  assert.deepEqual(results.map((item) => item.contentHandler), [
    "resource/x-bb-folder",
    "resource/x-bb-file",
  ]);
  assert.equal(results[1].modifiedDate, null);
  assert.equal(results[1].contentDetail["resource/x-bb-file"].file.size, 4096);
});

test("recorded attempt list preserves statuses used by assessment traversal", async () => {
  const rest = client(async () => fixtureResponse("rest/attempts.json"));
  const attempts = await rest.all(
    "/learn/api/v1/courses/_course_fixture_1/gradebook/columns/_column_fixture_1/grades/_grade_fixture_1/attempts"
  );

  assert.deepEqual(attempts.map(({ id, status }) => ({ id, status })), [
    { id: "_attempt_fixture_1", status: "COMPLETED" },
    { id: "_attempt_fixture_2", status: "NEEDS_GRADING" },
  ]);
});

test("recorded malformed responses fail with stable contracts", async (context) => {
  await context.test("missing results", async () => {
    const rest = client(async () => fixtureResponse("rest/malformed-missing-results.json"));
    await assert.rejects(
      () => rest.all("/learn/api/v1/items"),
      /Paginated response has no results array/
    );
  });

  await context.test("invalid JSON", async () => {
    const rest = client(async () => fixtureResponse("rest/malformed-json.txt", {
      contentType: "application/json",
    }));
    await assert.rejects(
      () => rest.get("/learn/api/v1/items"),
      (error) => {
        assert.equal(error instanceof BlackboardResponseFormatError, true);
        assert.equal(error.code, "BLACKBOARD_INVALID_RESPONSE");
        assert.match(error.message, /\/learn\/api\/v1\/items returned invalid JSON/);
        return true;
      }
    );
  });
});

test("recorded expired session HTML becomes an actionable authentication error", async () => {
  const rest = client(async () => fixtureResponse("rest/expired-session.html", {
    redirected: true,
    url: "https://sso.example.edu/login",
  }));

  await assert.rejects(
    () => rest.get("/learn/api/v1/users/me"),
    (error) => {
      assert.equal(error instanceof BlackboardAuthenticationError, true);
      assert.equal(error.code, "BLACKBOARD_AUTHENTICATION_REQUIRED");
      assert.equal(error.status, 200);
      assert.match(error.message, /refresh the saved session/);
      return true;
    }
  );
});

test("recorded Classic observation filters the exact attempt and captures Annotate", async () => {
  const observation = fixtureJson("classic/submission-history-observation.json");
  let currentUrl = BASE;
  const page = {
    frames: () => observation.frames.map((url) => ({ url: () => url })),
    goto: async (url) => {
      currentUrl = url;
      return { ok: () => true, status: () => 200 };
    },
    locator: () => ({ evaluateAll: async () => observation.anchors }),
    url: () => currentUrl,
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
  };
  const gateway = new PlaywrightClassicSubmissionGateway({
    base: BASE,
    stateFile: "/private/fixture-state.json",
    launchBrowser: async () => ({
      close: async () => {},
      newContext: async () => ({ close: async () => {}, newPage: async () => page }),
    }),
    settleMs: 0,
  });

  const results = await gateway.discoverAll([observation.request]);
  assert.deepEqual(results, [{
    id: observation.request.id,
    files: [observation.anchors[0]],
    annotateUrl: observation.frames[1],
  }]);
});
