const BASE_COVERAGE_SCOPE = Object.freeze([
  "student-visible course content tree",
  "course files and embedded Blackboard attachments",
  "announcements",
  "gradebook columns and current grades",
  "assessment attempts, submitted files, receipts, and released feedback",
  "completed quiz review questions, submitted answers, correct-answer markers, and visible feedback",
  "supported third-party LTI launch metadata and H5P content packages",
  "course calendar events",
  "discussion inventory and accessible discussion data",
  "course messages and accessible conversation data",
  "accessible group memberships and member profiles",
  "achievements",
  "external-link HTML snapshots and metadata",
  "Blackboard Annotate metadata, comments, and annotations",
]);

const BASE_COVERAGE_EXCLUSIONS = Object.freeze([
  "instructor-only, unavailable, or deleted content",
  "other teams' rosters when Blackboard denies student access",
  "external-site dynamic assets and media streams not present in the saved HTML snapshot",
  "third-party LTI data not exposed to the Blackboard student session",
  "SCORM package runtime data not exposed through Blackboard's student APIs",
]);

function coverageScope(downloadMode) {
  return [
    ...BASE_COVERAGE_SCOPE,
    ...(downloadMode === "placeholder" ? ["binary attachment metadata placeholders (test mode)"] : []),
  ];
}

function coverageExclusions(downloadMode) {
  return [
    ...BASE_COVERAGE_EXCLUSIONS,
    ...(downloadMode === "placeholder"
      ? ["binary file bodies intentionally omitted by placeholder test mode"]
      : []),
  ];
}

function createCourseFetchManifest({
  archiveLayoutVersion,
  attachmentConcurrency,
  courseId,
  downloadMode,
  generatedAt,
  layoutMigration,
  outputRoot,
  reuseValidatedCache,
}) {
  return {
    schemaVersion: 12,
    archiveLayoutVersion,
    layoutMigration,
    generatedAt,
    courseId,
    course: null,
    downloadMode,
    outputRoot,
    downloads: [],
    artifacts: [],
    contents: [],
    announcements: [],
    assessments: [],
    ltiResources: [],
    gradebook: null,
    calendar: null,
    discussions: null,
    messages: null,
    groups: null,
    achievements: null,
    annotations: null,
    quizReviews: null,
    externalLinks: null,
    extraArchive: null,
    coverage: null,
    settings: {
      attachmentConcurrency,
      reuseValidatedCache,
    },
    timings: {
      phases: {},
      totalMs: null,
    },
    transfer: {
      networkFiles: 0,
      networkBytes: 0,
      reusedFiles: 0,
      reusedBytes: 0,
      placeholderFiles: 0,
      unresolvedFiles: 0,
    },
    warnings: [],
    errors: [],
  };
}

function indexPreviousDownloads(previousManifest) {
  return new Map(
    (previousManifest?.downloads || [])
      .filter((item) => item.sourceUrl)
      .map((item) => [item.sourceUrl, item])
  );
}

module.exports = {
  coverageExclusions,
  coverageScope,
  createCourseFetchManifest,
  indexPreviousDownloads,
};
