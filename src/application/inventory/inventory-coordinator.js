const { EventEmitter } = require("events");
const { httpError } = require("../../shared/http-error");

function cleanLogLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 900);
}

class InventoryCoordinator extends EventEmitter {
  constructor({ archiveService, clock = () => new Date(), runner, scheduler, sessionGateway, settings }) {
    super();
    if (!runner) throw new TypeError("InventoryCoordinator requires a runner");
    if (!sessionGateway) throw new TypeError("InventoryCoordinator requires a sessionGateway");
    this.archiveService = archiveService;
    this.clock = clock;
    this.runner = runner;
    this.scheduler = scheduler || {
      delay: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        timer.unref?.();
        return timer;
      },
    };
    this.sessionGateway = sessionGateway;
    this.settings = settings;
    this.process = null;
    this.state = { status: "idle", startedAt: null, finishedAt: null, logs: [], exitCode: null, message: null };
  }

  now() {
    return this.clock();
  }

  nowIso() {
    return this.now().toISOString();
  }

  active() {
    return Boolean(this.process);
  }

  setArchiveService(archiveService) {
    this.archiveService = archiveService;
  }

  setSettings(settings) {
    this.settings = settings;
  }

  snapshot() {
    const elapsedMs = this.state.startedAt
      ? Date.parse(this.state.finishedAt || this.nowIso()) - Date.parse(this.state.startedAt)
      : 0;
    return { ...this.state, elapsedMs, logs: this.state.logs.slice(-100) };
  }

  emitUpdate() {
    const snapshot = this.snapshot();
    this.emit("update", snapshot);
    return snapshot;
  }

  start() {
    if (this.process) throw httpError(409, "Course inventory is already running");
    if (!this.settings.blackboardBase) throw httpError(400, "Set the Blackboard URL first");
    if (!this.sessionGateway.exists(this.settings)) throw httpError(400, "Sign in and save a Blackboard session first");
    this.state = {
      status: "running",
      startedAt: this.nowIso(),
      finishedAt: null,
      logs: [],
      exitCode: null,
      message: "Reading course memberships without downloading course content",
    };
    try {
      this.process = this.runner.start({
        archiveRoot: this.settings.archiveRoot,
        base: this.settings.blackboardBase,
        downloadMode: this.settings.downloadMode,
        stateFile: this.settings.stateFile,
      }, {
        onError: (error) => this.handleError(error),
        onExit: (code, signal) => this.handleExit(code, signal),
        onLine: (line) => this.handleLine(line),
      });
    } catch (error) {
      this.state = { ...this.state, status: "failed", finishedAt: this.nowIso(), message: error.message };
      this.emitUpdate();
      throw error;
    }
    return this.emitUpdate();
  }

  handleLine(line) {
    const clean = cleanLogLine(line);
    if (!clean) return;
    this.state.logs.push({ at: this.nowIso(), line: clean });
    this.state.logs = this.state.logs.slice(-100);
    this.emitUpdate();
  }

  handleError(error) {
    this.handleLine(`Unable to run inventory: ${error.message}`);
  }

  handleExit(code, signal) {
    this.process = null;
    this.state.exitCode = Number.isInteger(code) ? code : null;
    this.state.finishedAt = this.nowIso();
    this.state.status = code === 0 ? "completed" : this.state.status === "cancelling" ? "cancelled" : "failed";
    this.archiveService.invalidate();
    const inventory = this.archiveService.getInventory();
    this.state.message = code === 0
      ? `Inventory now contains ${inventory.courses.length} courses`
      : signal ? `Inventory stopped by ${signal}` : `Inventory exited with code ${code}`;
    this.emitUpdate();
    this.emit("finished", inventory);
  }

  cancel() {
    if (!this.process) throw httpError(409, "No course inventory is running");
    const process = this.process;
    this.state.status = "cancelling";
    this.state.message = "Stopping course inventory";
    this.runner.signal(process, "SIGTERM");
    this.scheduler.delay(() => {
      if (this.process === process) this.runner.signal(process, "SIGKILL");
    }, 5_000);
    return this.emitUpdate();
  }

  shutdown() {
    if (this.process) this.runner.signal(this.process, "SIGTERM");
  }
}

module.exports = { cleanLogLine, InventoryCoordinator };
