const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

test("fetch-all CLI composes inventory discovery and writes the compatible archive index", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-all-cli-"));
  const output = path.join(root, "archive");
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    cookies: [{ name: "session", value: "local-test", domain: "127.0.0.1", path: "/" }],
  }));

  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ cookie: request.headers.cookie, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url === "/learn/api/v1/users/me") {
      response.end(JSON.stringify({ id: "_user_1" }));
      return;
    }
    if (request.url.startsWith("/learn/api/v1/users/_user_1/memberships")) {
      response.end(JSON.stringify({
        results: [{
          isAvailable: true,
          course: {
            id: "_course_1",
            courseId: "2025R1-TEST1000-ULTRA",
            displayName: "2025R1 Test Course (TEST1000-ULTRA)",
            term: { id: "_term_1", name: "Old 2025-26: 1st Term" },
            ultraStatus: "ULTRA",
          },
        }],
        paging: { count: 1 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const result = await runProcess(process.execPath, [
    path.join(PROJECT_ROOT, "bin", "fetch-blackboard-all.js"),
    "--base", base,
    "--state", stateFile,
    "--output", output,
    "--inventory-only",
  ], { cwd: PROJECT_ROOT });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /INVENTORY 1 courses/);
  assert.deepEqual(requests.map((request) => request.cookie), ["session=local-test", "session=local-test"]);
  const index = JSON.parse(fs.readFileSync(path.join(output, "courses.json"), "utf8"));
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.inventoryCount, 1);
  assert.equal(index.courses[0].term.sourceName, "Old 2025-26: 1st Term");
  assert.equal(index.courses[0].term.name, "2025-26: 1st Term");
  assert.equal(index.courses[0].outputDirectory, path.join(
    "2025-26",
    "1st Term",
    "2025R1-TEST1000 - Test Course"
  ));
  assert.equal("outputPath" in index.courses[0], false);
});
