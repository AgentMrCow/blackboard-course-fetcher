const path = require("path");
const { spawn } = require("child_process");
const { ensureDirectory } = require("../filesystem/json-file-store");
const { killProcessTree } = require("./local-runtime");
const { streamLines } = require("./process-streams");

class NodeInventoryProcessRunner {
  constructor({
    environment = process.env,
    executable = process.execPath,
    platform = process.platform,
    scriptDirectory,
    signalImpl = killProcessTree,
    spawnImpl = spawn,
  }) {
    this.environment = environment;
    this.executable = executable;
    this.platform = platform;
    this.scriptDirectory = path.resolve(scriptDirectory);
    this.signalImpl = signalImpl;
    this.spawnImpl = spawnImpl;
  }

  start(specification, handlers = {}) {
    ensureDirectory(specification.archiveRoot);
    const args = [
      path.join(this.scriptDirectory, "bin", "fetch-blackboard-all.js"),
      "--base", specification.base,
      "--state", specification.stateFile,
      "--output", specification.archiveRoot,
      "--download-mode", specification.downloadMode,
      "--inventory-only",
    ];
    const child = this.spawnImpl(this.executable, args, {
      cwd: this.scriptDirectory,
      detached: this.platform !== "win32",
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    streamLines(child.stdout, (line) => handlers.onLine?.(line, "stdout"));
    streamLines(child.stderr, (line) => handlers.onLine?.(line, "stderr"));
    child.once("error", (error) => handlers.onError?.(error));
    child.once("close", (code, signal) => handlers.onExit?.(code, signal));
    return child;
  }

  signal(child, signal) {
    if (!child) return false;
    return this.signalImpl(child, signal) !== false;
  }
}

module.exports = { NodeInventoryProcessRunner };
