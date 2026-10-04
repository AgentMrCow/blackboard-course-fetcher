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
  const state = {
    filesLoading: false,
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
    navigate: () => {},
    showToast: () => {},
    routeFromHash: () => ({}),
  };
  vm.runInNewContext(controllerCode, {
    module,
    exports: module.exports,
    Error,
    URLSearchParams,
    require(name) {
      if (name === "./state") return statePort;
      if (name === "./format") return { fileEndpoint: (courseId, filePath) => `${courseId}:${filePath}` };
      if (name === "./api") return {
        api(url, options) {
          const request = { ...deferred(), url, options };
          requests.push(request);
          return request.promise;
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
  return { controller: module.exports, state, requests, previews };
}

function filePage(name) {
  return { total: 1, offset: 0, limit: 250, files: [{ name }] };
}

function textResponse(text) {
  return { ok: true, text: async () => text };
}

const settleMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

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
