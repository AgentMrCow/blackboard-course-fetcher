const ANNOTATABLE_SUBMISSION_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".pdf",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
]);

function buildStudentFeedbackUrl({ base, courseId, columnId, contentId }) {
  const url = new URL(`/ultra/courses/${encodeURIComponent(courseId)}/grades/student-grade-and-feedback`, base);
  url.searchParams.set("courseId", courseId);
  url.searchParams.set("columnId", columnId);
  url.searchParams.set("contentId", contentId);
  return url.toString();
}

function buildClassicSubmissionHistoryUrl({
  base,
  courseId,
  columnId,
  attemptIndex,
  attemptId,
}) {
  const url = new URL("/webapps/assignment/uploadAssignment", base);
  url.searchParams.set("course_id", courseId);
  url.searchParams.set("action", "showHistory");
  url.searchParams.set("outcome_definition_id", columnId);
  url.searchParams.set("currentAttemptIndex", String(attemptIndex));
  url.searchParams.set("attempt_id", attemptId);
  return url.toString();
}

function isAnnotatableSubmission(fileName) {
  const name = String(fileName || "");
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return ANNOTATABLE_SUBMISSION_EXTENSIONS.has(extension);
}

module.exports = {
  buildClassicSubmissionHistoryUrl,
  buildStudentFeedbackUrl,
  isAnnotatableSubmission,
};
