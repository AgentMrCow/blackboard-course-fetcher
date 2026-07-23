const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClassicSubmissionHistoryUrl,
  buildStudentFeedbackUrl,
  isAnnotatableSubmission,
} = require("../src/domain/course-fetch/blackboard-browser-workflow-policy");

const BASE = "https://blackboard.example.edu";

test("builds Blackboard feedback and Classic submission URLs from generic identifiers", () => {
  const feedback = new URL(buildStudentFeedbackUrl({
    base: BASE,
    courseId: "_166792_1",
    columnId: "_925385_1",
    contentId: "_4231168_1",
  }));
  assert.equal(feedback.pathname, "/ultra/courses/_166792_1/grades/student-grade-and-feedback");
  assert.deepEqual(Object.fromEntries(feedback.searchParams), {
    courseId: "_166792_1",
    columnId: "_925385_1",
    contentId: "_4231168_1",
  });

  const history = new URL(buildClassicSubmissionHistoryUrl({
    base: BASE,
    courseId: "_180394_1",
    columnId: "_123_1",
    attemptIndex: 2,
    attemptId: "_456_1",
  }));
  assert.equal(history.pathname, "/webapps/assignment/uploadAssignment");
  assert.deepEqual(Object.fromEntries(history.searchParams), {
    course_id: "_180394_1",
    action: "showHistory",
    outcome_definition_id: "_123_1",
    currentAttemptIndex: "2",
    attempt_id: "_456_1",
  });
});

test("recognizes Blackboard Annotate-compatible submission file types", () => {
  for (const file of ["report.PDF", "work.docx", "slides.ppt", "sheet.xlsx"]) {
    assert.equal(isAnnotatableSubmission(file), true, file);
  }
  for (const file of ["source.zip", "notes.txt", "image.png", "no-extension"]) {
    assert.equal(isAnnotatableSubmission(file), false, file);
  }
});
