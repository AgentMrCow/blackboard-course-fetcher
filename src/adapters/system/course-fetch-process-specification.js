const path = require("path");

function courseFetchArguments(specification, { scriptDirectory }) {
  return [
    path.join(scriptDirectory, "bin", "fetch-blackboard-course.js"),
    "--course-id",
    specification.courseId,
    "--output",
    specification.outputPath,
    "--state",
    specification.stateFile,
    "--download-mode",
    specification.mode,
    "--attachment-concurrency",
    String(specification.attachmentConcurrency),
    "--base",
    specification.base,
    ...(specification.reuseValidatedCache ? ["--reuse-validated-cache"] : []),
  ];
}

function courseFetchEnvironment(specification, environment, { progressEvents = false } = {}) {
  const result = {
    ...environment,
    BB_COURSE_NAME: specification.courseName,
    BB_COURSE_TERM: specification.courseTerm,
  };
  if (progressEvents) result.BB_PROGRESS_EVENTS = "1";
  return result;
}

module.exports = { courseFetchArguments, courseFetchEnvironment };
