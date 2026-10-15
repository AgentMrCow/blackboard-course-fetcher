const test = require("node:test");
const assert = require("node:assert/strict");
const { FetchCommandService, MINIMUM_FULL_FETCH_FREE_BYTES } = require("../src/application/fetch-jobs/fetch-command-service");
const { SettingsCommandService } = require("../src/application/settings/settings-command-service");

const SETTINGS = {
  archiveRoot: "/workspace/archive",
  attachmentConcurrency: 2,
  blackboardBase: "https://blackboard.example.edu",
  courseConcurrency: 1,
  downloadMode: "placeholder",
  reuseValidatedCache: false,
  stateFile: "/workspace/state.json",
};

function settingsDependencies(overrides = {}) {
  const calls = [];
  const nextArchiveService = { archiveRoot: "/workspace/new-archive" };
  return {
    calls,
    nextArchiveService,
    dependencies: {
      authentication: {
        active: () => false,
        setSettings: (settings) => calls.push(["authentication", settings]),
      },
      createArchiveService: (archiveRoot) => {
        calls.push(["createArchiveService", archiveRoot]);
        return nextArchiveService;
      },
      ensureArchiveRoot: (archiveRoot) => calls.push(["ensureArchiveRoot", archiveRoot]),
      fileIndexCoordinator: {
        reconfigure: (value) => calls.push(["fileIndex", value]),
      },
      inventoryCoordinator: {
        active: () => false,
        setArchiveService: (archiveService) => calls.push(["inventoryArchive", archiveService]),
        setSettings: (settings) => calls.push(["inventorySettings", settings]),
      },
      jobs: {
        activeBatch: () => null,
        setArchiveService: (archiveService) => calls.push(["jobs", archiveService]),
      },
      scriptDirectory: "/workspace",
      settings: SETTINGS,
      settingsRepository: {
        save: (settings) => calls.push(["save", settings]),
      },
      ...overrides,
    },
  };
}

test("settings command persists normalized settings and rebinds runtime services", () => {
  const fixture = settingsDependencies();
  const service = new SettingsCommandService(fixture.dependencies);
  const result = service.update({
    archiveRoot: "new-archive",
    attachmentConcurrency: 4,
    blackboardBase: "https://new.example.edu/",
    courseConcurrency: 2,
    downloadMode: "full",
    reuseValidatedCache: true,
  });

  assert.equal(result.settings.archiveRoot, "/workspace/new-archive");
  assert.equal(result.settings.blackboardBase, "https://new.example.edu");
  assert.equal(result.settings.downloadMode, "full");
  assert.equal(result.archiveService, fixture.nextArchiveService);
  assert.deepEqual(fixture.calls.map(([name]) => name), [
    "ensureArchiveRoot",
    "createArchiveService",
    "save",
    "jobs",
    "authentication",
    "inventorySettings",
    "inventoryArchive",
    "fileIndex",
  ]);
  assert.equal(fixture.calls.at(-1)[1].settings, result.settings);
  assert.equal(fixture.calls.at(-1)[1].archiveService, fixture.nextArchiveService);
});

test("settings command rejects changes while a managed background task is active", () => {
  for (const activeDependency of ["jobs", "authentication", "inventoryCoordinator"]) {
    const fixture = settingsDependencies();
    if (activeDependency === "jobs") fixture.dependencies.jobs.activeBatch = () => ({ id: "active" });
    else fixture.dependencies[activeDependency].active = () => true;
    const service = new SettingsCommandService(fixture.dependencies);

    assert.throws(
      () => service.update({ archiveRoot: "other" }),
      (error) => error.statusCode === 409
    );
    assert.deepEqual(fixture.calls, []);
  }
});

test("fetch command applies current settings to a new batch", () => {
  const calls = [];
  const jobs = {
    archiveService: { getInventory: () => ({ courses: [{ id: "_1_1" }] }) },
    createAndStart(options, runtime) {
      calls.push({ options, runtime });
      return { id: "fetch-1" };
    },
  };
  const service = new FetchCommandService({
    jobs,
    settings: SETTINGS,
    systemStatus: () => ({ disk: { freeBytes: 2 * 1024 ** 3 } }),
  });

  assert.deepEqual(service.start({ courseIds: ["_1_1"] }), { id: "fetch-1" });
  assert.deepEqual(calls, [{
    options: {
      attachmentConcurrency: 2,
      confirmFull: false,
      courseConcurrency: 1,
      courseIds: ["_1_1"],
      mode: "placeholder",
      reuseValidatedCache: false,
    },
    runtime: {
      base: "https://blackboard.example.edu",
      stateFile: "/workspace/state.json",
    },
  }]);
});

test("fetch command rejects a full fetch when archive storage is low", () => {
  let starts = 0;
  const service = new FetchCommandService({
    jobs: {
      archiveService: { getInventory: () => ({ courses: [{ id: "_1_1" }] }) },
      createAndStart: () => { starts += 1; },
    },
    settings: SETTINGS,
    systemStatus: () => ({ disk: { freeBytes: MINIMUM_FULL_FETCH_FREE_BYTES - 1 } }),
  });

  assert.throws(
    () => service.start({ courseIds: ["_1_1"], mode: "FULL" }),
    (error) => error.statusCode === 507
  );
  assert.equal(starts, 0);
});

test("fetch command rejects mixed batches containing archive-only courses before launching work", () => {
  for (const archivedState of [{ archiveOnly: true }, { membershipPresent: false }]) {
    let starts = 0;
    const service = new FetchCommandService({
      jobs: {
        archiveService: {
          getInventory: () => ({ courses: [
            { id: "active", membershipPresent: true, archiveOnly: false },
            { id: "historical", available: true, ...archivedState },
          ] }),
        },
        createAndStart: () => { starts += 1; },
      },
      settings: SETTINGS,
      systemStatus: () => ({ disk: { freeBytes: 2 * 1024 ** 3 } }),
    });
    assert.throws(
      () => service.start({ courseIds: ["active", "historical"], mode: "full", confirmFull: true }),
      (error) => error.statusCode === 409 && /no current Blackboard membership/.test(error.message)
    );
    assert.equal(starts, 0);
    service.start({ courseIds: ["active"] });
    assert.equal(starts, 1);
  }
});

test("fetch command reads the rebound archive inventory when settings change", () => {
  let starts = 0;
  const jobs = {
    archiveService: { getInventory: () => ({ courses: [{ id: "course", archiveOnly: true }] }) },
    createAndStart: () => { starts += 1; },
  };
  const service = new FetchCommandService({
    jobs,
    settings: SETTINGS,
    systemStatus: () => ({ disk: {} }),
  });
  assert.throws(() => service.start({ courseIds: ["course"] }), (error) => error.statusCode === 409);
  jobs.archiveService = { getInventory: () => ({ courses: [{ id: "course", membershipPresent: true, archiveOnly: false }] }) };
  service.setSettings({ ...SETTINGS, archiveRoot: "/workspace/other-archive" });
  service.start({ courseIds: ["course"] });
  assert.equal(starts, 1);
});
