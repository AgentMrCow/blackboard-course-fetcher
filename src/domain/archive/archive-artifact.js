const ARTIFACT_ORIGINS = Object.freeze({
  blackboardOriginal: "blackboard-original",
  blackboardContentExport: "blackboard-content-export",
  derivedSearchText: "derived-search-text",
  externalResource: "external-resource",
  fetcherRecord: "fetcher-record",
  localFile: "local-file",
});

const VALID_ORIGINS = new Set(Object.values(ARTIFACT_ORIGINS));

const HTML_EXPORT_ROLES = Object.freeze({
  "announcement.html": "announcement-rendered",
  "body.html": "content-body-rendered",
  "document.html": "document-rendered",
  "feedback.html": "feedback-rendered",
  "h5p_questions.html": "h5p-questions-rendered",
  "instructions.html": "instructions-rendered",
  "quiz_review.html": "quiz-review-rendered",
  "quiz_review.raw.html": "quiz-review-raw",
  "submission.html": "submission-rendered",
});

const TEXT_EXPORT_ROLES = Object.freeze({
  "announcement.txt": "announcement-search-text",
  "document.txt": "document-search-text",
  "feedback.txt": "feedback-search-text",
  "h5p_questions.txt": "h5p-questions-search-text",
  "instructions.txt": "instructions-search-text",
  "quiz_review.txt": "quiz-review-search-text",
  "submission.txt": "submission-search-text",
});

const STRUCTURED_EXPORT_ROLES = Object.freeze({
  "achievements.json": "achievements-data",
  "calendar.json": "calendar-data",
  "discussions.json": "discussions-data",
  "groups.json": "groups-data",
  "h5p_content.json": "h5p-content-data",
  "messages.json": "messages-data",
  "quiz_attempt_api.json": "quiz-attempt-data",
  "quiz_review.json": "quiz-review-data",
  "youtube_oembed.json": "external-oembed-data",
});

function normalizeArtifactPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function artifactDirectory(value) {
  const normalized = normalizeArtifactPath(value);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function artifactBasename(value) {
  return normalizeArtifactPath(value).split("/").at(-1) || "";
}

function joinedArtifactPath(directory, name) {
  return normalizeArtifactPath(directory ? `${directory}/${name}` : name);
}

function defaultHidden(origin, role) {
  if (["placeholder", "unresolved"].includes(role)) return false;
  return [
    ARTIFACT_ORIGINS.blackboardContentExport,
    ARTIFACT_ORIGINS.derivedSearchText,
    ARTIFACT_ORIGINS.fetcherRecord,
  ].includes(origin);
}

function defaultSearchable(origin, role) {
  if (["placeholder", "unresolved", "archive-summary", "status-summary", "manifest"].includes(role)) {
    return false;
  }
  return origin !== ARTIFACT_ORIGINS.fetcherRecord;
}

function normalizeArtifactRecord(record, provenanceSource = "manifest") {
  const path = normalizeArtifactPath(record?.path);
  if (!path) throw new TypeError("Archive artifact path is required");
  const origin = VALID_ORIGINS.has(record.origin) ? record.origin : ARTIFACT_ORIGINS.fetcherRecord;
  const role = String(record.role || "archive-record");
  const primaryPath = normalizeArtifactPath(record.primaryPath || path);
  return {
    path,
    origin,
    role,
    hiddenByDefault: record.hiddenByDefault ?? defaultHidden(origin, role),
    searchable: record.searchable ?? defaultSearchable(origin, role),
    provenanceSource: record.provenanceSource || provenanceSource,
    groupKey: String(record.groupKey || primaryPath),
    primaryPath,
    logicalItemType: record.logicalItemType || null,
    logicalItemId: record.logicalItemId || null,
    logicalItemTitle: record.logicalItemTitle || null,
  };
}

function recordManifestArtifact(manifest, path, metadata = {}) {
  if (!manifest || typeof manifest !== "object") throw new TypeError("Manifest is required");
  if (!Array.isArray(manifest.artifacts)) manifest.artifacts = [];
  const normalizedPath = normalizeArtifactPath(path);
  const existing = manifest.artifacts.findIndex(
    (item) => normalizeArtifactPath(item?.path) === normalizedPath
  );
  const artifact = normalizeArtifactRecord({
    ...(existing >= 0 ? manifest.artifacts[existing] : {}),
    ...metadata,
    path: normalizedPath,
  }, "manifest");
  if (existing >= 0) manifest.artifacts[existing] = artifact;
  else manifest.artifacts.push(artifact);
  return artifact;
}

function relatedItems(manifest) {
  return [
    ...(manifest?.assessments || []).map((item) => ({
      directory: normalizeArtifactPath(item.directory),
      logicalItemType: "assessment",
      logicalItemId: item.contentId || item.columnId || null,
      logicalItemTitle: item.title || null,
    })),
    ...(manifest?.announcements || []).map((item) => ({
      directory: normalizeArtifactPath(item.directory),
      logicalItemType: "announcement",
      logicalItemId: item.id || null,
      logicalItemTitle: item.title || null,
    })),
    ...(manifest?.contents || []).map((item) => ({
      directory: normalizeArtifactPath(item.directory),
      logicalItemType: "content",
      logicalItemId: item.id || null,
      logicalItemTitle: item.title || null,
      files: (item.files || []).map(normalizeArtifactPath),
    })),
  ]
    .filter((item) => item.directory)
    .sort((left, right) => right.directory.length - left.directory.length);
}

function relationForPath(relations, path) {
  return relations.find(
    (item) => path === item.directory || path.startsWith(`${item.directory}/`)
  ) || null;
}

function inferredRecord(path, manifest, relations) {
  const name = artifactBasename(path);
  const lowerName = name.toLowerCase();
  const directory = artifactDirectory(path);
  const relation = relationForPath(relations, path);
  const related = relation
    ? {
        logicalItemType: relation.logicalItemType,
        logicalItemId: relation.logicalItemId,
        logicalItemTitle: relation.logicalItemTitle,
      }
    : {};

  const externalShortcut = relation?.files?.find((file) => {
    if (!/\.url$/i.test(file) || artifactDirectory(file) !== directory) return false;
    return artifactBasename(file).replace(/\.url$/i, "").toLowerCase()
      === name.replace(/\.html$/i, "").toLowerCase();
  });

  if (/\.placeholder\.json$/i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: "placeholder", ...related }, "inferred");
  }
  if (/\.unresolved\.json$/i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: "unresolved", ...related }, "inferred");
  }
  if (lowerName === "readme.md") {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: "archive-summary", ...related }, "inferred");
  }
  if (lowerName === "current_status.md") {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: "status-summary" }, "inferred");
  }
  if (/^manifest(?:\.failed)?\.json$/i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: "manifest" }, "inferred");
  }
  if (lowerName === "gradebook.json") {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.blackboardContentExport, role: "gradebook-data" }, "inferred");
  }
  if (/\.html$/i.test(name) && externalShortcut) {
    return normalizeArtifactRecord({
      path,
      origin: ARTIFACT_ORIGINS.blackboardContentExport,
      role: "external-link-rendered",
      hiddenByDefault: true,
      searchable: false,
      groupKey: externalShortcut,
      primaryPath: externalShortcut,
      ...related,
    }, "inferred");
  }
  if (HTML_EXPORT_ROLES[lowerName]) {
    const family = lowerName.replace(/(?:\.raw)?\.html$/, "");
    const primaryPath = joinedArtifactPath(directory, `${family}.html`);
    return normalizeArtifactRecord({
      path,
      origin: ARTIFACT_ORIGINS.blackboardContentExport,
      role: HTML_EXPORT_ROLES[lowerName],
      groupKey: `${directory}/${family}`,
      primaryPath,
      searchable: false,
      ...related,
    }, "inferred");
  }
  if (TEXT_EXPORT_ROLES[lowerName]) {
    const family = lowerName.replace(/\.txt$/, "");
    return normalizeArtifactRecord({
      path,
      origin: ARTIFACT_ORIGINS.derivedSearchText,
      role: TEXT_EXPORT_ROLES[lowerName],
      groupKey: `${directory}/${family}`,
      primaryPath: joinedArtifactPath(directory, `${family}.html`),
      searchable: true,
      ...related,
    }, "inferred");
  }
  if (STRUCTURED_EXPORT_ROLES[lowerName]) {
    const family = lowerName === "quiz_review.json" ? "quiz_review" : lowerName.replace(/\.json$/, "");
    return normalizeArtifactRecord({
      path,
      origin: ARTIFACT_ORIGINS.blackboardContentExport,
      role: STRUCTURED_EXPORT_ROLES[lowerName],
      groupKey: `${directory}/${family}`,
      primaryPath: lowerName === "quiz_review.json" ? joinedArtifactPath(directory, "quiz_review.html") : path,
      ...related,
    }, "inferred");
  }
  if (/\.annotations\.json$/i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.blackboardContentExport, role: "annotation-data", ...related }, "inferred");
  }
  if (lowerName === "submitted_files.json" || lowerName === "external_metadata.json" || lowerName === "lti_metadata.json") {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: lowerName.replace(/\.json$/, "").replace(/_/g, "-") }, "inferred");
  }
  if (/^external_snapshot\./i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.externalResource, role: "external-snapshot", hiddenByDefault: true, ...related }, "inferred");
  }
  if (/^youtube_(?:thumbnail|captions_)/i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.externalResource, role: "external-media", hiddenByDefault: false, ...related }, "inferred");
  }
  if (/\.ics$/i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.blackboardContentExport, role: "calendar-export", hiddenByDefault: false }, "inferred");
  }
  if (/\.url$/i.test(name)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.blackboardContentExport, role: "external-link", hiddenByDefault: false, ...related }, "inferred");
  }
  if (/\.h5p$/i.test(name)) {
    return normalizeArtifactRecord({
      path,
      origin: ARTIFACT_ORIGINS.externalResource,
      role: "h5p-package",
      hiddenByDefault: false,
      ...related,
    }, "inferred");
  }
  return null;
}

function downloadRecord(path, download, relations) {
  const relation = relationForPath(relations, path);
  const related = relation
    ? {
        logicalItemType: relation.logicalItemType,
        logicalItemId: relation.logicalItemId,
        logicalItemTitle: relation.logicalItemTitle,
      }
    : {};
  if (download.placeholder || /\.placeholder\.json$/i.test(path)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: "placeholder", ...related }, "download-record");
  }
  if (download.unresolved || /\.unresolved\.json$/i.test(path)) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.fetcherRecord, role: "unresolved", ...related }, "download-record");
  }
  if (download.linkOnly) {
    return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.blackboardContentExport, role: "external-link", hiddenByDefault: false, ...related }, "download-record");
  }
  if (download.externalSnapshot) {
    const name = artifactBasename(path);
    const role = /^external_snapshot\./i.test(name)
      ? "external-snapshot"
      : /^youtube_/i.test(name)
        ? "external-media"
        : "external-resource";
    return normalizeArtifactRecord({
      path,
      origin: ARTIFACT_ORIGINS.externalResource,
      role,
      hiddenByDefault: role === "external-snapshot",
      ...related,
    }, "download-record");
  }
  const role = /\/submissions\/[^/]+\/files\//i.test(path)
    ? "submission-file"
    : /\/(?:feedback|quiz_review|instructions|document|body)_files\//i.test(path)
      ? "embedded-attachment"
      : "course-file";
  return normalizeArtifactRecord({ path, origin: ARTIFACT_ORIGINS.blackboardOriginal, role, hiddenByDefault: false, ...related }, "download-record");
}

function createArtifactClassifier(manifest = {}) {
  const explicit = new Map(
    (manifest.artifacts || [])
      .filter((item) => item?.path)
      .map((item) => {
        const normalized = normalizeArtifactRecord(item, "manifest");
        return [normalized.path, normalized];
      })
  );
  const downloads = new Map(
    (manifest.downloads || [])
      .filter((item) => item?.path)
      .map((item) => [normalizeArtifactPath(item.path), item])
  );
  const relations = relatedItems(manifest);
  return (value) => {
    const path = normalizeArtifactPath(value);
    if (explicit.has(path)) return explicit.get(path);
    if (downloads.has(path)) return downloadRecord(path, downloads.get(path), relations);
    const inferred = inferredRecord(path, manifest, relations);
    if (inferred) return inferred;
    const relation = relationForPath(relations, path);
    return normalizeArtifactRecord({
      path,
      origin: ARTIFACT_ORIGINS.localFile,
      role: "local-file",
      hiddenByDefault: false,
      ...(relation
        ? {
            logicalItemType: relation.logicalItemType,
            logicalItemId: relation.logicalItemId,
            logicalItemTitle: relation.logicalItemTitle,
          }
        : {}),
    }, "local-scan");
  };
}

function artifactMatchesScope(artifact, scope = "materials") {
  if (scope === "all") return true;
  if (scope === "records") return artifact.origin === ARTIFACT_ORIGINS.fetcherRecord;
  if (scope === "exports") {
    if (![ARTIFACT_ORIGINS.blackboardContentExport, ARTIFACT_ORIGINS.derivedSearchText, ARTIFACT_ORIGINS.externalResource].includes(artifact.origin)) {
      return false;
    }
    return artifact.origin !== ARTIFACT_ORIGINS.derivedSearchText && artifact.path === artifact.primaryPath;
  }
  return artifact.hiddenByDefault !== true;
}

function artifactCountSummary(files) {
  const summary = Object.fromEntries(
    ["all", "materials", "exports", "records"].map((key) => [key, { files: 0, bytes: 0 }])
  );
  for (const file of files || []) {
    const size = Number(file.size) || 0;
    summary.all.files += 1;
    summary.all.bytes += size;
    for (const scope of ["materials", "exports", "records"]) {
      if (!artifactMatchesScope(file, scope)) continue;
      summary[scope].files += 1;
      summary[scope].bytes += size;
    }
  }
  return summary;
}

module.exports = {
  ARTIFACT_ORIGINS,
  artifactCountSummary,
  artifactMatchesScope,
  createArtifactClassifier,
  normalizeArtifactPath,
  recordManifestArtifact,
};
