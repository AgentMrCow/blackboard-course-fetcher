const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyCourseSelection,
  canonicalTermName,
  normalizeMembership,
  termSegments,
} = require("../src/domain/inventory/course-inventory-policy");

function membership(overrides = {}) {
  return {
    isAvailable: true,
    userHasHidden: false,
    course: {
      id: "_1_1",
      courseId: "2025R1-CENG3439-ULTRA",
      displayName: "2025R1 Software Engineering (CENG3439-ULTRA)",
      isAvailable: true,
      term: { id: "term", name: "Old 2025-26: 1st Term" },
      ultraStatus: "ULTRA",
    },
    ...overrides,
  };
}

test("inventory term policy canonicalizes Old labels into stable year and term segments", () => {
  assert.equal(canonicalTermName("Old 2025-26: 1st Term"), "2025-26: 1st Term");
  assert.equal(canonicalTermName("2025-26: 1st Term"), "2025-26: 1st Term");
  assert.deepEqual(termSegments("Old 2025-26: 1st Term"), ["2025-26", "1st Term"]);
  assert.deepEqual(termSegments("Teaching Organization"), ["Other", "Teaching Organization"]);
});

test("inventory membership policy normalizes course metadata and folder names", () => {
  const normalized = normalizeMembership(membership());
  assert.equal(normalized.course.term.sourceName, "Old 2025-26: 1st Term");
  assert.equal(normalized.course.term.name, "2025-26: 1st Term");
  assert.equal(normalized.course.view, "ULTRA");
  assert.deepEqual(normalized.pathSegments, [
    "2025-26",
    "1st Term",
    "2025R1-CENG3439 - Software Engineering",
  ]);
  assert.equal(normalizeMembership(membership({ course: { isOrganization: true } })), null);
});

test("inventory selection handles explicit IDs, availability, filters, and unknown courses", () => {
  const courses = [
    { id: "ultra", available: true, view: "ULTRA", term: { sourceName: "Old 2025-26: 1st Term" }, fetchStatus: "not selected" },
    { id: "classic", available: true, view: "CLASSIC", term: { sourceName: "2024-25: 2nd Term" }, fetchStatus: "not selected" },
    { id: "hidden", available: false, view: "ULTRA", term: { sourceName: "2025-26: 1st Term" }, fetchStatus: "not selected" },
  ];
  const selected = applyCourseSelection(courses, {
    courseIds: ["ultra", "hidden"],
    includeUnavailable: false,
    view: "ALL",
  });
  assert.deepEqual(selected.map((course) => course.id), ["ultra"]);
  assert.equal(courses[0].selected, true);
  assert.equal(courses[2].selected, false);
  assert.equal(courses[2].fetchStatus, "skipped: unavailable");

  assert.throws(
    () => applyCourseSelection(courses, { courseIds: ["missing"] }),
    /Course ID not present in memberships: missing/
  );
});
