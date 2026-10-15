const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const controllerSource = fs.readFileSync(path.join(__dirname, "../dashboard/client/src/lib/controller.ts"), "utf8");
const controllerCode = ts.transpileModule(controllerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness() {
  const requests = [];
  const previews = [];
  const eventSources = [];
  const toasts = [];
  const navigations = [];
  const state = {
    filesLoading: false,
    filesError: "",
    allFiles: null,
    filePage: 0,
    filePageSize: 250,
    fileFilters: { query: "first", preview: "all", courseId: "", scope: "materials" },
    courseCache: new Map(),
    searchResults: [],
    bootstrap: { jobs: [], summary: { recentFiles: [] } },
    fileDialog: { open: false },
    detailDialog: { open: false },
    fetchCourseIds: ["c"],
    selectedCourses: new Set(["c"]),
    route: { page: "home" },
    fetchOpen: true,
  };
  const files = ["a.txt", "b.txt", "b.pdf"].map((filePath) => ({
    path: filePath,
    name: filePath,
    preview: filePath.endsWith(".pdf") ? "pdf" : "text",
  }));
  state.courseCache.set("c", { files });
  const module = { exports: {} };
  const statePort = {
    appState: {},
    readState: () => state,
    changeState: (change) => change(state),
    navigate: (target) => navigations.push(target),
    showToast: (...args) => toasts.push(args),
    routeFromHash: () => ({}),
  };
  class MockEventSource {
    static CLOSED = 2;
    readyState = 0;
    listeners = new Map();
    constructor(url) { this.url = url; eventSources.push(this); }
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
    emit(name, payload, raw = false) {
      this.listeners.get(name)?.({ data: raw ? payload : JSON.stringify(payload) });
    }
    close() { this.readyState = 2; }
  }
  vm.runInNewContext(controllerCode, {
    module,
    exports: module.exports,
    Error,
    URLSearchParams,
    EventSource: MockEventSource,
    window: { addEventListener() {}, removeEventListener() {}, scrollTo() {} },
    require(name) {
      if (name === "./state") return statePort;
      if (name === "./format") return { fileEndpoint: (courseId, filePath) => `${courseId}:${filePath}` };
      if (name === "./api") return {
        api(url, options) {
          const request = { ...deferred(), url, options };
          requests.push(request);
          return request.promise;
        },
        async requestText(url) {
          const request = { ...deferred(), url };
          previews.push(request);
          const response = await request.promise;
          if (!response.ok) throw new Error(`Unable to read file: HTTP ${response.status}`);
          return response.text();
        },
      };
      throw new Error(`Unexpected controller dependency: ${name}`);
    },
    fetch(url) {
      const request = { ...deferred(), url };
      previews.push(request);
      return request.promise;
    },
  });
  return { controller: module.exports, state, requests, previews, eventSources, toasts, navigations };
}

function filePage(name) {
  return { total: 1, offset: 0, limit: 250, files: [{ name }] };
}

function textResponse(text) {
  return { ok: true, text: async () => text };
}

const settleMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("inventory refresh removes stale fetch selections while retaining current memberships", async () => {
  const { controller, state, requests } = harness();
  state.selectedCourses = new Set(["active", "archived", "expired", "removed"]);
  const loading = controller.refreshBootstrap();
  requests[0].resolve({ inventory: { courses: [
    { id: "active", membershipPresent: true },
    { id: "archived", archiveOnly: true },
    { id: "expired", membershipPresent: false },
  ] } });
  await loading;
  assert.deepEqual([...state.selectedCourses], ["active"]);
});

test("an invalid workspace response preserves the current bootstrap and cached course", async () => {
  for (const payload of [null, "unexpected response", {}, { inventory: { courses: null } }]) {
    const { controller, state, requests } = harness();
    const original = state.bootstrap;
    const cached = state.courseCache.get("c");
    const refresh = controller.refreshBootstrap();
    requests[0].resolve(payload);
    await assert.rejects(refresh, /invalid workspace response.*local dashboard server/i);
    assert.equal(state.bootstrap, original);
    assert.equal(state.courseCache.get("c"), cached);
  }
});

for (const scenario of [
  { name: "query", change: (controller) => controller.setFileFilters({ query: "second" }), parameter: "q", expected: "second" },
  { name: "course", change: (controller) => controller.setFileFilters({ courseId: "other-course" }), parameter: "courseId", expected: "other-course" },
  { name: "scope", change: (controller) => controller.setFileFilters({ scope: "exports" }), parameter: "scope", expected: "exports" },
  { name: "file type", change: (controller) => controller.setFileFilters({ preview: "pdf" }), parameter: "preview", expected: "pdf" },
  { name: "page", change: (_controller, state) => { state.filePage = 1; state.allFiles = null; }, parameter: "offset", expected: "250" },
]) {
  test(`file list fetches the latest ${scenario.name} after an in-flight selection change`, async () => {
    const { controller, state, requests } = harness();
    const loading = controller.loadAllFiles();
    scenario.change(controller, state);
    await controller.loadAllFiles();
    assert.equal(requests.length, 1);

    requests[0].resolve(filePage("stale-file"));
    await settleMicrotasks();
    assert.equal(state.allFiles, null);
    assert.equal(state.filesLoading, true);
    assert.equal(requests.length, 2);
    assert.equal(new URL(requests[1].url, "http://localhost").searchParams.get(scenario.parameter), scenario.expected);

    const latest = filePage("current-file");
    requests[1].resolve(latest);
    await loading;
    assert.equal(state.allFiles, latest);
    assert.equal(state.filesLoading, false);
  });
}

test("an old filter request failure still loads the new selection", async () => {
  const { controller, state, requests } = harness();
  const loading = controller.loadAllFiles();
  controller.setFileFilters({ query: "second" });
  requests[0].reject(new Error("Old request failed"));
  await settleMicrotasks();
  assert.equal(requests.length, 2);
  const latest = filePage("current-file");
  requests[1].resolve(latest);
  await loading;
  assert.equal(state.allFiles, latest);
  assert.equal(state.filesLoading, false);
});

test("a current file list failure is reported and clears loading", async () => {
  const { controller, state, requests } = harness();
  const loading = controller.loadAllFiles();
  requests[0].reject(new Error("Current request failed"));
  await assert.rejects(loading, /Current request failed/);
  assert.equal(state.filesLoading, false);
  assert.match(state.filesError, /Current request failed/);
});

for (const oldOutcome of ["success", "failure"]) {
  for (const oldFirst of [true, false]) {
    test(`a forced file load supersedes an older ${oldOutcome} completing ${oldFirst ? "first" : "last"}`, async () => {
      const { controller, state, requests } = harness();
      const older = controller.loadAllFiles();
      const newer = controller.loadAllFiles(true);
      const latest = filePage("current-file");
      const settleOlder = () => oldOutcome === "success"
        ? requests[0].resolve(filePage("stale-file"))
        : requests[0].reject(new Error("Old request failed"));
      if (oldFirst) {
        settleOlder();
        await older;
        assert.equal(state.allFiles, null);
        assert.equal(state.filesLoading, true);
        requests[1].resolve(latest);
        await newer;
      } else {
        requests[1].resolve(latest);
        await newer;
        settleOlder();
        await older;
      }
      assert.equal(state.allFiles, latest);
      assert.equal(state.filesLoading, false);
    });
  }
}

for (const oldOutcome of ["success", "failure"]) {
  for (const oldFirst of [true, false]) {
    test(`opening file B ignores file A's ${oldOutcome} completing ${oldFirst ? "first" : "last"}`, async () => {
      const { controller, state, previews } = harness();
      const older = controller.openFile("c", "a.txt");
      const newer = controller.openFile("c", "b.txt");
      const settleOlder = () => oldOutcome === "success"
        ? previews[0].resolve(textResponse("A contents"))
        : previews[0].reject(new Error("A preview failed"));
      if (oldFirst) {
        settleOlder();
        await older;
        assert.equal(state.fileDialog.loading, true);
        assert.equal(state.fileDialog.error, "");
        assert.equal(state.fileDialog.text, "");
        previews[1].resolve(textResponse("B contents"));
        await newer;
      } else {
        previews[1].resolve(textResponse("B contents"));
        await newer;
        settleOlder();
        await older;
      }
      assert.equal(state.fileDialog.file.name, "b.txt");
      assert.equal(state.fileDialog.text, "B contents");
      assert.equal(state.fileDialog.error, "");
      assert.equal(state.fileDialog.loading, false);
    });
  }
}

for (const oldOutcome of ["success", "failure"]) {
  test(`an old preview body ${oldOutcome} cannot change a later dialog`, async () => {
    const { controller, state, previews } = harness();
    const body = deferred();
    const older = controller.openFile("c", "a.txt");
    previews[0].resolve({ ok: true, text: () => body.promise });
    await settleMicrotasks();
    const newer = controller.openFile("c", "b.txt");
    previews[1].resolve(textResponse("B contents"));
    await newer;
    if (oldOutcome === "success") body.resolve("A contents");
    else body.reject(new Error("A body failed"));
    await older;
    assert.equal(state.fileDialog.file.name, "b.txt");
    assert.equal(state.fileDialog.text, "B contents");
    assert.equal(state.fileDialog.error, "");
  });
}

test("reopening the same file ignores its previous preview response", async () => {
  const { controller, state, previews } = harness();
  const older = controller.openFile("c", "a.txt");
  state.fileDialog.open = false;
  const newer = controller.openFile("c", "a.txt");
  previews[1].resolve(textResponse("Latest contents"));
  await newer;
  previews[0].resolve(textResponse("Earlier contents"));
  await older;
  assert.equal(state.fileDialog.text, "Latest contents");
});

test("switching to a PDF ignores a previous text preview response", async () => {
  const { controller, state, previews } = harness();
  const older = controller.openFile("c", "a.txt");
  await controller.openFile("c", "b.pdf");
  previews[0].resolve(textResponse("A contents"));
  await older;
  assert.equal(state.fileDialog.file.name, "b.pdf");
  assert.equal(state.fileDialog.text, "");
  assert.equal(state.fileDialog.loading, false);
});

test("a current preview HTTP failure remains visible", async () => {
  const { controller, state, previews } = harness();
  const loading = controller.openFile("c", "a.txt");
  previews[0].resolve({ ok: false, status: 404 });
  await loading;
  assert.match(state.fileDialog.error, /HTTP 404/);
  assert.equal(state.fileDialog.loading, false);
});

test("a history file outside the main index can supply matching preview metadata", async () => {
  const { controller, state, previews } = harness();
  const filePath = ".fetch-history/run/files/manifest.json";
  const metadata = { path: filePath, name: "manifest.json", preview: "json" };
  const preview = controller.openFile("c", filePath, metadata);
  assert.equal(previews[0].url, `c:${filePath}`);
  previews[0].resolve(textResponse('{"version":"original"}'));
  await preview;
  assert.equal(state.fileDialog.file, metadata);
  assert.equal(state.fileDialog.parsed.version, "original");
});

test("preview metadata for a different path is ignored", async () => {
  const { controller, state, previews } = harness();
  await controller.openFile("c", "unknown.bin", { path: "other.json", name: "other.json", preview: "json" });
  assert.equal(previews.length, 0);
  assert.equal(state.fileDialog.file.path, "unknown.bin");
  assert.equal(state.fileDialog.file.preview, "download");
});

test("a fetch POST response does not duplicate or replace an earlier SSE batch", async () => {
  const { controller, state, requests } = harness();
  const starting = controller.startFetch({ downloadMode: "full" });
  const liveBatch = { id: "batch", status: "running" };
  state.bootstrap.jobs = [liveBatch];
  requests[0].resolve({ id: "batch", status: "queued" });
  await starting;
  assert.equal(state.bootstrap.jobs.length, 1);
  assert.equal(state.bootstrap.jobs[0], liveBatch);
  assert.equal(state.selectedCourses.size, 0);
  assert.equal(state.fetchOpen, false);
});

test("concurrent course reads share one request", async () => {
  const { controller, state, requests } = harness();
  state.courseCache.clear();
  const first = controller.ensureCourse("c");
  const second = controller.ensureCourse("c");
  assert.equal(requests.length, 1);
  const detail = { course: { id: "c", name: "Latest" } };
  requests[0].resolve(detail);
  assert.equal(await first, detail);
  assert.equal(await second, detail);
  assert.equal(state.courseCache.get("c"), detail);
});

for (const outcome of ["success", "failure"]) {
  test(`forced course refresh supersedes an older ${outcome} for all callers`, async () => {
    const { controller, state, requests } = harness();
    state.courseCache.clear();
    const older = controller.ensureCourse("c");
    const newer = controller.ensureCourse("c", true);
    if (outcome === "success") requests[0].resolve({ course: { id: "c", name: "Stale" } });
    else requests[0].reject(new Error("Stale course error"));
    await settleMicrotasks();
    assert.equal(state.courseCache.has("c"), false);
    const detail = { course: { id: "c", name: "Latest" } };
    requests[1].resolve(detail);
    assert.equal(await newer, detail);
    assert.equal(await older, detail);
    assert.equal(state.courseCache.get("c"), detail);
    assert.equal(requests.length, 2);
  });
}

test("archive refresh invalidates a course request that started before it", async () => {
  const { controller, state, requests } = harness();
  state.courseCache.clear();
  const course = controller.ensureCourse("c");
  const refresh = controller.refreshBootstrap();
  requests[1].resolve({ inventory: { courses: [] } });
  await refresh;
  requests[0].resolve({ course: { id: "c", name: "Stale" } });
  await settleMicrotasks();
  assert.equal(state.courseCache.has("c"), false);
  assert.equal(requests.length, 3);
  const latest = { course: { id: "c", name: "Latest" } };
  requests[2].resolve(latest);
  assert.equal(await course, latest);
});

test("superseded forced refresh waits for the newest request even with a cached course", async () => {
  const { controller, requests } = harness();
  const older = controller.ensureCourse("c", true);
  const newer = controller.ensureCourse("c", true);
  requests[0].resolve({ course: { id: "c", name: "Stale" } });
  await settleMicrotasks();
  const latest = { course: { id: "c", name: "Current" } };
  requests[1].resolve(latest);
  assert.equal(await older, latest);
  assert.equal(await newer, latest);
});

test("a stale search failure does not clear a newer search or report an error", async () => {
  const { controller, state, requests } = harness();
  const older = controller.searchArchive("first");
  const newer = controller.searchArchive("second");
  requests[0].reject(new Error("Stale search failed"));
  await older;
  assert.equal(state.searchLoading, true);
  requests[1].resolve({ results: [{ title: "Current result" }] });
  await newer;
  assert.equal(state.searchResults[0].title, "Current result");
  assert.equal(state.searchLoading, false);
});

test("repeating a search query does not revive its earlier result", async () => {
  const { controller, state, requests } = harness();
  const older = controller.searchArchive("same");
  await controller.searchArchive("");
  const newer = controller.searchArchive("same");
  requests[1].resolve({ results: [{ title: "Current result" }] });
  await newer;
  requests[0].resolve({ results: [{ title: "Stale result" }] });
  await older;
  assert.equal(state.searchResults[0].title, "Current result");
});

test("a current search error still clears loading and is reported", async () => {
  const { controller, state, requests } = harness();
  const loading = controller.searchArchive("current");
  requests[0].reject(new Error("Current search failed"));
  await assert.rejects(loading, /Current search failed/);
  assert.equal(state.searchLoading, false);
});

for (const outcome of ["success", "failure"]) {
  test(`a stale bootstrap ${outcome} cannot replace a newer refresh`, async () => {
    const { controller, state, requests } = harness();
    const older = controller.refreshBootstrap();
    const newer = controller.refreshBootstrap();
    const latest = { inventory: { courses: [] }, summary: { marker: "current" } };
    requests[1].resolve(latest);
    await newer;
    if (outcome === "success") requests[0].resolve({ inventory: { courses: [] }, summary: { marker: "old" } });
    else requests[0].reject(new Error("Old bootstrap failed"));
    await older;
    assert.equal(state.bootstrap, latest);
  });
}

function bootstrap() {
  return {
    auth: { exists: false }, settings: {}, inventory: { courses: [] }, summary: { marker: "initial" }, jobs: [],
  };
}

async function connectedHarness() {
  const result = harness();
  const initializing = result.controller.initialize();
  result.requests[0].resolve(bootstrap());
  const dispose = await initializing;
  return { ...result, dispose, source: result.eventSources[0] };
}

test("refreshing after initial server failure recovers the event connection", async () => {
  const { controller, state, requests, eventSources } = harness();
  const initializing = controller.initialize();
  requests[0].reject(new Error("Server unavailable"));
  const dispose = await initializing;
  assert.equal(state.connectionStatus, "offline");
  assert.equal(eventSources.length, 0);
  const retry = controller.refreshBootstrap();
  requests[1].resolve(bootstrap());
  await retry;
  assert.equal(state.fatalError, "");
  assert.equal(state.connectionStatus, "connecting");
  assert.equal(eventSources.length, 1);
  dispose();
});

test("SSE reconnect catches up missed updates without overwriting newer live events", async () => {
  const { state, requests, source, dispose } = await connectedHarness();
  source.readyState = 1;
  source.emit("open");
  assert.equal(state.connectionStatus, "connected");
  assert.equal(requests[1].url, "/api/bootstrap");
  requests[1].resolve(bootstrap());
  await settleMicrotasks();
  source.readyState = 0;
  source.emit("error");
  assert.equal(state.connectionStatus, "reconnecting");
  source.readyState = 1;
  source.emit("open");
  const liveJobs = [{ id: "job", status: "running" }];
  source.emit("jobs", liveJobs);
  source.emit("summary", { marker: "live" });
  await settleMicrotasks();
  requests[2].resolve({ ...bootstrap(), summary: { marker: "stale" }, inventory: { courses: [{ id: "recovered-course" }] } });
  await settleMicrotasks();
  assert.equal(state.bootstrap.jobs[0].status, "running");
  assert.equal(state.bootstrap.summary.marker, "live");
  assert.equal(state.bootstrap.inventory.courses[0].id, "recovered-course");
  dispose();
  source.emit("summary", { marker: "disposed" });
  await settleMicrotasks();
  assert.equal(state.bootstrap.summary.marker, "live");
});

test("malformed SSE payloads are contained and reconnect refresh failures are visible", async () => {
  const { state, requests, source, toasts, dispose } = await connectedHarness();
  source.emit("summary", "{invalid-json", true);
  source.emit("jobs", { invalid: "shape" });
  source.emit("inventory", null);
  assert.equal(state.bootstrap.summary.marker, "initial");
  assert.equal(state.bootstrap.jobs.length, 0);
  assert.equal(state.bootstrap.inventory.courses.length, 0);
  assert.match(toasts[0][0], /could not be read/);
  source.emit("open");
  requests[1].reject(new Error("Refresh failed"));
  await settleMicrotasks();
  assert.equal(toasts.at(-1)[0], "Refresh failed");
  assert.equal(state.connectionStatus, "connected");
  source.readyState = 2;
  source.emit("error");
  assert.equal(state.connectionStatus, "offline");
  dispose();
});

test("inventory events apply immediately and older summary requests cannot overwrite the latest summary", async () => {
  const { state, requests, source, dispose } = await connectedHarness();
  source.emit("inventory", { courses: [{ id: "first" }] });
  await settleMicrotasks();
  assert.equal(state.bootstrap.inventory.courses[0].id, "first");
  source.emit("inventory", { courses: [{ id: "second" }] });
  await settleMicrotasks();
  requests[2].resolve({ marker: "second" });
  await settleMicrotasks();
  requests[1].resolve({ marker: "first" });
  await settleMicrotasks();
  assert.equal(state.bootstrap.inventory.courses[0].id, "second");
  assert.equal(state.bootstrap.summary.marker, "second");
  dispose();
});

test("file errors reset on filter change or an explicit retry", async () => {
  const { controller, state, requests } = harness();
  state.filesError = "Previous error";
  controller.setFileFilters({ query: "changed" });
  assert.equal(state.filesError, "");
  state.filesError = "Retryable error";
  const retry = controller.loadAllFiles(true);
  assert.equal(state.filesError, "");
  requests[0].resolve(filePage("recovered-file"));
  await retry;
  assert.equal(state.allFiles.files[0].name, "recovered-file");
});

function dialogCourse(id) {
  return {
    course: { id, code: id, name: `Course ${id}` },
    assessments: [{ contentId: "assessment", title: `Assignment ${id}`, directory: "assessment" }],
    announcements: [{ id: "announcement", title: `Announcement ${id}`, createdDate: "2026-01-01" }],
    files: [],
  };
}

for (const olderKind of ["assignment", "announcement"]) {
  for (const outcome of ["success", "failure"]) {
    test(`a slow ${olderKind} ${outcome} cannot replace a newer detail dialog`, async () => {
      const { controller, state, requests } = harness();
      const older = olderKind === "assignment"
        ? controller.openAssignment("older", "assessment")
        : controller.openAnnouncement("older", "announcement");
      const newer = olderKind === "assignment"
        ? controller.openAnnouncement("newer", "announcement")
        : controller.openAssignment("newer", "assessment");
      requests[1].resolve(dialogCourse("newer"));
      await newer;
      const latest = state.detailDialog;
      if (outcome === "success") requests[0].resolve(dialogCourse("older"));
      else requests[0].reject(new Error("Old course request failed"));
      await older;
      assert.equal(state.detailDialog, latest);
      assert.equal(state.detailDialog.courseDetail.course.id, "newer");
    });
  }
}

for (const action of ["close", "navigate", "route-change"]) {
  test(`${action} prevents a pending assignment from reopening its dialog`, async () => {
    const { controller, state, requests } = harness();
    const pending = controller.openAssignment("pending", "assessment");
    if (action === "close") controller.closeDetails();
    else if (action === "navigate") controller.navigate("courses");
    else state.route = { page: "courses" };
    requests[0].resolve(dialogCourse("pending"));
    await pending;
    assert.equal(state.detailDialog.open, false);
  });
}

test("opening a file cancels a pending announcement", async () => {
  const { controller, state, requests } = harness();
  const pending = controller.openAnnouncement("pending", "announcement");
  await controller.openFile("c", "b.pdf");
  requests[0].resolve(dialogCourse("pending"));
  await pending;
  assert.equal(state.detailDialog.open, false);
  assert.equal(state.fileDialog.file.path, "b.pdf");
  assert.equal(state.fileDialog.open, true);
});

for (const outcome of ["success", "failure"]) {
  test(`reopening an assignment ignores its previous instructions ${outcome}`, async () => {
    const { controller, state, previews } = harness();
    const detail = dialogCourse("c");
    detail.files = [{ path: "assessment/instructions.txt", role: "instructions-search-text", preview: "text" }];
    state.courseCache.set("c", detail);
    await controller.openAssignment("c", "assessment");
    controller.closeDetails();
    await controller.openAssignment("c", "assessment");
    previews[1].resolve(textResponse("Current instructions"));
    await settleMicrotasks();
    if (outcome === "success") previews[0].resolve(textResponse("Old instructions"));
    else previews[0].reject(new Error("Old instruction load failed"));
    await settleMicrotasks();
    assert.equal(state.detailDialog.instructions, "Current instructions");
    assert.equal(state.detailDialog.open, true);
  });
}

test("a stale calendar item cannot navigate or replace a newer dialog", async () => {
  const { controller, state, requests, navigations } = harness();
  const pending = controller.openCalendarItem("pending", "Unmatched calendar item");
  controller.openSearch();
  requests[0].resolve(dialogCourse("pending"));
  await pending;
  assert.equal(navigations.length, 0);
  assert.equal(state.searchOpen, true);
  assert.equal(state.detailDialog.open, false);
});

test("a current calendar item still opens its matching assignment", async () => {
  const { controller, state, requests } = harness();
  const pending = controller.openCalendarItem("pending", "Assignment pending");
  requests[0].resolve(dialogCourse("pending"));
  await pending;
  assert.equal(state.detailDialog.kind, "assignment");
  assert.equal(state.detailDialog.title, "Assignment pending");
});
