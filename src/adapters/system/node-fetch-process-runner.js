const path = require("path");
const { spawn } = require("child_process");
const { ensureDirectory } = require("../filesystem/json-file-store");
const { courseFetchArguments, courseFetchEnvironment } = require("./course-fetch-process-specification");
const { streamLines } = require("./process-streams");

class NodeFetchProcessRunner {
  constructor({
    environment = process.env,
    executable = process.execPath,
    killImpl = process.kill,
    platform = process.platform,
    scriptDirectory,
    spawnImpl = spawn,
  }) {
    this.environment = environment;
    this.executable = executable;
    this.killImpl = killImpl;
    this.platform = platform;
    this.scriptDirectory = path.resolve(scriptDirectory);
    this.spawnImpl = spawnImpl;
  }

  get supportsLivePause() {
    return this.platform !== "win32";
  }

  startFetch(specification, handlers = {}) {
    ensureDirectory(specification.outputPath);
    const args = courseFetchArguments(specification, { scriptDirectory: this.scriptDirectory });
    const child = this.spawnImpl(this.executable, args, {
      cwd: this.scriptDirectory,
      detached: this.supportsLivePause,
      env: courseFetchEnvironment(specification, this.environment, { progressEvents: true }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    streamLines(child.stdout, handlers.onStdout || (() => {}));
    streamLines(child.stderr, handlers.onStderr || (() => {}));
    child.once("error", (error) => handlers.onError?.(error));
    child.once("close", (code, signal) => handlers.onExit?.(code, signal));
    return child;
  }

  signal(child, signal) {
    if (!child || child.killed) return false;
    try {
      if (this.platform === "win32") child.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
      else this.killImpl(-child.pid, signal);
      return true;
    } catch {
      try {
        child.kill(signal);
        return true;
      } catch {
        return false;
      }
    }
  }

}

module.exports = { NodeFetchProcessRunner };
