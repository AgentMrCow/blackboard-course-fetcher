const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LEGACY_CLASSIC_ATTACHMENT_COVERAGE,
  BINARY_FILE_BODY_MISSING,
  CONTENT_PATH_COLLISION,
  effectiveArchiveCoverage,
  requiresClassicAttachmentRefresh,
} = require("../src/domain/archive/archive-coverage");

function manifest({
  complete = true,
  handler = "resource/x-bb-document",
  schemaVersion = 10,
  ultraStatus = "CLASSIC",
} = {}) {
  return {
    schemaVersion,
    course: { ultraStatus },
    coverage: { complete },
    contents: [{ handler }],
  };
}

test("old Classic manifests with attachment-capable content require a refresh", () => {
  const coverage = effectiveArchiveCoverage(manifest());

  assert.equal(requiresClassicAttachmentRefresh(manifest()), true);
  assert.equal(coverage.reportedComplete, true);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.issueCode, LEGACY_CLASSIC_ATTACHMENT_COVERAGE);
  assert.match(coverage.issue, /attachment discovery/i);
});

test("schema 11 Classic manifests can prove attachment coverage", () => {
  const coverage = effectiveArchiveCoverage(manifest({ schemaVersion: 11 }));

  assert.equal(coverage.complete, true);
  assert.equal(coverage.issue, null);
});

test("old Ultra and standalone-file-only manifests retain their reported coverage", () => {
  assert.equal(effectiveArchiveCoverage(manifest({ ultraStatus: "ULTRA" })).complete, true);
  assert.equal(effectiveArchiveCoverage(manifest({ handler: "resource/x-bb-file" })).complete, true);
});

test("effective coverage never upgrades a manifest that reports incomplete coverage", () => {
  const coverage = effectiveArchiveCoverage(manifest({
    complete: false,
    schemaVersion: 11,
  }));

  assert.equal(coverage.complete, false);
  assert.equal(coverage.reportedComplete, false);
  assert.equal(coverage.issue, null);
});

for (const download of [
  { placeholder: true, path: "file.json" },
  { unresolved: true, path: "file.json" },
  { path: "files/notes.pdf.placeholder.json", sha256: "marker-hash" },
  { path: "files\\notes.pdf.PLACEHOLDER (legacy 2).json", sha256: "marker-hash" },
  { path: "files/notes.pdf.unresolved (2).json", sha256: "marker-hash" },
  { path: "record.json", fileName: "notes.pdf.placeholder.json", sha256: "marker-hash" },
]) {
  test(`invalidates full archives with missing file bodies: ${download.path}`, () => {
    const archive = { ...manifest({ schemaVersion: 12 }), downloadMode: "full", downloads: [download] };
    const coverage = effectiveArchiveCoverage(archive);
    assert.equal(coverage.reportedComplete, true);
    assert.equal(coverage.complete, false);
    assert.equal(coverage.issueCode, BINARY_FILE_BODY_MISSING);
    assert.match(coverage.issue, /Full mode/);
  });
}

test("legitimate placeholder test archives and external-link shortcuts retain their scope", () => {
  const archive = { ...manifest({ schemaVersion: 12 }), downloadMode: "placeholder", downloads: [
    { path: "notes.pdf.placeholder.json", placeholder: true },
    { path: "link.url", linkOnly: true },
  ] };
  assert.equal(effectiveArchiveCoverage(archive).complete, true);
  archive.downloadMode = "full";
  archive.downloads.shift();
  assert.equal(effectiveArchiveCoverage(archive).complete, true);
});

test("old placeholder caches with stripped flags still require a full refetch", () => {
  const archive = { ...manifest({ schemaVersion: 12 }), downloadMode: "placeholder", downloads: [
    { path: "notes.pdf.placeholder.json", sha256: "marker-hash" },
  ] };
  assert.equal(effectiveArchiveCoverage(archive).issueCode, BINARY_FILE_BODY_MISSING);
});

test("unresolved downloads are incomplete even in placeholder mode", () => {
  const archive = { ...manifest({ schemaVersion: 12 }), downloadMode: "placeholder", downloads: [
    { path: "notes.pdf.unresolved.json", unresolved: true },
  ] };
  assert.equal(effectiveArchiveCoverage(archive).complete, false);
});

test("detects different items sharing Windows case-insensitive content paths", () => {
  const archive = { ...manifest({ schemaVersion: 12 }), contents: [
    { id: "a", handler: "resource/x-bb-externallink", directory: "01_Course_Contents/Verbal reasoning test" },
    { id: "b", handler: "resource/x-bb-externallink", directory: "01_Course_Contents\\Verbal Reasoning Test" },
  ] };
  assert.equal(effectiveArchiveCoverage(archive).complete, false);
  assert.equal(effectiveArchiveCoverage(archive).issueCode, CONTENT_PATH_COLLISION);
});

test("shared file directories and repeated references to identical files are not collisions", () => {
  const directory = "01_Course_Contents/Week 1";
  const archive = { ...manifest({ schemaVersion: 12 }), contents: [
    { id: "folder", handler: "resource/x-bb-folder", directory },
    { id: "file-a", handler: "resource/x-bb-file", directory },
    { id: "file-b", handler: "resource/x-bb-file", directory, ownDirectory: false },
  ], downloads: [
    { path: `${directory}/slides.pdf`, sha256: "same-hash" },
    { path: `${directory}/slides.pdf`, sha256: "same-hash" },
  ] };
  assert.equal(effectiveArchiveCoverage(archive).complete, true);
});

test("conflicting hashes at a shared download path expose old overwrites", () => {
  const archive = { ...manifest({ schemaVersion: 12 }), downloads: [
    { path: "01_Course_Contents/Test/Test.url", sha256: "first-hash" },
    { path: "01_Course_Contents/TEST/Test.url", sha256: "second-hash" },
  ] };
  assert.equal(effectiveArchiveCoverage(archive).issueCode, CONTENT_PATH_COLLISION);
});

test("explicit canonical wrapper owners cannot share a category directory", () => {
  const archive = { ...manifest({ schemaVersion: 12 }), contents: [
    { id: "a", container: true, ownDirectory: true, directory: "01_Course_Contents" },
    { id: "b", container: true, ownDirectory: true, directory: "01_Course_Contents" },
  ] };
  assert.equal(effectiveArchiveCoverage(archive).issueCode, CONTENT_PATH_COLLISION);
  for (const item of archive.contents) delete item.ownDirectory;
  assert.equal(effectiveArchiveCoverage(archive).complete, true);
});

test("coverage reports all integrity issues without losing legacy attachment diagnostics", () => {
  const archive = { ...manifest(), downloadMode: "full", downloads: [
    { path: "notes.pdf.placeholder.json" },
    { path: "link.url", sha256: "a" },
    { path: "link.url", sha256: "b" },
  ] };
  assert.deepEqual(effectiveArchiveCoverage(archive).issueCodes, [
    LEGACY_CLASSIC_ATTACHMENT_COVERAGE, BINARY_FILE_BODY_MISSING, CONTENT_PATH_COLLISION,
  ]);
});
