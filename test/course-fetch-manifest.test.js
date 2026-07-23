const test = require("node:test");
const assert = require("node:assert/strict");
const {
  coverageExclusions,
  coverageScope,
  createCourseFetchManifest,
  indexPreviousDownloads,
} = require("../src/domain/course-fetch/course-fetch-manifest");
const {
  recordManifestArtifact,
} = require("../src/domain/archive/archive-artifact");

test("single-course manifest factory preserves schema and mutable counters", () => {
  const manifest = createCourseFetchManifest({
    archiveLayoutVersion: 3,
    attachmentConcurrency: 4,
    courseId: "_123_1",
    downloadMode: "full",
    generatedAt: "2026-07-23T10:00:00.000Z",
    layoutMigration: [{ from: "old", to: "new" }],
    outputRoot: "/archive/course",
    reuseValidatedCache: true,
  });

  assert.equal(manifest.schemaVersion, 12);
  assert.equal(manifest.archiveLayoutVersion, 3);
  assert.equal(manifest.courseId, "_123_1");
  assert.equal(manifest.course, null);
  assert.equal(manifest.generatedAt, "2026-07-23T10:00:00.000Z");
  assert.deepEqual(manifest.settings, {
    attachmentConcurrency: 4,
    reuseValidatedCache: true,
  });
  assert.deepEqual(manifest.timings, { phases: {}, totalMs: null });
  assert.deepEqual(manifest.transfer, {
    networkFiles: 0,
    networkBytes: 0,
    reusedFiles: 0,
    reusedBytes: 0,
    placeholderFiles: 0,
    unresolvedFiles: 0,
  });
  assert.deepEqual(manifest.downloads, []);
  assert.deepEqual(manifest.artifacts, []);
  assert.deepEqual(manifest.ltiResources, []);
  assert.deepEqual(manifest.warnings, []);
  assert.deepEqual(manifest.errors, []);
});

test("manifest artifacts preserve explicit provenance and replace duplicate paths", () => {
  const manifest = { artifacts: [] };
  recordManifestArtifact(manifest, "folder\\instructions.html", {
    origin: "blackboard-content-export",
    role: "instructions-rendered",
    logicalItemType: "assessment",
    logicalItemId: "_content_1",
  });
  recordManifestArtifact(manifest, "folder/instructions.html", {
    origin: "blackboard-content-export",
    role: "instructions-rendered",
    logicalItemTitle: "Project",
  });

  assert.equal(manifest.artifacts.length, 1);
  assert.deepEqual(manifest.artifacts[0], {
    path: "folder/instructions.html",
    origin: "blackboard-content-export",
    role: "instructions-rendered",
    hiddenByDefault: true,
    searchable: true,
    provenanceSource: "manifest",
    groupKey: "folder/instructions.html",
    primaryPath: "folder/instructions.html",
    logicalItemType: "assessment",
    logicalItemId: "_content_1",
    logicalItemTitle: "Project",
  });
});

test("coverage policy adds only placeholder-specific disclosures", () => {
  assert.equal(coverageScope("full").includes("binary attachment metadata placeholders (test mode)"), false);
  assert.equal(coverageExclusions("full").includes("binary file bodies intentionally omitted by placeholder test mode"), false);
  assert.equal(coverageScope("placeholder").at(-1), "binary attachment metadata placeholders (test mode)");
  assert.equal(
    coverageExclusions("placeholder").at(-1),
    "binary file bodies intentionally omitted by placeholder test mode"
  );
});

test("previous downloads are indexed by source URL", () => {
  const first = { sourceUrl: "https://example.edu/one", size: 1 };
  const second = { sourceUrl: "https://example.edu/two", size: 2 };
  const index = indexPreviousDownloads({ downloads: [first, { size: 0 }, second] });
  assert.equal(index.get(first.sourceUrl), first);
  assert.equal(index.get(second.sourceUrl), second);
  assert.equal(index.size, 2);
  assert.equal(indexPreviousDownloads(null).size, 0);
});
