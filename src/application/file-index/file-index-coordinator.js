const { EventEmitter } = require("events");

function initialFileIndexState() {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    scannedCourses: 0,
    totalCourses: 0,
    fileCount: 0,
    bytes: 0,
    message: null,
  };
}

class FileIndexCoordinator extends EventEmitter {
  constructor({ archiveService, cacheRepository, clock = () => new Date(), outputFile, runner, scheduler, settings }) {
    super();
    if (!archiveService) throw new TypeError("FileIndexCoordinator requires an archiveService");
    if (!cacheRepository) throw new TypeError("FileIndexCoordinator requires a cacheRepository");
    if (!runner) throw new TypeError("FileIndexCoordinator requires a runner");
    this.archiveService = archiveService;
    this.cacheRepository = cacheRepository;
    this.clock = clock;
    this.outputFile = outputFile;
    this.runner = runner;
    this.scheduler = scheduler || { defer: (callback) => setImmediate(callback) };
    this.settings = settings;
    this.worker = null;
    this.pendingRebuild = false;
    this.startScheduled = false;
    this.shuttingDown = false;
    this.state = initialFileIndexState();
  }

  nowIso() {
    return this.clock().toISOString();
  }

  active() {
    return Boolean(this.worker);
  }

  snapshot() {
    return { ...this.state };
  }

  emitUpdate() {
    const snapshot = this.snapshot();
    this.emit("update", snapshot);
    return snapshot;
  }

  loadCachedIndex() {
    const index = this.cacheRepository.load({ archiveRoot: this.settings.archiveRoot });
    if (!index || !this.archiveService.setFileIndex(index)) return false;
    this.state = {
      status: "complete",
      startedAt: null,
      finishedAt: index.generatedAt,
      scannedCourses: index.courseCount || 0,
      totalCourses: index.courseCount || 0,
      fileCount: index.fileCount || 0,
      bytes: index.bytes || 0,
      message: "Local file index is ready",
    };
    return true;
  }

  initialize() {
    if (!this.loadCachedIndex()) this.scheduleStart();
    return this.snapshot();
  }

  scheduleStart() {
    if (this.startScheduled || this.shuttingDown) return;
    this.startScheduled = true;
    this.scheduler.defer(() => {
      this.startScheduled = false;
      if (this.shuttingDown || this.worker) return;
      try {
        this.start(true);
      } catch {}
    });
  }

  start(force = false) {
    if (this.worker) {
      if (force) this.pendingRebuild = true;
      return this.snapshot();
    }
    if (!force && this.state.status === "complete") return this.snapshot();
    this.state = {
      status: "running",
      startedAt: this.nowIso(),
      finishedAt: null,
      scannedCourses: 0,
      totalCourses: 0,
      fileCount: 0,
      bytes: 0,
      message: "Indexing local archive files in the background",
    };
    try {
      this.worker = this.runner.start({
        archiveRoot: this.settings.archiveRoot,
        outputFile: this.outputFile,
      }, {
        onError: (error) => this.handleError(error),
        onExit: (result) => this.handleExit(result),
        onMessage: (message) => this.handleMessage(message),
      });
    } catch (error) {
      this.state = { ...this.state, status: "failed", finishedAt: this.nowIso(), message: error.message };
      this.emitUpdate();
      throw error;
    }
    return this.emitUpdate();
  }

  requestRebuild() {
    return this.start(true);
  }

  handleMessage(message) {
    if (message.type === "progress") {
      this.state = {
        ...this.state,
        scannedCourses: message.scannedCourses,
        totalCourses: message.totalCourses,
        fileCount: message.fileCount,
      };
    } else if (message.type === "complete") {
      this.state = {
        ...this.state,
        status: "complete",
        finishedAt: this.nowIso(),
        fileCount: message.fileCount,
        bytes: message.bytes,
        message: "Local file index is ready",
      };
    } else if (message.type === "error") {
      this.state = { ...this.state, status: "failed", finishedAt: this.nowIso(), message: message.message };
    } else {
      return;
    }
    this.emitUpdate();
  }

  handleError(error) {
    this.state = { ...this.state, status: "failed", finishedAt: this.nowIso(), message: error.message };
    this.emitUpdate();
  }

  handleExit({ code, stderr }) {
    this.worker = null;
    if (this.shuttingDown) return;
    if (this.pendingRebuild) {
      this.pendingRebuild = false;
      this.archiveService.invalidate({ fileIndex: true });
      this.scheduleStart();
      return;
    }
    if (code === 0 && this.loadCachedIndex()) {
      const snapshot = this.emitUpdate();
      this.emit("ready", snapshot);
    } else if (this.state.status !== "failed") {
      this.state = {
        ...this.state,
        status: "failed",
        finishedAt: this.nowIso(),
        message: stderr || `File indexer exited with code ${code}`,
      };
      this.emitUpdate();
    }
  }

  reconfigure({ archiveService, settings }) {
    const rootChanged = this.settings.archiveRoot !== settings.archiveRoot;
    this.archiveService = archiveService;
    this.settings = settings;
    if (this.worker && rootChanged) {
      this.pendingRebuild = true;
      this.runner.signal(this.worker, "SIGTERM");
    }
    if (this.loadCachedIndex()) return this.emitUpdate();
    return this.requestRebuild();
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.worker) this.runner.signal(this.worker, "SIGTERM");
  }
}

module.exports = { FileIndexCoordinator, initialFileIndexState };
