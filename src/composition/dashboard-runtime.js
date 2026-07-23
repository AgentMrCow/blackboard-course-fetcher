const http = require("http");
const path = require("path");
const { DashboardServer } = require("../../dashboard/server");
const { AuthenticationCoordinator } = require("../application/authentication/authentication-coordinator");
const { FetchCommandService } = require("../application/fetch-jobs/fetch-command-service");
const { JobManager } = require("../application/fetch-jobs/job-manager");
const { FileIndexCoordinator } = require("../application/file-index/file-index-coordinator");
const { InventoryCoordinator } = require("../application/inventory/inventory-coordinator");
const { SettingsCommandService } = require("../application/settings/settings-command-service");
const { BlackboardSessionGateway } = require("../adapters/blackboard/blackboard-session-gateway");
const { FileIndexCacheRepository } = require("../adapters/filesystem/file-index-cache-repository");
const { ensureDirectory } = require("../adapters/filesystem/json-file-store");
const { JsonJobRepository } = require("../adapters/filesystem/json-job-repository");
const { SettingsRepository } = require("../adapters/filesystem/settings-repository");
const { sendError } = require("../adapters/http/responses");
const { isLoopbackHost } = require("../adapters/http/security");
const { SseClientHub } = require("../adapters/http/sse-client-hub");
const { NodeAuthenticationRunner } = require("../adapters/system/node-authentication-runner");
const { NodeFetchProcessRunner } = require("../adapters/system/node-fetch-process-runner");
const { NodeFileIndexRunner } = require("../adapters/system/node-file-index-runner");
const { NodeInventoryProcessRunner } = require("../adapters/system/node-inventory-process-runner");
const { systemStatus: readSystemStatus } = require("../adapters/system/local-runtime");
const { createFileSystemArchiveService } = require("./archive-service-factory");
const { createDashboardRouter: createDefaultDashboardRouter } = require("./dashboard-router-factory");

const PROJECT_ROOT = path.resolve(__dirname, "../..");

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const [key, inlineValue] = argument.slice(2).split("=", 2);
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

function createDashboardPaths(scriptDirectory = PROJECT_ROOT) {
  const root = path.resolve(scriptDirectory);
  const dashboardDirectory = path.join(root, "dashboard");
  const dataDirectory = path.join(root, ".dashboard-data");
  return {
    authProfile: path.join(dataDirectory, "login-profile"),
    dashboardDirectory,
    dataDirectory,
    fileIndex: path.join(dataDirectory, "file-index.json"),
    jobsFile: path.join(dataDirectory, "jobs.json"),
    publicDirectory: path.join(dashboardDirectory, "public"),
    scriptDirectory: root,
    settingsFile: path.join(dataDirectory, "settings.json"),
  };
}

function createDashboardRuntime({
  authenticationRunner,
  createAuthenticationCoordinator,
  createArchiveService,
  createDashboardRouter,
  createFetchCommandService,
  createFileIndexCoordinator,
  createInventoryCoordinator,
  createJobManager,
  createSettingsCommandService,
  dashboardFactory = (settings, dependencies) => new DashboardServer(settings, dependencies),
  ensureArchiveRoot,
  environment = process.env,
  eventHub,
  fileIndexCacheRepository,
  fileIndexRunner,
  inventoryRunner,
  jobRepository,
  paths = createDashboardPaths(),
  processRunner,
  sessionGateway,
  settings,
  systemStatus,
} = {}) {
  ensureDirectory(paths.dataDirectory);
  const settingsRepository = new SettingsRepository({
    scriptDirectory: paths.scriptDirectory,
    settingsFile: paths.settingsFile,
    environment,
  });
  const resolvedJobRepository = jobRepository || new JsonJobRepository({ file: paths.jobsFile });
  const resolvedProcessRunner = processRunner || new NodeFetchProcessRunner({
    environment,
    scriptDirectory: paths.scriptDirectory,
  });
  const resolvedCreateJobManager = createJobManager || (({ archiveService }) => new JobManager({
    archiveService,
    jobRepository: resolvedJobRepository,
    processRunner: resolvedProcessRunner,
  }));
  const resolvedCreateArchiveService = createArchiveService || createFileSystemArchiveService;
  const resolvedCreateDashboardRouter = createDashboardRouter || createDefaultDashboardRouter;
  const resolvedEventHub = eventHub || new SseClientHub();
  const resolvedFileIndexCacheRepository = fileIndexCacheRepository || new FileIndexCacheRepository({ file: paths.fileIndex });
  const resolvedSessionGateway = sessionGateway || new BlackboardSessionGateway();
  const resolvedAuthenticationRunner = authenticationRunner || new NodeAuthenticationRunner({
    dashboardDirectory: paths.dashboardDirectory,
    environment,
    scriptDirectory: paths.scriptDirectory,
  });
  const resolvedInventoryRunner = inventoryRunner || new NodeInventoryProcessRunner({
    environment,
    scriptDirectory: paths.scriptDirectory,
  });
  const resolvedFileIndexRunner = fileIndexRunner || new NodeFileIndexRunner({
    dashboardDirectory: paths.dashboardDirectory,
    environment,
    scriptDirectory: paths.scriptDirectory,
  });
  const resolvedCreateAuthenticationCoordinator = createAuthenticationCoordinator || (({ settings: coordinatorSettings }) => new AuthenticationCoordinator({
    profileDirectory: paths.authProfile,
    runner: resolvedAuthenticationRunner,
    sessionGateway: resolvedSessionGateway,
    settings: coordinatorSettings,
  }));
  const resolvedCreateInventoryCoordinator = createInventoryCoordinator || (({ archiveService, settings: coordinatorSettings }) => new InventoryCoordinator({
    archiveService,
    runner: resolvedInventoryRunner,
    sessionGateway: resolvedSessionGateway,
    settings: coordinatorSettings,
  }));
  const resolvedCreateFileIndexCoordinator = createFileIndexCoordinator || (({ archiveService, settings: coordinatorSettings }) => new FileIndexCoordinator({
    archiveService,
    cacheRepository: resolvedFileIndexCacheRepository,
    outputFile: paths.fileIndex,
    runner: resolvedFileIndexRunner,
    settings: coordinatorSettings,
  }));
  const resolvedCreateSettingsCommandService = createSettingsCommandService || (({
    authentication,
    fileIndexCoordinator,
    inventoryCoordinator,
    jobs,
    settings: commandSettings,
  }) => new SettingsCommandService({
    authentication,
    createArchiveService: resolvedCreateArchiveService,
    ensureArchiveRoot: ensureArchiveRoot || ensureDirectory,
    fileIndexCoordinator,
    inventoryCoordinator,
    jobs,
    scriptDirectory: paths.scriptDirectory,
    settings: commandSettings,
    settingsRepository,
  }));
  const resolvedSystemStatus = systemStatus || readSystemStatus;
  const resolvedCreateFetchCommandService = createFetchCommandService || (({
    jobs,
    settings: commandSettings,
  }) => new FetchCommandService({
    jobs,
    settings: commandSettings,
    systemStatus: resolvedSystemStatus,
  }));
  const dashboard = dashboardFactory(settings || settingsRepository.load(), {
    createAuthenticationCoordinator: resolvedCreateAuthenticationCoordinator,
    createArchiveService: resolvedCreateArchiveService,
    createDashboardRouter: resolvedCreateDashboardRouter,
    createFetchCommandService: resolvedCreateFetchCommandService,
    createFileIndexCoordinator: resolvedCreateFileIndexCoordinator,
    createInventoryCoordinator: resolvedCreateInventoryCoordinator,
    createJobManager: resolvedCreateJobManager,
    createSettingsCommandService: resolvedCreateSettingsCommandService,
    eventHub: resolvedEventHub,
    paths,
    settingsRepository,
    systemStatus: resolvedSystemStatus,
  });
  const server = http.createServer((request, response) => {
    dashboard.route(request, response).catch((error) => {
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error);
    });
  });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0;
  return {
    authenticationRunner: resolvedAuthenticationRunner,
    createAuthenticationCoordinator: resolvedCreateAuthenticationCoordinator,
    dashboard,
    createArchiveService: resolvedCreateArchiveService,
    createDashboardRouter: resolvedCreateDashboardRouter,
    createFetchCommandService: resolvedCreateFetchCommandService,
    createFileIndexCoordinator: resolvedCreateFileIndexCoordinator,
    createInventoryCoordinator: resolvedCreateInventoryCoordinator,
    createJobManager: resolvedCreateJobManager,
    createSettingsCommandService: resolvedCreateSettingsCommandService,
    eventHub: resolvedEventHub,
    fileIndexCacheRepository: resolvedFileIndexCacheRepository,
    fileIndexRunner: resolvedFileIndexRunner,
    jobRepository: resolvedJobRepository,
    inventoryRunner: resolvedInventoryRunner,
    paths,
    processRunner: resolvedProcessRunner,
    server,
    sessionGateway: resolvedSessionGateway,
    settingsRepository,
    systemStatus: resolvedSystemStatus,
  };
}

function startDashboardServer(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  const environment = dependencies.environment || process.env;
  const host = String(options.host || environment.BB_DASHBOARD_HOST || "127.0.0.1");
  const port = Number(options.port || environment.BB_DASHBOARD_PORT || 4173);
  if (!isLoopbackHost(host)) throw new Error("The dashboard contains private course data and must bind to a loopback host");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Dashboard port must be an integer from 1 to 65535");
  const runtime = createDashboardRuntime({ ...dependencies, environment });
  runtime.server.listen(port, host, () => {
    console.log(`Blackboard Archive dashboard: http://${host}:${port}`);
    console.log(`Archive root: ${runtime.dashboard.settings.archiveRoot}`);
  });
  return { ...runtime, host, port };
}

function runDashboardCli(argv = process.argv.slice(2)) {
  const running = startDashboardServer(argv);
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping dashboard (${signal})`);
    running.dashboard.shutdown();
    running.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return running;
}

module.exports = {
  createDashboardPaths,
  createDashboardRuntime,
  parseArguments,
  runDashboardCli,
  startDashboardServer,
};
