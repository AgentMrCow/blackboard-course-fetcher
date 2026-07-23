const path = require("path");
const { spawn } = require("child_process");
const { ensureDirectory } = require("../filesystem/json-file-store");
const { courseFetchArguments, courseFetchEnvironment } = require("./course-fetch-process-specification");

class NodeCourseFetchRunner {
  constructor({
    environment = process.env,
    executable = process.execPath,
    scriptDirectory,
    spawnImpl = spawn,
    stdio = "inherit",
  }) {
    if (!scriptDirectory) throw new TypeError("NodeCourseFetchRunner requires a scriptDirectory");
    this.environment = environment;
    this.executable = executable;
    this.scriptDirectory = path.resolve(scriptDirectory);
    this.spawnImpl = spawnImpl;
    this.stdio = stdio;
  }

  run(specification) {
    ensureDirectory(specification.outputPath);
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(
          this.executable,
          courseFetchArguments(specification, { scriptDirectory: this.scriptDirectory }),
          {
            cwd: this.scriptDirectory,
            env: courseFetchEnvironment(specification, this.environment),
            stdio: this.stdio,
          }
        );
      } catch (error) {
        resolve({ exitCode: 1, signal: null, startError: error });
        return;
      }

      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode: 1, signal: null, startError: error });
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({
          exitCode: Number.isInteger(code) ? code : 1,
          signal: signal || null,
          startError: null,
        });
      });
    });
  }
}

module.exports = { NodeCourseFetchRunner };
