const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BlackboardLtiH5pGateway,
  parseLtiLaunchForm,
} = require("../src/adapters/blackboard/blackboard-lti-h5p-gateway");

const BASE = "https://blackboard.example.edu";
const LAUNCH_URL = `${BASE}/webapps/blackboard/execute/blti/launchLink?course_id=_1_1&content_id=_2_1`;
const H5P_URL = "https://tenant.h5p.com/content/123";
const EXPORT_URL = "https://tenant.h5p.com/lti/7/media/exports/123/poster.h5p";
const FILE_URL = "https://storage.example.net/exports/poster.h5p?signature=raw";

function withUrl(response, url) {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function launchHtml(action = H5P_URL) {
  return [
    "<!doctype html><title>Launch LTI Link</title>",
    `<form method="post" action="${action}">`,
    '<input name="lti_message_type" value="basic-lti-launch-request">',
    '<input name="oauth_signature" value="one-time-signature">',
    '<input name="resource_link_id" value="_2_1">',
    "</form>",
  ].join("");
}

function h5pPayload() {
  return {
    success: true,
    bearer: "short-lived-bearer",
    settings: {
      context: "lti",
      contents: {
        "cid-123": {
          title: "Poster quiz",
          library: "H5P.QuestionSet 1.21",
          jsonContent: JSON.stringify({
            questions: [{ library: "H5P.TrueFalse 1.8", params: { question: "True?", correct: true } }],
          }),
          exportUrl: EXPORT_URL,
          embedCode: '<iframe src="https://tenant.h5p.com/content/123/embed"></iframe>',
          metadata: { title: "Poster quiz", license: "U" },
          displayOptions: { export: true },
          contentUserStatus: { numAttempts: 1, lastPercentageScore: 100 },
          canViewOwnReports: false,
          isScoringEnabled: true,
          scripts: ["https://cdn.h5p.com/question.js"],
          styles: ["https://cdn.h5p.com/question.css"],
        },
        "cid-0": { contentUserData: [] },
      },
    },
  };
}

test("LTI form parser selects the signed POST form for the expected provider", () => {
  const parsed = parseLtiLaunchForm(
    `${launchHtml("https://other.example.edu/launch")}${launchHtml(H5P_URL)}`,
    LAUNCH_URL,
    H5P_URL
  );
  assert.equal(parsed.actionUrl, H5P_URL);
  assert.equal(parsed.fields.oauth_signature, "one-time-signature");
});

test("HTTP H5P gateway reproduces the browser launch and package exchange", async () => {
  const requests = [];
  const client = {
    cookieHeaderFor: () => "blackboard-session=expected",
    request: async (url, options, label, attempts) => {
      requests.push({ url: String(url), options, label, attempts });
      if (String(url) === LAUNCH_URL) {
        return withUrl(new Response(launchHtml(), { headers: { "content-type": "text/html" } }), LAUNCH_URL);
      }
      if (String(url) === H5P_URL && options.headers["Content-Type"] === "application/x-www-form-urlencoded") {
        const response = new Response('<script src="/js/7177.js"></script>', {
          headers: { "content-type": "text/html", "set-cookie": "h5pcomsession=session-value; Path=/; HttpOnly" },
        });
        return withUrl(response, H5P_URL);
      }
      if (String(url) === H5P_URL && options.headers["Content-Type"] === "application/json") {
        return withUrl(new Response(JSON.stringify(h5pPayload()), {
          headers: { "content-type": "application/json" },
        }), H5P_URL);
      }
      if (String(url) === EXPORT_URL) {
        return withUrl(new Response(JSON.stringify({ fileURL: FILE_URL }), {
          headers: { "content-type": "application/json" },
        }), EXPORT_URL);
      }
      throw new Error(`Unexpected request ${url}`);
    },
  };
  const gateway = new BlackboardLtiH5pGateway({ base: BASE, client });
  const result = await gateway.collect({
    launchUrl: LAUNCH_URL,
    detail: {
      placementHandle: "h5p-course-content-tool",
      url: H5P_URL,
      domainConfig: { primaryDomain: "tenant.h5p.com" },
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(result.provider, "h5p");
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].content.questions.length, 1);
  assert.deepEqual(result.resources[0].contentUserStatus, {
    numAttempts: 1,
    lastPercentageScore: 100,
  });
  assert.deepEqual(result.resources[0].package, {
    available: true,
    exportUrl: EXPORT_URL,
    fileName: "poster.h5p",
    mimeType: "application/zip",
    url: FILE_URL,
  });
  assert.equal(requests.length, 4);
  assert.equal(requests.every((request) => request.attempts === 1), true);
  assert.match(requests[2].options.headers.Cookie, /h5pcomsession=session-value/);
  assert.equal(requests[2].options.headers.Referer, "https://tenant.h5p.com/js/7177.js");
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    fromWorker: false,
    bearer: "short-lived-bearer",
  });
  assert.doesNotMatch(JSON.stringify(result), /short-lived-bearer|one-time-signature/);
});

test("HTTP LTI gateway reports an unsupported provider without posting credentials to it", async () => {
  const requests = [];
  const target = "https://video.example.edu/lti/launch";
  const gateway = new BlackboardLtiH5pGateway({
    base: BASE,
    client: {
      cookieHeaderFor: () => "blackboard-session=expected",
      request: async (url) => {
        requests.push(String(url));
        return withUrl(new Response(launchHtml(target), { headers: { "content-type": "text/html" } }), LAUNCH_URL);
      },
    },
  });
  const result = await gateway.collect({
    launchUrl: LAUNCH_URL,
    detail: { url: target, placementHandle: "video-tool" },
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.providerHost, "video.example.edu");
  assert.equal(requests.length, 1);
});
