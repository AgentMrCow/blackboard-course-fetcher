const assert = require("node:assert/strict");
const test = require("node:test");

const {
  blackboardResourceUrlsFromText,
  blackboardXid,
  canonicalizeEmbeddedBlackboardUrl,
  filenameFromContentDisposition,
  isBlackboardAuthenticationRedirect,
  isOpaqueBlackboardFilename,
  matchingBlackboardResourceUrls,
} = require("../src/domain/course-fetch/blackboard-attachment-policy");

const BASE = "https://blackboard.example.edu";

test("builds the canonical URL for a bare announcement xid", () => {
  assert.equal(
    canonicalizeEmbeddedBlackboardUrl(
      "/bbcswebdav/xid-68160866_1",
      BASE,
      { type: "announcement", id: "_414180_1" }
    ),
    "https://blackboard.example.edu/bbcswebdav/pid-414180-dt-announcement-rid-68160866_1/xid-68160866_1"
  );
});

test("does not guess canonical URLs without matching announcement context", () => {
  const bareUrl = "https://blackboard.example.edu/bbcswebdav/xid-68160866_1";
  assert.equal(canonicalizeEmbeddedBlackboardUrl(bareUrl, BASE), bareUrl);
  assert.equal(
    canonicalizeEmbeddedBlackboardUrl(bareUrl, BASE, { type: "content", id: "_414180_1" }),
    bareUrl
  );
  assert.equal(
    canonicalizeEmbeddedBlackboardUrl(
      "https://files.example.net/bbcswebdav/xid-68160866_1",
      BASE,
      { type: "announcement", id: "_414180_1" }
    ),
    "https://files.example.net/bbcswebdav/xid-68160866_1"
  );
});

test("extracts RFC 5987 and quoted Content-Disposition filenames safely", () => {
  assert.equal(
    filenameFromContentDisposition("inline; filename*=UTF-8''WechatIMG7.jpeg"),
    "WechatIMG7.jpeg"
  );
  assert.equal(
    filenameFromContentDisposition('attachment; filename="report final.pdf"'),
    "report final.pdf"
  );
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''..%2Fsecret.txt"),
    "secret.txt"
  );
});

test("recognizes bare Blackboard xid names", () => {
  assert.equal(isOpaqueBlackboardFilename("xid-68160866_1"), true);
  assert.equal(isOpaqueBlackboardFilename("WechatIMG7.jpeg"), false);
});

test("matches only same-origin Blackboard URLs for the requested xid", () => {
  const target = `${BASE}/bbcswebdav/xid-68160866_1`;
  assert.equal(blackboardXid(target, BASE), "68160866_1");
  assert.deepEqual(
    matchingBlackboardResourceUrls(
      [
        target,
        "/bbcswebdav/pid-414180-dt-announcement-rid-68160866_1/xid-68160866_1",
        "/bbcswebdav/pid-999-dt-announcement-rid-111_1/xid-111_1",
        "https://temporary-files.example.net/path/xid-68160866_1",
      ],
      target,
      BASE
    ),
    [
      `${BASE}/bbcswebdav/pid-414180-dt-announcement-rid-68160866_1/xid-68160866_1`,
      target,
    ]
  );
});

test("extracts exact xid candidates from server-rendered HTML and JSON attributes", () => {
  const target = `${BASE}/bbcswebdav/xid-68160866_1`;
  const canonical = `${BASE}/bbcswebdav/pid-414180-dt-announcement-rid-68160866_1/xid-68160866_1`;
  const html = [
    `<img src="${canonical}">`,
    `data-file="{&quot;url&quot;:&quot;https:\\/\\/blackboard.example.edu\\/bbcswebdav\\/xid-111_1&quot;}"`,
  ].join("\n");
  assert.deepEqual(blackboardResourceUrlsFromText(html, target, BASE), [canonical]);
});

test("identifies cross-origin and Blackboard authentication redirects", () => {
  assert.equal(isBlackboardAuthenticationRedirect(`${BASE}/ultra/courses/_1_1/outline`, BASE), false);
  assert.equal(isBlackboardAuthenticationRedirect(`${BASE}/login/saml`, BASE), true);
  assert.equal(isBlackboardAuthenticationRedirect("https://sso.example.edu/login", BASE), true);
  assert.equal(isBlackboardAuthenticationRedirect("not a valid absolute URL", "not a base"), true);
});
