const { EventEmitter } = require("events");
const { httpError } = require("../../shared/http-error");

class AuthenticationCoordinator extends EventEmitter {
  constructor({ clock = () => new Date(), profileDirectory, runner, sessionGateway, settings }) {
    super();
    if (!runner) throw new TypeError("AuthenticationCoordinator requires a runner");
    if (!sessionGateway) throw new TypeError("AuthenticationCoordinator requires a sessionGateway");
    this.clock = clock;
    this.profileDirectory = profileDirectory;
    this.runner = runner;
    this.sessionGateway = sessionGateway;
    this.settings = settings;
    this.worker = null;
    this.state = { status: "idle", message: null, startedAt: null, validation: null };
  }

  nowIso() {
    return this.clock().toISOString();
  }

  active() {
    return Boolean(this.worker);
  }

  setSettings(settings) {
    this.settings = settings;
  }

  snapshot() {
    return { ...this.sessionGateway.metadata(this.settings), ...this.state };
  }

  emitUpdate() {
    const snapshot = this.snapshot();
    this.emit("update", snapshot);
    return snapshot;
  }

  async check() {
    const validation = await this.sessionGateway.validate(this.settings);
    this.state = {
      ...this.state,
      status: validation.valid ? "connected" : "idle",
      message: validation.message,
      validation,
    };
    return this.emitUpdate();
  }

  start() {
    if (this.worker) throw httpError(409, "A sign-in browser is already open");
    if (!this.settings.blackboardBase) throw httpError(400, "Set the Blackboard URL before signing in");
    this.state = {
      status: "starting",
      message: "Opening the official Blackboard sign-in page",
      startedAt: this.nowIso(),
      validation: null,
    };
    try {
      this.worker = this.runner.start({
        base: this.settings.blackboardBase,
        profileDirectory: this.profileDirectory,
        stateFile: this.settings.stateFile,
      }, {
        onError: (error) => this.handleError(error),
        onExit: (result) => this.handleExit(result),
        onMessage: (message) => this.handleMessage(message),
      });
    } catch (error) {
      this.state = { ...this.state, status: "error", message: error.message };
      this.emitUpdate();
      throw error;
    }
    return this.emitUpdate();
  }

  handleMessage(message) {
    if (message.type === "ready") this.state = { ...this.state, status: "waiting", message: message.message };
    if (message.type === "saved") {
      this.state = {
        ...this.state,
        status: message.validation?.valid ? "connected" : "waiting",
        message: message.message,
        validation: message.validation,
      };
    }
    if (message.type === "closed") this.state = { ...this.state, status: "idle", message: message.message };
    if (message.type === "error") this.state = { ...this.state, status: "error", message: message.message };
    this.emitUpdate();
  }

  handleError(error) {
    this.state = { ...this.state, status: "error", message: error.message };
    this.emitUpdate();
  }

  handleExit({ code, stderr }) {
    this.worker = null;
    if (!["connected", "error"].includes(this.state.status)) {
      this.state = {
        ...this.state,
        status: code === 0 ? "idle" : "error",
        message: code === 0 ? this.state.message : (stderr || `Sign-in browser exited with code ${code}`),
      };
    }
    this.emitUpdate();
  }

  save() {
    if (!this.runner.canSend(this.worker)) throw httpError(409, "No sign-in browser is waiting for confirmation");
    this.state = { ...this.state, status: "saving", message: "Checking the Blackboard session" };
    if (!this.runner.send(this.worker, { type: "save" })) {
      throw httpError(409, "The sign-in browser is no longer available");
    }
    return this.emitUpdate();
  }

  cancel() {
    if (this.worker) this.runner.cancel(this.worker);
    this.state = { status: "idle", message: "Sign-in was cancelled", startedAt: null, validation: null };
    return this.emitUpdate();
  }

  shutdown() {
    if (this.worker) this.runner.cancel(this.worker);
  }
}

module.exports = { AuthenticationCoordinator };
