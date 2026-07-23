const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const { DashboardServer } = require("../dashboard/server");
const { validateState } = require("../src/adapters/blackboard/session-state");
const { SettingsRepository } = require("../src/adapters/filesystem/settings-repository");
const { readJsonBody } = require("../src/adapters/http/request-body");
const {
  createDashboardPaths,
  createDashboardRuntime,
  parseArguments,
  startDashboardServer,
} = require("../src/composition/dashboard-runtime");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".js") ? [absolute] : [];
  });
}

test("application modules remain independent from adapters and legacy dashboard code", () => {
  const applicationDirectory = path.join(PROJECT_ROOT, "src", "application");
  const files = javascriptFiles(applicationDirectory);
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(applicationDirectory, file);
    assert.doesNotMatch(source, /require\(["'][^"']*adapters\//, `${relative} imports an adapter`);
    assert.doesNotMatch(source, /require\(["'][^"']*dashboard\//, `${relative} imports legacy dashboard code`);
    assert.doesNotMatch(source, /require\(["'](?:fs|http|https|child_process|playwright)["']\)/, `${relative} imports infrastructure`);
  }
});

test("domain modules contain no application or infrastructure dependencies", () => {
  const domainDirectory = path.join(PROJECT_ROOT, "src", "domain");
  const files = javascriptFiles(domainDirectory);
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(domainDirectory, file);
    assert.doesNotMatch(source, /require\(["'][^"']*(?:application|adapters|dashboard)\//, `${relative} has an outward dependency`);
    assert.doesNotMatch(source, /require\(["'](?:fs|path|http|https|events|child_process|playwright)["']\)/, `${relative} imports infrastructure`);
  }
});

test("fetch-all binary remains a narrow composition entry point", () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "bin", "fetch-blackboard-all.js"), "utf8");
  assert.match(source, /runFetchAllCli/);
  assert.doesNotMatch(source, /require\(["'](?:fs|path|child_process)["']\)/);
  assert.ok(source.trim().split("\n").length <= 10);
});

test("single-course binary remains a narrow composition entry point", () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "bin", "fetch-blackboard-course.js"), "utf8");
  assert.match(source, /src\/composition\/course-fetch-runtime/);
  assert.doesNotMatch(source, /require\(["'](?:fs|path|child_process)["']\)/);
  assert.ok(source.trim().split("\n").length <= 5);
});

test("single-course engine delegates stable initialization contracts", () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "composition", "course-fetch-runtime.js"), "utf8");
  assert.match(source, /parseCourseFetchArguments/);
  assert.match(source, /validateCourseFetchInput/);
  assert.match(source, /createCourseFetchManifest/);
  assert.match(source, /recordManifestArtifact/);
  assert.match(source, /CourseFetchProgressReporter/);
  assert.match(source, /createBlackboardRestClient/);
  assert.match(source, /createCourseFileStore/);
  assert.match(source, /CourseFileTransferService/);
  assert.match(source, /AttachmentUrlRecoveryService/);
  assert.match(source, /BlackboardContentAttachmentGateway/);
  assert.match(source, /BlackboardAttachmentHtmlGateway/);
  assert.match(source, /BlackboardLtiH5pGateway/);
  assert.match(source, /PlaywrightAttachmentResourceGateway/);
  assert.match(source, /PlaywrightQuizReviewGateway/);
  assert.match(source, /PlaywrightFeedbackDownloadGateway/);
  assert.match(source, /PlaywrightClassicSubmissionGateway/);
  assert.match(source, /PlaywrightBlackboardExtrasGateway/);
  assert.doesNotMatch(source, /function parseArguments/);
  assert.doesNotMatch(source, /async function (?:bbJson|fetchWithRetry|getAllPages)/);
  assert.doesNotMatch(source, /function (?:cookieHeaderFor|retryDelay)/);
  assert.doesNotMatch(
    source,
    /function (?:checkReportedSize|findIdenticalFileByHash|previousLocalPath|sha256File|writeDownloadPlaceholder|writeUnresolvedDownload)/
  );
  assert.doesNotMatch(source, /If-None-Match|\.placeholder\.json/);
  assert.doesNotMatch(source, /function (?:resolveAttachmentFallback|uiPageLabel|loadPlaywright|findChromiumExecutable)/);
  assert.doesNotMatch(source, /attachment resolver|No Blackboard xid|Blackboard owner URL rule/);
  assert.doesNotMatch(source, /querySelectorAll\(["']\*["']\)/);
  assert.doesNotMatch(source, /launchChromium|loadPlaywright|findChromiumExecutable|\.newContext\(|page\.(?:goto|getByRole|locator|waitForEvent|waitForSelector)/);
  assert.doesNotMatch(source, /Feedback for attempt|More options for|\/webapps\/assignment\/download\?/);
  assert.doesNotMatch(source, /schemaVersion:\s*8/);
  assert.doesNotMatch(source, /@@BB_PROGRESS@@/);
});

test("Blackboard Extras delegates all browser automation to its gateway", () => {
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "composition", "blackboard-extra-archive.js"),
    "utf8"
  );
  assert.match(source, /uiDataGateway\.collect/);
  assert.doesNotMatch(source, /loadPlaywright|findChromiumExecutable|launchChromium/);
  assert.doesNotMatch(source, /\.newContext\(|\.newPage\(|page\.(?:goto|on|waitForResponse)/);
});

test("archive workers preserve raw Blackboard payloads and diagnostics", () => {
  const courseSource = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "composition", "course-fetch-runtime.js"),
    "utf8"
  );
  const extraSource = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "composition", "blackboard-extra-archive.js"),
    "utf8"
  );
  const legacySource = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "adapters", "blackboard", "blackboard-legacy-quiz.js"),
    "utf8"
  );
  const transferSource = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "application", "course-fetch", "course-file-transfer-service.js"),
    "utf8"
  );
  const authWorkerSource = fs.readFileSync(path.join(PROJECT_ROOT, "dashboard", "auth-worker.js"), "utf8");
  const archiveSources = [courseSource, extraSource, legacySource, transferSource].join("\n");

  assert.doesNotMatch(
    archiveSources,
    /redactSensitiveUrl|redactSourceUrl|redactSecrets|redactUrl|sanitizeSecrets|sanitizeQuizApiValue|\[REDACTED\]/
  );
  assert.match(courseSource, /quiz_review\.raw\.html/);
  assert.match(courseSource, /assessment: tool\.assessment/);
  assert.match(courseSource, /questionAttempts: tool\.questionAttempts/);
  assert.match(transferSource, /const sourceUrl = file\.sourceUrl/);
  assert.match(transferSource, /sourceUrl,\s+url,/);
  assert.match(transferSource, /finalUrl/);
  assert.match(extraSource, /documentResponse/);
  assert.match(extraSource, /apiResponses/);
  assert.doesNotMatch(authWorkerSource, /chmodSync\(stateFile/);
});

test("legacy fetch modules do not return to the project root", () => {
  const oldRootFiles = [
    "blackboard-archive-layout.js",
    "blackboard-course-fetcher.js",
    "blackboard-download-stream.js",
    "blackboard-extra-archive.js",
    "blackboard-legacy-quiz.js",
    "fetch-blackboard-all.js",
    "fetch-blackboard-course.js",
  ];
  assert.deepEqual(
    oldRootFiles.filter((file) => fs.existsSync(path.join(PROJECT_ROOT, file))),
    []
  );
});

test("course discovery and course fetch share one Blackboard REST adapter", () => {
  const gatewaySource = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "adapters", "blackboard", "blackboard-course-membership-gateway.js"),
    "utf8"
  );
  assert.match(gatewaySource, /require\("\.\/blackboard-rest-client"\)/);
  assert.doesNotMatch(gatewaySource, /new Set\(\[408|for \(let attempt/);
});

test("dashboard HTTP dispatch remains in focused transport controllers", () => {
  const serverSource = fs.readFileSync(path.join(PROJECT_ROOT, "dashboard", "server.js"), "utf8");
  assert.match(serverSource, /return this\.router\.route\(request, response\)/);
  assert.doesNotMatch(serverSource, /pathname\.match|pathname === ["']\/api\//);
  const controllerDirectory = path.join(PROJECT_ROOT, "src", "adapters", "http", "dashboard");
  const controllers = fs.readdirSync(controllerDirectory).filter((file) => file.endsWith("-controller.js"));
  assert.deepEqual(controllers.sort(), [
    "archive-controller.js",
    "fetch-controller.js",
    "static-controller.js",
    "workspace-controller.js",
  ]);
});

test("dashboard construction has one composition-owned dependency path", () => {
  const serverSource = fs.readFileSync(path.join(PROJECT_ROOT, "dashboard", "server.js"), "utf8");
  assert.doesNotMatch(serverSource, /\bSettingsRepository\b|new ArchiveService|new JobManager|DEFAULT_PATHS/);
  assert.doesNotMatch(serverSource, /require\(["']\.\/(?:archive-service|job-manager)["']\)/);
  assert.doesNotMatch(serverSource, /require\(["'][^"']*src\/(?:adapters|application)\//);
  assert.doesNotMatch(serverSource, /sseClients|addEventClient|removeEventClient|new Set/);
  assert.throws(
    () => new DashboardServer({ archiveRoot: "/archive" }),
    /requires paths/
  );
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, "dashboard", "archive-service.js")), false);
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, "dashboard", "job-manager.js")), false);
});

test("settings repository loads archive defaults and persists overrides", (context) => {
  const root = temporaryDirectory(context, "blackboard-settings-");
  const archiveRoot = path.join(root, "Blackboard_Archive");
  const settingsFile = path.join(root, ".dashboard-data", "settings.json");
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, "courses.json"), JSON.stringify({ blackboardBase: "https://archive.example.edu" }));
  const repository = new SettingsRepository({ scriptDirectory: root, settingsFile, environment: {} });

  assert.equal(repository.load().blackboardBase, "https://archive.example.edu");
  repository.save({ ...repository.load(), downloadMode: "full", courseConcurrency: 2 });
  assert.equal(repository.load().downloadMode, "full");
  assert.equal(repository.load().courseConcurrency, 2);
});

test("session validation sends only cookies that match the Blackboard URL", async (context) => {
  const root = temporaryDirectory(context, "blackboard-state-");
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    cookies: [
      { name: "session", value: "expected", domain: ".example.edu", path: "/learn" },
      { name: "wrongDomain", value: "private", domain: ".invalid.example", path: "/" },
      { name: "wrongPath", value: "private", domain: ".example.edu", path: "/webapps" },
    ],
  }));
  let request;
  const result = await validateState(
    { blackboardBase: "https://blackboard.example.edu", stateFile },
    {
      fetchImpl: async (url, options) => {
        request = { options, url: String(url) };
        return new Response(JSON.stringify({
          id: "_1_1",
          userName: "student",
          name: { given: "Test", family: "User" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }
  );

  assert.equal(result.valid, true);
  assert.equal(result.user.userName, "student");
  assert.equal(request.url, "https://blackboard.example.edu/learn/api/v1/users/me");
  assert.equal(request.options.headers.Cookie, "session=expected");
});

test("JSON request adapter rejects malformed and oversized bodies", async () => {
  assert.deepEqual(await readJsonBody(Readable.from(["{\"ok\":true}"])), { ok: true });
  await assert.rejects(() => readJsonBody(Readable.from(["not-json"])), (error) => error.statusCode === 400);
  await assert.rejects(() => readJsonBody(Readable.from(["12345"]), { maxBytes: 4 }), (error) => error.statusCode === 413);
});

test("composition root owns paths, settings, and HTTP runtime construction", (context) => {
  const root = temporaryDirectory(context, "blackboard-runtime-");
  const paths = createDashboardPaths(root);
  let receivedDependencies;
  const runtime = createDashboardRuntime({
    environment: { BB_BASE: "https://runtime.example.edu" },
    paths,
    dashboardFactory(settings, dependencies) {
      receivedDependencies = dependencies;
      return { route: async () => {}, settings, shutdown() {} };
    },
  });

  assert.equal(runtime.dashboard.settings.blackboardBase, "https://runtime.example.edu");
  assert.equal(receivedDependencies.paths.scriptDirectory, root);
  assert.equal(typeof receivedDependencies.createAuthenticationCoordinator, "function");
  assert.equal(typeof receivedDependencies.createArchiveService, "function");
  assert.equal(typeof receivedDependencies.createDashboardRouter, "function");
  assert.equal(typeof receivedDependencies.createFetchCommandService, "function");
  assert.equal(typeof receivedDependencies.createFileIndexCoordinator, "function");
  assert.equal(typeof receivedDependencies.createInventoryCoordinator, "function");
  assert.equal(typeof receivedDependencies.createJobManager, "function");
  assert.equal(typeof receivedDependencies.createSettingsCommandService, "function");
  assert.equal(typeof receivedDependencies.eventHub.publish, "function");
  assert.equal(typeof receivedDependencies.systemStatus, "function");
  assert.equal(receivedDependencies.settingsRepository, runtime.settingsRepository);
  assert.equal(receivedDependencies.createArchiveService(path.join(root, "archive")).archiveRoot, path.join(root, "archive"));
  assert.equal(receivedDependencies.createJobManager({
    archiveService: { getInventory: () => ({ courses: [] }) },
  }).jobRepository, runtime.jobRepository);
  const authentication = receivedDependencies.createAuthenticationCoordinator({ settings: runtime.dashboard.settings });
  assert.equal(authentication.runner, runtime.authenticationRunner);
  assert.equal(authentication.sessionGateway, runtime.sessionGateway);
  const inventory = receivedDependencies.createInventoryCoordinator({
    archiveService: { getInventory: () => ({ courses: [] }), invalidate() {} },
    settings: runtime.dashboard.settings,
  });
  assert.equal(inventory.runner, runtime.inventoryRunner);
  assert.equal(inventory.sessionGateway, runtime.sessionGateway);
  const fileIndex = receivedDependencies.createFileIndexCoordinator({
    archiveService: { invalidate() {}, setFileIndex: () => true },
    settings: runtime.dashboard.settings,
  });
  assert.equal(fileIndex.cacheRepository, runtime.fileIndexCacheRepository);
  assert.equal(fileIndex.runner, runtime.fileIndexRunner);
  assert.equal(fileIndex.outputFile, paths.fileIndex);
  const runtimeServices = {
    authentication: { active: () => false, setSettings() {} },
    fileIndexCoordinator: { reconfigure() {} },
    inventoryCoordinator: { active: () => false, setArchiveService() {}, setSettings() {} },
    jobs: { activeBatch: () => null, createAndStart() {}, setArchiveService() {} },
  };
  const settingsCommands = receivedDependencies.createSettingsCommandService({
    ...runtimeServices,
    settings: runtime.dashboard.settings,
  });
  const fetchCommands = receivedDependencies.createFetchCommandService({
    jobs: runtimeServices.jobs,
    settings: runtime.dashboard.settings,
  });
  assert.equal(settingsCommands.settingsRepository, runtime.settingsRepository);
  assert.equal(fetchCommands.systemStatus, runtime.systemStatus);
  assert.equal(receivedDependencies.createDashboardRouter, runtime.createDashboardRouter);
  assert.equal(fs.existsSync(paths.dataDirectory), true);
  assert.equal(runtime.server.requestTimeout, 0);
});

test("dashboard CLI parsing and binding remain local-only", () => {
  assert.deepEqual(parseArguments(["--host=localhost", "--port", "4180", "--flag"]), {
    host: "localhost",
    port: "4180",
    flag: true,
  });
  assert.throws(() => startDashboardServer(["--host", "0.0.0.0"]), /must bind to a loopback host/);
});
