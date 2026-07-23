const path = require("path");
const { fork } = require("child_process");

class NodeAuthenticationRunner {
  constructor({ dashboardDirectory, environment = process.env, forkImpl = fork, scriptDirectory }) {
    this.dashboardDirectory = path.resolve(dashboardDirectory);
    this.environment = environment;
    this.forkImpl = forkImpl;
    this.scriptDirectory = path.resolve(scriptDirectory);
  }

  start(specification, handlers = {}) {
    const child = this.forkImpl(path.join(this.dashboardDirectory, "auth-worker.js"), [], {
      cwd: this.scriptDirectory,
      env: {
        ...this.environment,
        BB_AUTH_BASE: specification.base,
        BB_AUTH_STATE_FILE: specification.stateFile,
        BB_AUTH_PROFILE: specification.profileDirectory,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.on("message", (message) => handlers.onMessage?.(message));
    child.once("error", (error) => handlers.onError?.(error));
    child.once("exit", (code, signal) => handlers.onExit?.({ code, signal, stderr: stderr.trim() }));
    return child;
  }

  canSend(child) {
    return Boolean(child?.connected);
  }

  send(child, message) {
    if (!this.canSend(child)) return false;
    try {
      child.send(message);
      return true;
    } catch {
      return false;
    }
  }

  cancel(child) {
    if (!child) return false;
    if (this.send(child, { type: "cancel" })) return true;
    try {
      child.kill("SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { NodeAuthenticationRunner };
