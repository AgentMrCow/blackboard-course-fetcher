const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateReportedSize,
  finiteNumber,
  isTextLikeFile,
  needsPlaceholder,
  resolutionFields,
} = require("../src/domain/course-fetch/course-file-policy");

test("course file policy recognizes text payloads without relying on one signal", () => {
  assert.equal(isTextLikeFile({ mimeType: "text/plain", fileName: "data.bin" }), true);
  assert.equal(isTextLikeFile({ contentType: "application/json; charset=utf-8", fileName: "data.bin" }), true);
  assert.equal(isTextLikeFile({ fileName: "SOURCE.CPP" }), true);
  assert.equal(isTextLikeFile({ fileName: "Makefile" }), true);
  assert.equal(isTextLikeFile({ mimeType: "application/pdf", fileName: "notes.pdf" }), false);
  assert.equal(needsPlaceholder("placeholder", { fileName: "notes.pdf" }), true);
  assert.equal(needsPlaceholder("placeholder", { fileName: "notes.txt" }), false);
  assert.equal(needsPlaceholder("full", { fileName: "notes.pdf" }), false);
});

test("reported-size policy preserves strict and accepted mismatch behavior", () => {
  assert.equal(finiteNumber(""), null);
  assert.equal(finiteNumber("42"), 42);
  assert.deepEqual(evaluateReportedSize({
    actualSize: 42,
    allowMismatch: false,
    file: { fileSize: "42" },
    fileName: "report.pdf",
    label: "Report",
  }), {
    fields: { expectedSize: 42, reportedSize: 42, sizeMismatchAccepted: false },
    warning: null,
  });
  assert.throws(
    () => evaluateReportedSize({
      actualSize: 41,
      allowMismatch: false,
      file: { fileSize: 42 },
      fileName: "report.pdf",
      label: "Report",
    }),
    { message: "Downloaded 41 bytes; Blackboard reported 42 bytes" }
  );
  assert.deepEqual(evaluateReportedSize({
    actualSize: 41,
    allowMismatch: true,
    file: { fileSize: 42 },
    fileName: "report.pdf",
    label: "Report",
  }), {
    fields: { expectedSize: null, reportedSize: 42, sizeMismatchAccepted: true },
    warning: {
      label: "Report",
      warning: "report.pdf: downloaded 41 bytes, while Blackboard metadata reports 42; valid attachment response retained",
    },
  });
});

test("resolution fields remain absent unless a fallback method was used", () => {
  assert.deepEqual(resolutionFields({}), {});
  assert.deepEqual(
    resolutionFields({ resolutionMethod: "authenticated Blackboard HTML" }),
    { resolutionMethod: "authenticated Blackboard HTML" }
  );
});
