const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { finiteNumber } = require("../src/domain/course-fetch/course-file-policy");
const { isLtiHandler, requiresAssessmentArchive } = require("../src/domain/course-fetch/blackboard-lti-policy");
const { recordManifestArtifact } = require("../src/domain/archive/archive-artifact");

// Exercise the production assessment export and coverage audit with synthetic
// released grade feedback. No real session, grades, or network calls are used.
const runtime = fs.readFileSync(path.join(__dirname, "../src/composition/course-fetch-runtime.js"), "utf8");
function functionSource(start, end) {
  const offset = runtime.indexOf(start);
  const boundary = runtime.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && boundary > offset);
  return runtime.slice(offset, boundary);
}

async function archiveFeedback(context, {
  gradeHtml = "<p>Revised feedback for the overall assignment.</p>",
  attemptHtml = "",
  hasAttempt = true,
  attachment = false,
  failAttachment = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-grade-feedback-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const item = {
    id: "_content_1", title: "Assignment 1", contentHandler: "resource/x-bb-assignment",
    contentDetail: { "resource/x-bb-assignment": { assessment: {}, gradingColumn: { id: "_column_1" } } },
  };
  const attempt = { id: "_attempt_1", status: "COMPLETED", attemptDate: "2025-09-28T15:58:11.415Z" };
  const manifest = {
    contents: [{ id: item.id, handler: item.contentHandler, knownHandler: true, files: [] }],
    assessments: [], downloads: [], artifacts: [], announcements: [], ltiResources: [], warnings: [], errors: [],
    extraArchive: { complete: true },
    gradebook: { items: [{ columnId: "_column_1", title: item.title, grade: { hasAttemptOrGradeFeedback: true } }] },
  };
  const downloadAttachments = async (attachments, directory) => {
    for (const file of attachments) {
      if (failAttachment) {
        manifest.errors.push({ label: file.fileName, error: "Feedback attachment download failed" });
        continue;
      }
      fs.mkdirSync(directory, { recursive: true });
      const filePath = path.join(directory, file.fileName);
      fs.writeFileSync(filePath, "released feedback attachment");
      manifest.downloads.push({
        path: path.relative(root, filePath), size: fs.statSync(filePath).size,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"), integrityVerified: true,
      });
    }
  };
  const sandbox = {
    fs, path, finiteNumber, isLtiHandler, requiresAssessmentArchive, manifest,
    OUT_ROOT: root, COURSE_ID: "_course_1", COVERAGE_SCOPE: [], COVERAGE_EXCLUSIONS: [],
    previousManifest: null, gradebookOverviewLoaded: true, gradebookOverviewCount: 1,
    pendingAnnotationChecks: [], pendingClassicAttemptFiles: [],
    getAssessmentDetail: (value) => value.contentDetail?.[value.contentHandler],
    dirForItem: () => path.join(root, item.title),
    ensureDir: (directory) => fs.mkdirSync(directory, { recursive: true }),
    archivePath: (file) => path.relative(root, file),
    roundNumber: finiteNumber,
    summarizeGrade: () => ({ isOverride: true }),
    getColumnGrade: async () => ({
      id: "_grade_1",
      instructorFeedback: {
        rawText: gradeHtml, displayText: gradeHtml,
        attachments: attachment ? [{ fileName: "comments.pdf" }] : [],
      },
    }),
    getAllPages: async () => hasAttempt ? [attempt] : [],
    bbJson: async () => ({ studentSubmission: {}, feedbackToUser: { displayText: attemptHtml } }),
    quizReviewEntry: () => null,
    viewerSubmissionFiles: () => [],
    assessmentUiContext: () => ({}),
    directSubmissionFiles: (value) => value?.attachments || [],
    extractAttachments: () => [],
    mergeAttachments: (...lists) => [...new Map(lists.flat().map((file) => [file.fileName, file])).values()],
    downloadAttachments,
    downloadFeedbackAttachments: async (attachments, directory) => {
      const before = manifest.downloads.length;
      await downloadAttachments(attachments, directory);
      return manifest.downloads.slice(before).map((download) => download.path);
    },
    htmlPage: (_title, body) => body,
    writeText: (file, text, artifact) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      recordManifestArtifact(manifest, path.relative(root, file), artifact);
    },
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
  return { root, manifest, assessment: manifest.assessments[0] };
}

test("released override feedback is archived at grade scope when attempt feedback is empty", async (context) => {
  const { root, manifest, assessment } = await archiveFeedback(context);
  const feedback = assessment.gradeFeedback;
  assert.equal(feedback.scope, "grade");
  assert.equal(feedback.source, "Blackboard grade.instructorFeedback");
  assert.equal(feedback.gradeId, "_grade_1");
  assert.equal(feedback.columnId, "_column_1");
  assert.equal(feedback.text, "Revised feedback for the overall assignment.");
  assert.equal(fs.readFileSync(path.join(root, feedback.htmlPath), "utf8"), "<p>Revised feedback for the overall assignment.</p>");
  assert.equal(fs.readFileSync(path.join(root, feedback.textPath), "utf8"), feedback.text);
  assert.equal(assessment.attempts[0].feedback, null);
  const artifact = manifest.artifacts.find((entry) => entry.path === feedback.htmlPath);
  assert.equal(artifact.logicalItemType, "assessment-grade-feedback");
  assert.equal(artifact.logicalItemId, "_grade_1");
  assert.equal(manifest.coverage.assessments.advertisedFeedbackMissing.length, 0);
  assert.equal(manifest.coverage.complete, true);
});

test("grade feedback never replaces separately released attempt feedback", async (context) => {
  const { root, manifest, assessment } = await archiveFeedback(context, { attemptHtml: "<p>Original attempt feedback.</p>" });
  assert.equal(assessment.gradeFeedback.text, "Revised feedback for the overall assignment.");
  assert.equal(assessment.attempts[0].feedback.text, "Original attempt feedback.");
  assert.notEqual(assessment.gradeFeedback.htmlPath, assessment.attempts[0].feedback.htmlPath);
  assert.match(fs.readFileSync(path.join(root, assessment.attempts[0].feedback.htmlPath), "utf8"), /Original attempt feedback/);
  assert.equal(manifest.coverage.complete, true);
});

test("grade feedback is preserved even when no submission attempt exists", async (context) => {
  const { manifest, assessment } = await archiveFeedback(context, { hasAttempt: false });
  assert.equal(assessment.attempts.length, 0);
  assert.equal(assessment.gradeFeedback.scope, "grade");
  assert.equal(manifest.coverage.complete, true);
});

test("empty grade feedback does not hide an advertised feedback gap", async (context) => {
  const { manifest, assessment } = await archiveFeedback(context, { gradeHtml: "<p><br>&nbsp;</p>" });
  assert.equal(assessment.gradeFeedback, null);
  assert.equal(manifest.coverage.assessments.advertisedFeedbackMissing.length, 1);
  assert.equal(manifest.coverage.complete, false);
});

test("grade feedback attachments are archived and failed attachments still fail coverage", async (context) => {
  const archived = await archiveFeedback(context, { gradeHtml: "", attachment: true });
  assert.equal(archived.assessment.gradeFeedback.files.length, 1);
  assert.equal(fs.readFileSync(path.join(archived.root, archived.assessment.gradeFeedback.files[0]), "utf8"), "released feedback attachment");
  assert.equal(archived.manifest.coverage.complete, true);

  const failed = await archiveFeedback(context, { attachment: true, failAttachment: true });
  assert.equal(failed.manifest.coverage.complete, false);
  assert.ok(failed.manifest.errors.some((error) => error.error === "Feedback attachment download failed"));
});
