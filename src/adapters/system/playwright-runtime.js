const fs = require("fs");
const path = require("path");

function loadPlaywright({ environment = process.env, executable = process.execPath } = {}) {
  const candidates = [
    environment.PLAYWRIGHT_MODULE,
    "playwright",
    path.resolve(path.dirname(executable), "../lib/node_modules/@playwright/cli/node_modules/playwright"),
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  throw new Error(`Playwright is unavailable (${failures.join("; ")})`);
}

function findChromiumExecutable(
  chromium,
  { environment = process.env, home = process.env.HOME || "" } = {}
) {
  const configured = environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (configured && fs.existsSync(configured)) return configured;

  const bundled = chromium.executablePath();
  if (bundled && fs.existsSync(bundled)) return bundled;

  const cacheRoot = path.join(home, ".cache", "ms-playwright");
  if (fs.existsSync(cacheRoot)) {
    const candidates = fs
      .readdirSync(cacheRoot)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]))
      .map((name) => path.join(cacheRoot, name, "chrome-linux64", "chrome"))
      .filter((candidate) => fs.existsSync(candidate));
    if (candidates[0]) return candidates[0];
  }

  throw new Error(
    "No installed Chromium executable found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a valid browser path"
  );
}

async function launchChromium(options = {}, runtime = {}) {
  const { chromium } = loadPlaywright(runtime);
  return chromium.launch({
    headless: true,
    executablePath: findChromiumExecutable(chromium, runtime),
    ...options,
  });
}

module.exports = { findChromiumExecutable, launchChromium, loadPlaywright };
