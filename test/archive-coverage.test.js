const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LEGACY_CLASSIC_ATTACHMENT_COVERAGE,
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
