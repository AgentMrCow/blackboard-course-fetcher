#!/usr/bin/env node

const REQUIRED_DEPENDENCIES = [
  "paths",
  "createArchiveService",
  "createJobManager",
  "createAuthenticationCoordinator",
  "createInventoryCoordinator",
  "createFileIndexCoordinator",
  "createSettingsCommandService",
  "createFetchCommandService",
  "createDashboardRouter",
  "eventHub",
  "systemStatus",
];

class DashboardServer {
  constructor(settings, dependencies = {}) {
    if (!settings) throw new TypeError("DashboardServer requires settings");
    for (const dependency of REQUIRED_DEPENDENCIES) {
      if (!dependencies[dependency]) throw new TypeError(`DashboardServer requires ${dependency}`);
    }
    this.paths = dependencies.paths;
    this.createArchiveService = dependencies.createArchiveService;
    this.createJobManager = dependencies.createJobManager;
    this.eventHub = dependencies.eventHub;
    this.systemStatus = dependencies.systemStatus;
    this.settings = settings;
    this.archiveService = this.createArchiveService(settings.archiveRoot);
    this.jobs = this.createJobManager({ archiveService: this.archiveService });
    this.authentication = dependencies.createAuthenticationCoordinator({ settings: this.settings });
    this.inventoryCoordinator = dependencies.createInventoryCoordinator({
      archiveService: this.archiveService,
      settings: this.settings,
    });
    this.fileIndexCoordinator = dependencies.createFileIndexCoordinator({
      archiveService: this.archiveService,
      settings: this.settings,
    });
    this.settingsCommands = dependencies.createSettingsCommandService({
      authentication: this.authentication,
      fileIndexCoordinator: this.fileIndexCoordinator,
      inventoryCoordinator: this.inventoryCoordinator,
      jobs: this.jobs,
      settings: this.settings,
    });
    this.fetchCommands = dependencies.createFetchCommandService({
      jobs: this.jobs,
      settings: this.settings,
    });
    this.hadActiveJob = Boolean(this.jobs.activeBatch());
    this.jobs.on("update", (jobs) => {
      this.eventHub.publish("jobs", jobs);
      const hasActiveJob = Boolean(this.jobs.activeBatch());
      if (this.hadActiveJob && !hasActiveJob) this.fileIndexCoordinator.requestRebuild();
      this.hadActiveJob = hasActiveJob;
    });
    this.authentication.on("update", (snapshot) => this.eventHub.publish("auth", snapshot));
    this.inventoryCoordinator.on("update", (snapshot) => this.eventHub.publish("inventory-task", snapshot));
    this.inventoryCoordinator.on("finished", (inventory) => {
      this.fileIndexCoordinator.requestRebuild();
      this.eventHub.publish("inventory", inventory);
    });
    this.fileIndexCoordinator.on("update", (snapshot) => this.eventHub.publish("file-index", snapshot));
    this.fileIndexCoordinator.on("ready", () => this.eventHub.publish("summary", this.archiveService.summary()));
    this.router = dependencies.createDashboardRouter({ dashboard: this, eventHub: this.eventHub, paths: this.paths });
    this.fileIndexCoordinator.initialize();
  }

  authSnapshot() {
    return this.authentication.snapshot();
  }

  inventorySnapshot() {
    return this.inventoryCoordinator.snapshot();
  }

  async bootstrap({ refresh = false } = {}) {
    if (refresh) {
      this.archiveService.invalidate();
      this.fileIndexCoordinator.requestRebuild();
    }
    return {
      app: { name: "Blackboard Archive", version: "0.2.0" },
      settings: this.settings,
      auth: this.authSnapshot(),
      inventoryTask: this.inventorySnapshot(),
      inventory: this.archiveService.getInventory(),
      summary: this.archiveService.summary(),
      jobs: this.jobs.snapshot(),
      fileIndex: this.fileIndexCoordinator.snapshot(),
      system: this.systemStatus(this.settings),
    };
  }

  saveSettings(input) {
    const result = this.settingsCommands.update(input);
    this.settings = result.settings;
    this.archiveService = result.archiveService;
    this.fetchCommands.setSettings(this.settings);
    this.eventHub.publish("settings", this.settings);
    return this.settings;
  }

  fileIndexSnapshot() {
    return this.fileIndexCoordinator.snapshot();
  }

  startAuth() {
    return this.authentication.start();
  }

  saveAuth() {
    return this.authentication.save();
  }

  cancelAuth() {
    return this.authentication.cancel();
  }

  startInventory() {
    return this.inventoryCoordinator.start();
  }

  cancelInventory() {
    return this.inventoryCoordinator.cancel();
  }

  checkAuthentication() {
    return this.authentication.check();
  }

  courseInventory() {
    return this.archiveService.getInventory();
  }

  archiveSummary() {
    return this.archiveService.summary();
  }

  searchArchive(query, options) {
    return this.archiveService.search(query, options);
  }

  listArchiveFiles(options) {
    if (!this.archiveService.externalFileIndex && this.fileIndexCoordinator.snapshot().status === "running") {
      return { indexing: true, status: this.fileIndexSnapshot(), total: null, offset: 0, limit: 0, files: [] };
    }
    return this.archiveService.allFiles(options);
  }

  courseDetails(courseId) {
    return this.archiveService.getCourse(courseId);
  }

  resolveArchiveFile(courseId, relativePath) {
    return this.archiveService.resolveCourseFile(courseId, relativePath);
  }

  jobsSnapshot() {
    return this.jobs.snapshot();
  }

  startFetch(body) {
    return this.fetchCommands.start(body);
  }

  controlFetchBatch(batchId, action) {
    return this.jobs.controlBatch(batchId, action);
  }

  controlFetchTask(batchId, taskId, action) {
    return this.jobs.controlTask(batchId, taskId, action);
  }

  async route(request, response) {
    return this.router.route(request, response);
  }

  shutdown() {
    this.jobs.stopAll();
    this.inventoryCoordinator.shutdown();
    this.authentication.shutdown();
    this.fileIndexCoordinator.shutdown();
    this.eventHub.close();
  }
}

module.exports = { DashboardServer };

if (require.main === module) {
  require("../src/composition/dashboard-runtime").runDashboardCli(process.argv.slice(2));
}
