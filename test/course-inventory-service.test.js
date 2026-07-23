const test = require("node:test");
const assert = require("node:assert/strict");
const { CourseInventoryService } = require("../src/application/inventory/course-inventory-service");

test("course inventory service discovers, enriches, selects, and persists courses through ports", async () => {
  const saved = [];
  const repository = {
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
