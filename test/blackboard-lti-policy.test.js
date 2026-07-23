const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildLtiLaunchUrl,
  isH5pLti,
  isLtiHandler,
  ltiDetail,
  ltiProviderHost,
} = require("../src/domain/course-fetch/blackboard-lti-policy");

const BASE = "https://blackboard.example.edu";

test("LTI policy recognizes link and placement handlers without institution-specific IDs", () => {
  assert.equal(isLtiHandler("resource/x-bb-blti-link"), true);
  assert.equal(isLtiHandler("resource/x-bb-bltiplacement-video"), true);
  assert.equal(isLtiHandler("resource/x-bb-externallink"), false);
});

test("LTI policy extracts provider details and detects H5P by domain or placement", () => {
  const item = {
    contentHandler: "resource/x-bb-blti-link",
    contentDetail: {
      "resource/x-bb-blti-link": {
        placementHandle: "h5p-course-content-tool",
        url: "https://tenant.h5p.com/content/123",
        domainConfig: { primaryDomain: "tenant.h5p.com" },
      },
    },
  };
  const detail = ltiDetail(item);
  assert.equal(detail, item.contentDetail[item.contentHandler]);
  assert.equal(ltiProviderHost({ detail }), "tenant.h5p.com");
  assert.equal(isH5pLti({ detail }), true);
  assert.equal(
    isH5pLti({ actionUrl: "https://tools.example.edu/launch", detail: { placementHandle: "h5p-tool" } }),
    true
  );
  assert.equal(isH5pLti({ actionUrl: "https://video.example.edu/launch" }), false);
});

test("LTI launch URL uses Blackboard metadata and has a generic fallback", () => {
  assert.equal(
    buildLtiLaunchUrl({
      base: BASE,
      courseId: "_1_1",
      contentId: "_2_1",
      detail: { launchLink: "/custom/lti/launch?link=_2_1" },
    }),
    `${BASE}/custom/lti/launch?link=_2_1`
  );
  const fallback = new URL(buildLtiLaunchUrl({
    base: BASE,
    courseId: "_1_1",
    contentId: "_2_1",
  }));
  assert.equal(fallback.pathname, "/webapps/blackboard/execute/blti/launchLink");
  assert.deepEqual(Object.fromEntries(fallback.searchParams), {
    course_id: "_1_1",
    content_id: "_2_1",
  });
});
