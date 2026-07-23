const fs = require("fs");
const path = require("path");

function systemStatus(settings) {
  let disk = null;
  try {
    const target = fs.existsSync(settings.archiveRoot) ? settings.archiveRoot : path.dirname(settings.archiveRoot);
    const stat = fs.statfsSync(target);
    disk = { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
  } catch {}
  let chromiumInstalled = false;
  try {
    const { chromium } = require("playwright");
    chromiumInstalled = fs.existsSync(chromium.executablePath());
  } catch {}
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    liveProcessPause: process.platform !== "win32",
    chromiumInstalled,
    archiveRootExists: fs.existsSync(settings.archiveRoot),
    disk,
  };
}

function killProcessTree(child, signal = "SIGTERM") {
  if (!child || child.killed) return false;
  try {
    if (process.platform === "win32") child.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
    else process.kill(-child.pid, signal);
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

module.exports = { killProcessTree, systemStatus };
