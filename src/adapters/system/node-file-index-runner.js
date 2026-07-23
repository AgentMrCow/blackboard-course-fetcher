const path = require("path");
const { fork } = require("child_process");
const { killProcessTree } = require("./local-runtime");

class NodeFileIndexRunner {
  constructor({
    dashboardDirectory,
    environment = process.env,
    forkImpl = fork,
    scriptDirectory,
    signalImpl = killProcessTree,
  }) {
    this.dashboardDirectory = path.resolve(dashboardDirectory);
    this.environment = environment;
    this.forkImpl = forkImpl;
    this.scriptDirectory = path.resolve(scriptDirectory);
    this.signalImpl = signalImpl;
  }

  start(specification, handlers = {}) {
    const child = this.forkImpl(path.join(this.dashboardDirectory, "file-index-worker.js"), [], {
      cwd: this.scriptDirectory,
      env: {
        ...this.environment,
        BB_ARCHIVE_ROOT: specification.archiveRoot,
        BB_FILE_INDEX: specification.outputFile,
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

  signal(child, signal) {
    if (!child) return false;
    return this.signalImpl(child, signal) !== false;
  }
}

module.exports = { NodeFileIndexRunner };
