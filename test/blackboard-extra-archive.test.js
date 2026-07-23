const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { archiveUiData } = require("../src/composition/blackboard-extra-archive");

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-extra-archive-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function manifest() {
  return {
    generatedAt: "2026-07-23T10:00:00.000Z",
    errors: [],
    warnings: [],
  };
}

test("UI archive preserves complete gateway payloads and achievement and annotation records", async (testContext) => {
  const outputRoot = temporaryDirectory(testContext);
  const attemptDir = path.join(outputRoot, "attempt");
  const currentManifest = manifest();
  const attemptRecord = { annotations: [] };
  let gatewayInput;
  const context = {
    BASE: "https://blackboard.example.edu",
    COURSE_ID: "_1_1",
    OUT_ROOT: outputRoot,
    annotationChecks: [{
      assessmentTitle: "Assignment",
      attemptId: "_attempt_1",
      attemptDir,
      attemptRecord,
      fileName: "report.pdf",
      mimeType: "application/pdf",
    }],
    course: { displayName: "Test Course", ultraStatus: "ULTRA" },
    downloadMode: "full",
    manifest: currentManifest,
    uiDataGateway: {
      collect: async (input) => {
        gatewayInput = input;
        const value = await input.onAnnotationCapture(
          { id: 0 },
          {
            documentMetadata: { data: { id: "doc-1", token: "private" } },
            syncData: {
              record_rev: 8,
              token: "private",
              changes: {
                created: [{
                  content: { type: "pspdfkit/comment", text: "Visible" },
                  permissions: { view: true },
                }],
              },
            },
          }
        );
        return {
          achievements: {
            value: {
              list: { results: [{ id: "award-1", title: "Completed", token: "private" }] },
              unread: { unreadAchievementIds: ["award-1"], jwt: "private" },
            },
          },
          annotations: [{ id: 0, value }],
        };
      },
    },
  };

  const result = await archiveUiData(context);

  assert.equal(gatewayInput.achievementsUrl, `${context.BASE}/ultra/courses/_1_1/achievements`);
  assert.deepEqual(gatewayInput.annotationRequests, [{ id: 0, classicHistoryUrl: null }]);
  assert.deepEqual(result, {
    achievements: { complete: true, count: 1 },
    annotations: { complete: true, count: 1 },
  });
  assert.equal(currentManifest.achievements.count, 1);
  assert.equal(currentManifest.achievements.unread, 1);
  assert.equal(currentManifest.annotations.expected, 1);
  assert.equal(currentManifest.annotations.archived, 1);
  assert.equal(currentManifest.annotations.withRawChanges, 1);
  assert.equal(currentManifest.annotations.withVisibleMarkup, 1);
  assert.equal(attemptRecord.annotations[0].recordRevision, 8);
  assert.equal(attemptRecord.annotations[0].commentCount, 1);

  const achievementJson = JSON.parse(fs.readFileSync(
    path.join(outputRoot, "07_Achievements", "achievements.json"),
    "utf8"
  ));
  const annotationJson = JSON.parse(fs.readFileSync(
    path.join(attemptDir, "annotations", "report.pdf.annotations.json"),
    "utf8"
  ));
  assert.equal(achievementJson.results[0].token, "private");
  assert.equal(achievementJson.apiResponses.unread.jwt, "private");
  assert.equal(annotationJson.documentResponse.data.token, "private");
  assert.equal(annotationJson.sync.token, "private");
});

test("Classic placeholder UI archive writes local records without starting a gateway", async (testContext) => {
  const outputRoot = temporaryDirectory(testContext);
  const attemptRecord = { annotations: [] };
  let gatewayCalls = 0;
  const currentManifest = manifest();
  const result = await archiveUiData({
    BASE: "https://blackboard.example.edu",
    COURSE_ID: "_2_1",
    OUT_ROOT: outputRoot,
    annotationChecks: [{
      assessmentTitle: "Classic Assignment",
      attemptId: "_attempt_2",
      attemptDir: path.join(outputRoot, "attempt"),
      attemptRecord,
      fileName: "answer.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }],
    course: { displayName: "Classic Course", ultraStatus: "CLASSIC" },
    downloadMode: "placeholder",
    manifest: currentManifest,
    uiDataGateway: { collect: async () => { gatewayCalls += 1; } },
  });

  assert.equal(gatewayCalls, 0);
  assert.equal(result.achievements.applicable, false);
  assert.deepEqual(result.annotations, { complete: true, count: 1, placeholders: 1 });
  assert.equal(currentManifest.annotations.mode, "placeholder");
  assert.equal(attemptRecord.annotations[0].placeholder, true);
});

test("UI archive maps gateway area failures into the existing manifest schema", async (testContext) => {
  const outputRoot = temporaryDirectory(testContext);
  const currentManifest = manifest();
  const result = await archiveUiData({
    BASE: "https://blackboard.example.edu",
    COURSE_ID: "_3_1",
    OUT_ROOT: outputRoot,
    annotationChecks: [{
      assessmentTitle: "Assignment",
      attemptId: "_attempt_3",
      attemptDir: path.join(outputRoot, "attempt"),
      attemptRecord: { annotations: [] },
      fileName: "failed.pdf",
    }],
    course: { displayName: "Ultra Course", ultraStatus: "ULTRA" },
    downloadMode: "full",
    manifest: currentManifest,
    uiDataGateway: {
      collect: async () => ({
        achievements: { error: "achievements unavailable?token=raw-achievement" },
        annotations: [{
          id: 0,
          firstError: "first failed?ticket=raw-first",
          retryError: "retry failed?token=raw-retry",
        }],
      }),
    },
  });

  assert.deepEqual(result, {
    achievements: { complete: false, count: null },
    annotations: { complete: false, count: 0 },
  });
  assert.equal(currentManifest.annotations.failed.length, 1);
  assert.equal(currentManifest.annotations.failed[0].firstError, "first failed?ticket=raw-first");
  assert.equal(currentManifest.annotations.failed[0].retryError, "retry failed?token=raw-retry");
  assert.equal(currentManifest.errors.length, 2);
  assert.equal(currentManifest.errors[0].error, "achievements unavailable?token=raw-achievement");
  assert.equal(currentManifest.errors[1].error, "retry failed?token=raw-retry");
});
