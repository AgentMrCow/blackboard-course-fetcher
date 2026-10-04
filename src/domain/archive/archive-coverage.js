const { isFileDownloadMarker } = require("../course-fetch/course-file-policy");

const CLASSIC_ATTACHMENT_COVERAGE_SCHEMA_VERSION = 11;

const CLASSIC_ATTACHMENT_CAPABLE_HANDLERS = new Set([
  "resource/x-bb-assignment",
  "resource/x-bb-asmt-test-link",
  "resource/x-bb-document",
]);

const LEGACY_CLASSIC_ATTACHMENT_COVERAGE = "legacy_classic_attachment_coverage";
const BINARY_FILE_BODY_MISSING = "binary_file_body_missing";
const CONTENT_PATH_COLLISION = "content_path_collision";

function normalizedArchivePath(value) {
  return String(value || "").replace(/\\/g, "/").normalize("NFKC").toLowerCase();
}

function hasContentPathCollision(manifest) {
  const owners = new Map();
  for (const item of manifest?.contents || []) {
    if (!item?.id || !item.directory || item.ownDirectory === false) continue;
    if (item.handler === "resource/x-bb-file" && item.ownDirectory !== true) continue;
    const directory = normalizedArchivePath(item.directory);
    // Legacy wrapper aliases intentionally shared the canonical categories.
    if (item.container && item.ownDirectory !== true && /^\d{2}_[^/]+$/.test(directory)) continue;
    const owner = owners.get(directory);
    if (owner && owner !== item.id) return true;
    owners.set(directory, item.id);
  }
  const hashes = new Map();
  for (const item of manifest?.downloads || []) {
    if (!item?.path || !item.sha256) continue;
    const key = normalizedArchivePath(item.path);
    if (hashes.has(key) && hashes.get(key) !== item.sha256) return true;
    hashes.set(key, item.sha256);
  }
  return false;
}

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
  const invalidFileBodies = (manifest?.downloads || []).some((download) =>
    download.unresolved === true || (
      manifest.downloadMode !== "placeholder" &&
      (download.placeholder === true || isFileDownloadMarker(download))
    ) || (isFileDownloadMarker(download) && download.placeholder !== true && download.unresolved !== true)
  );
  if (invalidFileBodies) {
    issues.push({
      code: BINARY_FILE_BODY_MISSING,
      message: "Some attachment records contain only placeholder or unresolved metadata, not the file body. Refetch in Full mode to download and verify the actual files.",
    });
  }
  if (hasContentPathCollision(manifest)) {
    issues.push({
      code: CONTENT_PATH_COLLISION,
      message: "Different content items share a case-insensitive archive path and may have overwritten each other. Refetch the course to archive them in separate folders.",
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
  BINARY_FILE_BODY_MISSING,
  CONTENT_PATH_COLLISION,
  CLASSIC_ATTACHMENT_CAPABLE_HANDLERS,
  CLASSIC_ATTACHMENT_COVERAGE_SCHEMA_VERSION,
  LEGACY_CLASSIC_ATTACHMENT_COVERAGE,
  effectiveArchiveCoverage,
  requiresClassicAttachmentRefresh,
};
