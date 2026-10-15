const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { finiteNumber } = require("../src/domain/course-fetch/course-file-policy");
const { isLtiHandler, requiresAssessmentArchive } = require("../src/domain/course-fetch/blackboard-lti-policy");

// Run the production submission export and coverage audit against synthetic
// Blackboard responses, without starting the CLI or using a saved session.
const runtime = fs.readFileSync(path.join(__dirname, "../src/composition/course-fetch-runtime.js"), "utf8");
function functionSource(start, end) {
  const offset = runtime.indexOf(start);
  const boundary = runtime.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && boundary > offset);
  return runtime.slice(offset, boundary);
}

async function archiveSubmission(context, { submissionHtml = "", commentsHtml = "", missingFile = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-submission-coverage-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const item = {
    id: "_content_1", title: "Demo video", contentHandler: "resource/x-bb-assignment",
    contentDetail: { "resource/x-bb-assignment": {
      assessment: {}, gradingColumn: { id: "_column_1" },
    } },
  };
  const attempt = { id: "_attempt_1", status: "NEEDS_GRADING", attemptDate: "2025-12-06T19:45:47.693Z" };
  const detail = {
    studentSubmission: { rawText: submissionHtml, displayText: submissionHtml },
    studentComments: { displayText: commentsHtml },
    attemptReceipt: { submissionTotalSize: 336 },
    attachments: missingFile ? [{ fileName: "report.pdf" }] : [],
  };
  const manifest = {
    contents: [{ id: item.id, handler: item.contentHandler, knownHandler: true, files: [] }],
    assessments: [], downloads: [], announcements: [], ltiResources: [],
    warnings: [], errors: [], extraArchive: { complete: true }, gradebook: { items: [] },
  };
  const sandbox = {
    fs, path, finiteNumber, isLtiHandler, requiresAssessmentArchive, manifest,
    OUT_ROOT: root, COURSE_ID: "_course_1", COVERAGE_SCOPE: [], COVERAGE_EXCLUSIONS: [],
    previousManifest: null, gradebookOverviewLoaded: true, gradebookOverviewCount: 0,
    pendingAnnotationChecks: [], pendingClassicAttemptFiles: [],
    getAssessmentDetail: (value) => value.contentDetail?.[value.contentHandler],
    dirForItem: () => path.join(root, "Demo video"),
    ensureDir: (directory) => fs.mkdirSync(directory, { recursive: true }),
    archivePath: (file) => path.relative(root, file),
    roundNumber: finiteNumber,
    summarizeGrade: () => null,
    getColumnGrade: async () => ({ id: "_grade_1" }),
    getAllPages: async () => [attempt],
    bbJson: async () => detail,
    quizReviewEntry: () => null,
    viewerSubmissionFiles: () => [],
    assessmentUiContext: () => ({}),
    directSubmissionFiles: (value) => value?.attachments || [],
    extractAttachments: () => [],
    mergeAttachments: (...lists) => [...new Map(lists.flat().map((file) => [file.fileName, file])).values()],
    downloadAttachments: async (files) => {
      if (files.length) manifest.errors.push({ label: "report.pdf", error: "Download failed" });
    },
    htmlPage: (_title, body) => body,
    writeText: (file, text) => fs.writeFileSync(file, text),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    functionSource("function decodeHtml(", "function absUrl("),
    functionSource("function stripHtml(", "function roundNumber("),
    functionSource("async function saveAssessment(", "function deriveGradebookStatus("),
    functionSource("function auditCoverage(", "async function processItem("),
  ].join("\n"), sandbox);
  await sandbox.saveAssessment(item, [], { id: "_student_1" });
  sandbox.auditCoverage();
  return { root, manifest, attempt: manifest.assessments[0].attempts[0] };
}

test("text-only link submissions satisfy reported submission bytes after their text is archived", async (context) => {
  const submissionHtml = '<p>video: <a href="https://example.edu/demo">Watch demo</a></p>';
  const { root, manifest, attempt } = await archiveSubmission(context, { submissionHtml });
  assert.equal(fs.readFileSync(path.join(root, attempt.directory, "submission.html"), "utf8"), submissionHtml);
  assert.match(fs.readFileSync(path.join(root, attempt.directory, "submission.txt"), "utf8"), /Watch demo/);
  assert.equal(attempt.files.length, 0);
  assert.equal(manifest.coverage.assessments.submittedPayloadMissing.length, 0);
  assert.equal(manifest.coverage.complete, true);
});

for (const [name, input] of [
  ["empty submission", {}],
  ["markup-only submission", { submissionHtml: "<p><br>&nbsp;</p>" }],
  ["comments without a submission", { commentsHtml: "<p>Please see my attached report.</p>" }],
]) {
  test(`reported submission bytes remain missing for ${name}`, async (context) => {
    const { manifest } = await archiveSubmission(context, input);
    assert.equal(manifest.coverage.assessments.submittedPayloadMissing.length, 1);
    assert.equal(manifest.coverage.complete, false);
    assert.match(manifest.errors[0].error, /336 submitted bytes/);
  });
}

test("archived submission text does not hide a failed attachment download", async (context) => {
  const { manifest } = await archiveSubmission(context, {
    submissionHtml: "<p>See the attached report.</p>", missingFile: true,
  });
  assert.equal(manifest.coverage.complete, false);
  assert.ok(manifest.errors.some((error) => error.label === "report.pdf" && error.error === "Download failed"));
});
