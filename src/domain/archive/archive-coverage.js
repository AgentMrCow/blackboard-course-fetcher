const CLASSIC_ATTACHMENT_COVERAGE_SCHEMA_VERSION = 11;

const CLASSIC_ATTACHMENT_CAPABLE_HANDLERS = new Set([
  "resource/x-bb-assignment",
  "resource/x-bb-asmt-test-link",
  "resource/x-bb-document",
]);

const LEGACY_CLASSIC_ATTACHMENT_COVERAGE = "legacy_classic_attachment_coverage";

function manifestSchemaVersion(manifest) {
  const version = Number(manifest?.schemaVersion);
  return Number.isFinite(version) ? version : 0;
}

function requiresClassicAttachmentRefresh(manifest) {
  if (String(manifest?.course?.ultraStatus || "").toUpperCase() !== "CLASSIC") return false;
  if (manifestSchemaVersion(manifest) >= CLASSIC_ATTACHMENT_COVERAGE_SCHEMA_VERSION) return false;
  return (manifest?.contents || []).some((item) =>
    CLASSIC_ATTACHMENT_CAPABLE_HANDLERS.has(item?.handler || item?.contentHandler)
  );
}

function effectiveArchiveCoverage(manifest) {
  const reportedComplete = manifest?.coverage?.complete === true;
  const requiresRefresh = requiresClassicAttachmentRefresh(manifest);
  const issues = [];
  if (requiresRefresh) {
    issues.push({
      code: LEGACY_CLASSIC_ATTACHMENT_COVERAGE,
      message: "This Classic archive predates complete attachment discovery. Refetch the course to verify and archive document attachments.",
    });
  }
  return {
    complete: reportedComplete && issues.length === 0,
    reportedComplete,
    issueCodes: issues.map((issue) => issue.code),
    issues: issues.map((issue) => issue.message),
    issueCode: issues[0]?.code || null,
    issue: issues.map((issue) => issue.message).join(" ") || null,
  };
}

module.exports = {
  CLASSIC_ATTACHMENT_CAPABLE_HANDLERS,
  CLASSIC_ATTACHMENT_COVERAGE_SCHEMA_VERSION,
  LEGACY_CLASSIC_ATTACHMENT_COVERAGE,
  effectiveArchiveCoverage,
  requiresClassicAttachmentRefresh,
};
