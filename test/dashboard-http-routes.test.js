const path = require("path");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ArchiveHttpController } = require("../src/adapters/http/dashboard/archive-controller");
const { DashboardRouter } = require("../src/adapters/http/dashboard/dashboard-router");
const { FetchHttpController } = require("../src/adapters/http/dashboard/fetch-controller");
const { StaticHttpController } = require("../src/adapters/http/dashboard/static-controller");
const { WorkspaceHttpController } = require("../src/adapters/http/dashboard/workspace-controller");
const { SseClientHub } = require("../src/adapters/http/sse-client-hub");

class ResponseCapture {
  constructor() {
    this.body = "";
    this.headers = {};
    this.statusCode = null;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.body += String(chunk);
  }

  end(chunk = "") {
    this.body += String(chunk);
  }

  json() {
    return JSON.parse(this.body);
  }
}

function request(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    host: "127.0.0.1:4173",
    origin: "http://127.0.0.1:4173",
    "sec-fetch-site": "same-origin",
  };
  return stream;
}

function context(method, relativeUrl, body) {
  const url = new URL(relativeUrl, "http://localhost");
  return {
    pathname: decodeURIComponent(url.pathname),
    request: request(method, relativeUrl, body),
    response: new ResponseCapture(),
    url,
  };
}

test("workspace controller maps session, settings, inventory, health, and SSE routes", async () => {
  const calls = [];
  const workspace = {
    bootstrap: async (options) => { calls.push(["bootstrap", options]); return { view: "bootstrap" }; },
    cancelAuth: () => ({ operation: "cancelAuth" }),
    cancelInventory: () => ({ operation: "cancelInventory" }),
    checkAuthentication: async () => ({ operation: "checkAuthentication" }),
    saveAuth: () => ({ operation: "saveAuth" }),
    saveSettings: (settings) => { calls.push(["saveSettings", settings]); return settings; },
    startAuth: () => ({ operation: "startAuth" }),
    startInventory: () => ({ operation: "startInventory" }),
  };
  const controller = new WorkspaceHttpController({
    clock: () => new Date("2026-07-23T00:00:00.000Z"),
    eventHub: new SseClientHub({ clock: () => new Date("2026-07-23T00:00:00.000Z") }),
    workspace,
  });

  const bootstrap = context("GET", "/api/bootstrap?refresh=1");
  assert.equal(await controller.handle(bootstrap), true);
  assert.equal(bootstrap.response.statusCode, 200);
  assert.deepEqual(bootstrap.response.json(), { view: "bootstrap" });
  assert.deepEqual(calls[0], ["bootstrap", { refresh: true }]);

  const settings = context("POST", "/api/settings", { downloadMode: "full" });
  await controller.handle(settings);
  assert.equal(settings.response.statusCode, 200);
  assert.deepEqual(calls[1], ["saveSettings", { downloadMode: "full" }]);

  const endpoints = [
    ["POST", "/api/auth/check", 200, "checkAuthentication"],
    ["POST", "/api/auth/start", 202, "startAuth"],
    ["POST", "/api/auth/save", 202, "saveAuth"],
    ["POST", "/api/auth/cancel", 200, "cancelAuth"],
    ["POST", "/api/inventory", 202, "startInventory"],
    ["POST", "/api/inventory/cancel", 200, "cancelInventory"],
  ];
  for (const [method, url, statusCode, operation] of endpoints) {
    const route = context(method, url);
    assert.equal(await controller.handle(route), true);
    assert.equal(route.response.statusCode, statusCode);
    assert.equal(route.response.json().operation, operation);
  }

  const health = context("GET", "/api/health");
  await controller.handle(health);
  assert.deepEqual(health.response.json(), { ok: true, at: "2026-07-23T00:00:00.000Z" });

  const eventRequest = new EventEmitter();
  eventRequest.method = "GET";
  const eventResponse = new ResponseCapture();
  assert.equal(await controller.handle({ pathname: "/api/events", request: eventRequest, response: eventResponse, url: new URL("http://localhost/api/events") }), true);
  assert.equal(eventResponse.statusCode, 200);
  assert.match(eventResponse.body, /event: connected/);
  eventRequest.emit("close");
});

test("archive controller maps filters, course details, and streamed file responses", async () => {
  const calls = [];
  const workspace = {
    archiveSummary: () => ({ files: 12 }),
    courseDetails: (courseId) => ({ id: courseId }),
    courseInventory: () => ({ courses: [{ id: "_1_1" }] }),
    listArchiveFiles: (options) => { calls.push(["files", options]); return { total: 1, files: [] }; },
    resolveArchiveFile: (courseId, file) => { calls.push(["resolve", courseId, file]); return { file: "/archive/notes.txt" }; },
    searchArchive: (query, options) => { calls.push(["search", query, options]); return [{ path: "notes.txt" }]; },
  };
  let streamed;
  const controller = new ArchiveHttpController({
    serveFile: (options) => { streamed = options; },
    workspace,
  });

  const search = context("GET", "/api/search?q=needle&courseId=_1_1&limit=7");
  await controller.handle(search);
  assert.deepEqual(search.response.json(), { results: [{ path: "notes.txt" }] });
  assert.deepEqual(calls[0], ["search", "needle", { courseId: "_1_1", limit: "7" }]);

  const files = context("GET", "/api/files?q=report&preview=pdf&scope=records&offset=10&limit=20");
  await controller.handle(files);
  assert.equal(files.response.statusCode, 200);
  assert.deepEqual(calls[1], ["files", { query: "report", preview: "pdf", scope: "records", courseId: null, offset: "10", limit: "20" }]);

  const details = context("GET", "/api/courses/_1_1");
  await controller.handle(details);
  assert.deepEqual(details.response.json(), { id: "_1_1" });

  const file = context("HEAD", "/api/courses/_1_1/file?path=notes.txt&download=1");
  await controller.handle(file);
  assert.deepEqual(calls.at(-1), ["resolve", "_1_1", "notes.txt"]);
  assert.equal(streamed.file, "/archive/notes.txt");
  assert.equal(streamed.download, true);
  assert.equal(streamed.request.method, "HEAD");
  assert.equal(streamed.mimeType("notes.txt"), "text/plain; charset=utf-8");
});

test("fetch controller maps job creation and batch or task controls", async () => {
  const calls = [];
  const workspace = {
    controlFetchBatch: (...args) => { calls.push(["batch", ...args]); return { status: "paused" }; },
    controlFetchTask: (...args) => { calls.push(["task", ...args]); return { status: "cancelled" }; },
    jobsSnapshot: () => [{ id: "batch" }],
    startFetch: (options) => { calls.push(["fetch", options]); return { id: "new" }; },
  };
  const controller = new FetchHttpController({ workspace });

  const jobs = context("GET", "/api/jobs");
  await controller.handle(jobs);
  assert.deepEqual(jobs.response.json(), { jobs: [{ id: "batch" }] });

  const fetch = context("POST", "/api/fetch", { courseIds: ["_1_1"], mode: "placeholder" });
  await controller.handle(fetch);
  assert.equal(fetch.response.statusCode, 202);
  assert.deepEqual(calls[0], ["fetch", { courseIds: ["_1_1"], mode: "placeholder" }]);

  const batch = context("POST", "/api/jobs/batch-1/pause");
  await controller.handle(batch);
  assert.deepEqual(calls[1], ["batch", "batch-1", "pause"]);

  const task = context("POST", "/api/jobs/batch-1/tasks/task-2/cancel");
  await controller.handle(task);
  assert.deepEqual(calls[2], ["task", "batch-1", "task-2", "cancel"]);
});

test("static controller serves built assets and the SPA fallback without path escape", async () => {
  const served = [];
  const paths = {
    publicDirectory: path.resolve("/project/dashboard/public"),
    scriptDirectory: path.resolve("/project"),
  };
  const controller = new StaticHttpController({
    paths,
    serveFile: (options) => served.push(options),
  });

  await controller.handle(context("GET", "/assets/app.js"));
  assert.equal(served[0].file, path.join(paths.publicDirectory, "assets/app.js"));
  assert.equal(served[0].cache, false);

  await controller.handle(context("GET", "/courses"));
  assert.equal(served[1].file, path.join(paths.publicDirectory, "index.html"));
  await assert.rejects(
    () => controller.handle({ ...context("GET", "/"), pathname: "/assets/../../private.txt" }),
    (error) => error.statusCode === 400
  );
});

test("dashboard router applies guards, preserves controller order, and rejects unmatched routes", async () => {
  const calls = [];
  const router = new DashboardRouter({
    controllers: [
      { handle: async () => { calls.push("first"); return false; } },
      { handle: async ({ pathname }) => { calls.push(pathname); return pathname === "/handled path"; } },
    ],
    hostGuard: () => calls.push("host"),
    mutationGuard: () => calls.push("origin"),
  });
  const handled = context("GET", "/handled%20path");
  await router.route(handled.request, handled.response);
  assert.deepEqual(calls, ["host", "origin", "first", "/handled path"]);

  const missing = context("DELETE", "/missing");
  await assert.rejects(() => router.route(missing.request, missing.response), (error) => error.statusCode === 404);
});
