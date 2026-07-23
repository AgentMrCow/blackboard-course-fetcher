const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BlackboardContentAttachmentGateway,
  contentAttachmentCollectionPath,
  contentAttachmentDownloadPath,
  isUnsupportedAttachmentResponse,
} = require("../src/adapters/blackboard/blackboard-content-attachment-gateway");

test("content attachment gateway maps the public Blackboard API to stable downloads", async () => {
  const requests = [];
  const gateway = new BlackboardContentAttachmentGateway({
    client: {
      all: async (url) => {
        requests.push(url);
        return [
          {
            id: "_attachment_1",
            fileName: "Reading Guide.pdf",
            mimeType: "application/pdf",
          },
        ];
      },
    },
  });

  const result = await gateway.list({
    courseId: "_course_1",
    contentId: "_content_1",
  });

  assert.deepEqual(requests, [
    "/learn/api/public/v1/courses/_course_1/contents/_content_1/attachments",
  ]);
  assert.equal(result.supported, true);
  assert.equal(result.endpoint, requests[0]);
  assert.deepEqual(result.attachments, [
    {
      fileId: "_attachment_1",
      fileName: "Reading Guide.pdf",
      mimeType: "application/pdf",
      fileSize: null,
      url:
        "/learn/api/public/v1/courses/_course_1/contents/_content_1" +
        "/attachments/_attachment_1/download",
    },
  ]);
});

test("content attachment gateway treats Blackboard's unsupported-item response as complete", async () => {
  const gateway = new BlackboardContentAttachmentGateway({
    client: {
      all: async () => {
        throw new Error(
          'GET failed: 400 Bad Request {"message":"The Content Item does not support file attachments"}'
        );
      },
    },
  });

  const result = await gateway.list({
    courseId: "_course_1",
    contentId: "_folder_1",
  });

  assert.equal(result.supported, false);
  assert.deepEqual(result.attachments, []);
});

test("content attachment gateway rejects incomplete metadata and unexpected failures", async () => {
  const incomplete = new BlackboardContentAttachmentGateway({
    client: { all: async () => [{ id: "_attachment_1" }] },
  });
  await assert.rejects(
    () => incomplete.list({ courseId: "_course_1", contentId: "_content_1" }),
    /incomplete attachment metadata/
  );

  const failed = new BlackboardContentAttachmentGateway({
    client: { all: async () => { throw new Error("503 Service Unavailable"); } },
  });
  await assert.rejects(
    () => failed.list({ courseId: "_course_1", contentId: "_content_1" }),
    /503 Service Unavailable/
  );
});

test("content attachment endpoint helpers preserve Blackboard identifiers", () => {
  assert.equal(
    contentAttachmentCollectionPath("_course_1", "_content_1"),
    "/learn/api/public/v1/courses/_course_1/contents/_content_1/attachments"
  );
  assert.equal(
    contentAttachmentDownloadPath("_course_1", "_content_1", "_attachment_1"),
    "/learn/api/public/v1/courses/_course_1/contents/_content_1/attachments/_attachment_1/download"
  );
  assert.equal(
    isUnsupportedAttachmentResponse(
      new Error("400 Bad Request: The Content Item does not support file attachments")
    ),
    true
  );
  assert.equal(isUnsupportedAttachmentResponse(new Error("400 Bad Request")), false);
});
