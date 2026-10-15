const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CourseInventoryService } = require("../src/application/inventory/course-inventory-service");
const { CourseInventoryRepository } = require("../src/adapters/filesystem/course-inventory-repository");

test("course inventory service discovers, enriches, selects, and persists courses through ports", async () => {
  const saved = [];
  const repository = {
    readArchivedCourses: () => [],
    courseLocation: (segments) => ({ outputDirectory: segments.join("/"), outputPath: `/archive/${segments.join("/")}` }),
    readExistingArchive: () => ({ coverageComplete: true }),
    save: (index) => saved.push(index),
  };
  const membershipGateway = {
    async listMemberships(specification) {
      assert.deepEqual(specification, { base: "https://blackboard.example.edu", stateFile: "/private/state.json" });
      return [
        {
          course: {
            id: "_1_1",
            courseId: "2025R1-TEST1000-ULTRA",
            displayName: "2025R1 Test Course (TEST1000-ULTRA)",
            term: { name: "Old 2025-26: 1st Term" },
            ultraStatus: "ULTRA",
          },
        },
        { course: { id: "organization", isOrganization: true } },
      ];
    },
  };
  const service = new CourseInventoryService({
    clock: () => new Date("2026-07-23T08:00:00.000Z"),
    membershipGateway,
    repository,
  });

  const result = await service.refresh({
    attachmentConcurrency: 2,
    base: "https://blackboard.example.edu",
    courseConcurrency: 1,
    downloadMode: "placeholder",
    selection: { all: true, view: "ULTRA" },
    stateFile: "/private/state.json",
  });

  assert.equal(result.index.generatedAt, "2026-07-23T08:00:00.000Z");
  assert.equal(result.index.inventoryCount, 1);
  assert.equal(result.index.courses[0].term.name, "2025-26: 1st Term");
  assert.equal(result.index.courses[0].fetchStatus, "existing complete");
  assert.equal(result.selected[0].id, "_1_1");
  assert.equal(saved.length, 1);
  assert.equal(saved[0], result.index);

  repository.readExistingArchive = () => ({ coverageComplete: false });
  assert.deepEqual(service.refreshArchiveStatus(result.index.courses[0]), { coverageComplete: false });
  service.save(result.index);
  assert.equal(saved.length, 2);
});

test("refresh retains real archives across disappearing and returning memberships without selecting them", async (context) => {
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-reconciliation-"));
  context.after(() => fs.rmSync(archiveRoot, { recursive: true, force: true }));
  const repository = new CourseInventoryRepository({ archiveRoot });
  const makeMembership = (id, name = id) => ({
    course: { id, name, term: { name: "2025-26: 1st Term" }, ultraStatus: "ULTRA" },
  });
  let memberships = [makeMembership("retained"), makeMembership("expired"), makeMembership("never-fetched")];
  const service = new CourseInventoryService({
    membershipGateway: { listMemberships: async () => memberships },
    repository,
  });
  const refresh = () => service.refresh({ base: "https://blackboard.example.edu", selection: { all: true, includeUnavailable: true } });
  const initial = await refresh();
  for (const course of initial.index.courses.filter((item) => item.id !== "never-fetched")) {
    fs.mkdirSync(course.outputPath, { recursive: true });
    fs.writeFileSync(path.join(course.outputPath, "manifest.json"), JSON.stringify({
      courseId: course.id,
      generatedAt: "2026-01-01T00:00:00.000Z",
      coverage: { complete: true },
    }));
  }
  const expiredPath = initial.index.courses.find((item) => item.id === "expired").outputPath;
  const manifestBefore = fs.readFileSync(path.join(expiredPath, "manifest.json"), "utf8");

  memberships = [makeMembership("retained"), makeMembership("new")];
  const result = await refresh();
  assert.equal(result.index.inventoryCount, 3);
  assert.equal(result.index.membershipCount, 2);
  assert.equal(result.index.archiveOnlyCount, 1);
  assert.deepEqual(result.selected.map((item) => item.id).sort(), ["new", "retained"]);
  const expired = result.index.courses.find((item) => item.id === "expired");
  assert.equal(expired.archiveOnly, true);
  assert.equal(expired.membershipPresent, false);
  assert.equal(expired.available, false);
  assert.equal(expired.selected, false);
  assert.equal(expired.existingArchive.coverageComplete, true);
  assert.equal(expired.outputPath, expiredPath);
  assert.match(fs.readFileSync(path.join(archiveRoot, "README.md"), "utf8"), /Local archives without current membership: 1/);

  // An empty current membership response still leaves both local archives visible.
  memberships = [];
  const empty = await refresh();
  assert.equal(empty.index.archiveOnlyCount, 2);
  assert.equal(empty.selected.length, 0);
  assert.deepEqual(empty.index.courses.map((item) => item.id).sort(), ["expired", "retained"]);

  memberships = [makeMembership("expired", "Renamed course")];
  memberships[0].course.term.name = "2026-27: 2nd Term";
  memberships[0].course.ultraStatus = "CLASSIC";
  const returned = await refresh();
  const current = returned.index.courses.find((item) => item.id === "expired");
  assert.equal(current.name, "Renamed course");
  assert.equal(current.term.name, "2026-27: 2nd Term");
  assert.equal(current.view, "CLASSIC");
  assert.equal(current.outputPath, expiredPath);
  assert.equal(current.archiveOnly, false);
  assert.equal(current.membershipPresent, true);
  assert.equal(current.available, true);
  assert.equal(current.selected, true);
  assert.equal(fs.readFileSync(path.join(expiredPath, "manifest.json"), "utf8"), manifestBefore);
});

test("refresh leaves the old catalog intact when its archive metadata is unreadable", async (context) => {
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-unreadable-"));
  context.after(() => fs.rmSync(archiveRoot, { recursive: true, force: true }));
  const indexPath = path.join(archiveRoot, "courses.json");
  fs.writeFileSync(indexPath, '{"courses": [');
  const service = new CourseInventoryService({
    membershipGateway: { listMemberships: async () => [] },
    repository: new CourseInventoryRepository({ archiveRoot }),
  });
  await assert.rejects(service.refresh({}), /Cannot refresh an unreadable course inventory/);
  assert.equal(fs.readFileSync(indexPath, "utf8"), '{"courses": [');
});
