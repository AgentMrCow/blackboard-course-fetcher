const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MEMBERSHIP_DENIAL = "User is not enrolled or membership is unavailable";

test("a visible course shell with denied membership preserves the previous archive", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-course-access-"));
  const output = path.join(root, "archive");
  fs.mkdirSync(output);
  const originals = new Map([
    ["manifest.json", JSON.stringify({
      schemaVersion: 12, archiveLayoutVersion: 1, courseId: "_course_1",
      coverage: { complete: true }, downloads: [], contents: [{ id: "_old_1" }],
    }, null, 2)],
    ["README.md", "Previously archived course summary\n"],
    ["CURRENT_STATUS.md", "Previously archived course status\n"],
    ["gradebook.json", '{"items":[]}\n'],
    ["03_Announcements/README.md", "Previously archived announcements\n"],
    ["02_Library/reference.txt", "Previously archived library material\n"],
    ["01_Course_Contents/notes.txt", "Previously downloaded course material\n"],
  ]);
  for (const [file, body] of originals) {
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
    fs.writeFileSync(path.join(output, file), body);
  }
  const stateFile = path.join(root, "synthetic-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [] }));
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    requests.push(pathname);
    response.setHeader("content-type", "application/json");
    if (pathname === "/learn/api/v1/courses/_course_1") {
      response.end(JSON.stringify({ id: "_course_1", name: "Historical course", ultraStatus: "CLASSIC" }));
    } else if (pathname === "/learn/api/v1/courses/_course_1/contents/ROOT/children") {
      response.end(JSON.stringify({
        results: [{ id: "_folder_1", title: "Course Contents", contentHandler: "resource/x-bb-folder" }],
        paging: { count: 1 },
      }));
    } else if (pathname === "/learn/api/v1/users/me") {
      response.end(JSON.stringify({ id: "_student_1" }));
    } else {
      response.statusCode = 403;
      response.end(JSON.stringify({ status: 403, message: MEMBERSHIP_DENIAL }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(PROJECT_ROOT, "bin/fetch-blackboard-course.js"),
      "--base", `http://127.0.0.1:${server.address().port}`,
      "--course-id", "_course_1", "--state", stateFile,
      "--output", output, "--download-mode", "full",
    ], { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });

  for (const [file, body] of originals) {
    assert.equal(fs.readFileSync(path.join(output, file), "utf8"), body, `${file} must be preserved`);
  }
  assert.equal(fs.existsSync(path.join(output, "02_Announcements")), false, "denied access must not migrate legacy announcements");
  assert.equal(fs.existsSync(path.join(output, "08_Library")), false, "denied access must not migrate legacy library files");
  assert.equal(fs.existsSync(path.join(output, ".fetch-history")), false, "denied access must not start an archive refresh");
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Previous manifest retained/);
  const failed = JSON.parse(fs.readFileSync(path.join(output, "manifest.failed.json"), "utf8"));
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0].label, "fatal");
  assert.ok(failed.errors[0].error.includes(MEMBERSHIP_DENIAL));
  assert.deepEqual(requests, [
    "/learn/api/v1/courses/_course_1",
    "/learn/api/v1/courses/_course_1/contents/ROOT/children",
    "/learn/api/v1/courses/_course_1/contents/_folder_1",
  ]);
});

for (const outcome of ["incomplete", "fatal"]) {
  test(`${outcome === "incomplete" ? "An" : "A"} ${outcome} CLI refresh preserves exact previous metadata in its recovery journal`, { timeout: 60_000 }, async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-refresh-history-"));
    const output = path.join(root, "archive");
    const announcementDirectory = "02_Announcements/2026-01-01_Notice";
    const originals = new Map([
      ["manifest.json", JSON.stringify({
        schemaVersion: 12, archiveLayoutVersion: 2, courseId: "_course_1",
        coverage: { complete: true }, downloads: [], contents: [], announcements: [], assessments: [],
      }, null, 2)],
      ["README.md", "Previous complete course summary\r\n"],
      ["manifest.failed.json", '{"errors":[{"error":"Prior diagnostic evidence"}]}\r\n'],
      ["CURRENT_STATUS.md", "Previous grade snapshot\r\n"],
      ["gradebook.json", '{"items":[{"columnId":"_old_1","grade":{"score":7}}]}\r\n'],
      [`${announcementDirectory}/announcement.html`, "<!doctype html><p>Original notice — retained exactly.</p>\r\n"],
      [`${announcementDirectory}/announcement.txt`, "Original notice — retained exactly.\r\n"],
      ["02_Announcements/README.md", "Previous announcement index\n"],
      ["03_Calendar/calendar.json", '{"items":[{"title":"Original event"}]}\r\n'],
      ["04_Discussions/discussions.json", '{"boards":[{"id":"_old_board_1"}]}\r\n'],
    ]);
    for (const [file, body] of originals) {
      fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
      fs.writeFileSync(path.join(output, file), body);
    }
    const stateFile = path.join(root, "synthetic-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ cookies: [] }));
    let metadataRequests = 0;
    const unexpectedRequests = [];
    const emptyLists = new Set([
      "/contents/ROOT/children", "/gradebook/grades", "/gradebook/columns",
      "/calendars/calendarItems", "/discussionboards", "/conversations",
    ]);
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const coursePath = "/learn/api/v1/courses/_course_1";
      const endpoint = pathname.slice(coursePath.length);
      response.setHeader("content-type", "application/json");
      if (pathname === coursePath) {
        metadataRequests += 1;
        if (outcome === "fatal" && metadataRequests > 1) {
          response.statusCode = 403;
          response.end(JSON.stringify({ status: 403, message: "Synthetic failure after gradebook export" }));
        } else {
          response.end(JSON.stringify({ id: "_course_1", name: "Synthetic course", ultraStatus: "CLASSIC" }));
        }
      } else if (pathname === "/learn/api/v1/users/me") {
        response.end(JSON.stringify({ id: "_student_1" }));
      } else if (endpoint === "/announcements") {
        response.end(JSON.stringify({
          results: [{ id: "_notice_1", title: "Notice", createdDate: "2026-01-01T00:00:00.000Z", body: { displayText: "<p>Updated notice</p>" } }],
          paging: { count: 1 },
        }));
      } else if (endpoint === "/groupsets") {
        response.statusCode = 403;
        response.end(JSON.stringify({ status: 403, message: "Synthetic restricted groups" }));
      } else if (endpoint === "/conversations/counts" || endpoint === "/discussionboards/count") {
        response.end(JSON.stringify({ totalCount: 0, unreadCount: 0 }));
      } else if (pathname.startsWith(coursePath) && emptyLists.has(endpoint)) {
        response.end(JSON.stringify({ results: [], paging: { count: 0 } }));
      } else {
        unexpectedRequests.push(pathname);
        response.statusCode = 404;
        response.end(JSON.stringify({ status: 404, message: "Unexpected synthetic request" }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(PROJECT_ROOT, "bin/fetch-blackboard-course.js"),
        "--base", `http://127.0.0.1:${server.address().port}`,
        "--course-id", "_course_1", "--state", stateFile,
        "--output", output, "--download-mode", "placeholder",
      ], { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 });
      let stderr = "";
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr, stdout }));
    });
    assert.deepEqual(unexpectedRequests, []);
    assert.equal(metadataRequests, 2, "the run must reach the additional archive phase after exporting grades");
    assert.equal(result.code, outcome === "fatal" ? 1 : 2, `${result.stdout}\n${result.stderr}`);
    const current = JSON.parse(fs.readFileSync(path.join(output, outcome === "fatal" ? "manifest.failed.json" : "manifest.json"), "utf8"));
    assert.ok(current.errors.some((error) => error.error.includes(outcome === "fatal" ? "Synthetic failure" : "Synthetic restricted groups")));
    assert.match(current.previousMetadataHistory, /^\.fetch-history\//);
    const historyDirectory = path.join(output, current.previousMetadataHistory);
    const history = JSON.parse(fs.readFileSync(path.join(historyDirectory, "index.json"), "utf8"));
    assert.equal(history.schemaVersion, 1);
    assert.equal(new Set(history.files.map((file) => file.path)).size, history.files.length, "each original is backed up once");
    const expectedBackups = [...originals.keys()].filter((file) => outcome !== "fatal" || file === "manifest.json" || file === "manifest.failed.json"
      || file === "gradebook.json" || file.startsWith("02_Announcements/"));
    for (const file of expectedBackups) {
      const entry = history.files.find((item) => item.path === file);
      assert.ok(entry, `${file} must be indexed for recovery`);
      const originalBytes = Buffer.from(originals.get(file));
      assert.deepEqual(fs.readFileSync(path.join(historyDirectory, entry.backupPath)), originalBytes, `${file} backup must retain exact original bytes`);
      assert.equal(entry.size, originalBytes.length);
      assert.equal(entry.sha256, crypto.createHash("sha256").update(originalBytes).digest("hex"));
      if (file === "manifest.failed.json" && outcome !== "fatal") {
        assert.equal(fs.existsSync(path.join(output, file)), false, "old diagnostics removed only after preservation");
      } else if (file !== "manifest.json" || outcome !== "fatal") {
        assert.notDeepEqual(fs.readFileSync(path.join(output, file)), originalBytes, `${file} must actually have been replaced during this run`);
      }
    }
    if (outcome === "fatal") {
      assert.equal(fs.readFileSync(path.join(output, "manifest.json"), "utf8"), originals.get("manifest.json"));
    } else {
      assert.equal(current.coverage.complete, false);
    }
  });
}

// Exercise production bootstrap/content sequencing while stopping before the
// unrelated browser/archive phases. The integration test above covers the
// real CLI fatal handler and disk preservation.
async function runThroughContent({ rootChildren = [{ id: "_folder_1" }], detailError = null } = {}) {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/composition/course-fetch-runtime.js"), "utf8");
  const mainSource = source.slice(source.indexOf("async function main()"), source.indexOf("\nmain().catch("));
  const stop = new Error("Stopped after content phase");
  const events = [];
  const sandbox = {
    path, COURSE_ID: "_course_1", DOWNLOAD_MODE: "full", OUT_ROOT: "/synthetic-archive",
    ARCHIVE_DIRECTORIES: { courseContents: "01_Course_Contents" },
    COURSE_NAME_HINT: "", COURSE_TERM_HINT: "", manifest: { warnings: [] },
    emitProgress: () => {}, ensureDir: () => {},
    prepareArchiveForRefresh: () => events.push("prepare archive"),
    runPhase: async (name, operation) => {
      if (name === "quizReviewFallbacks") throw stop;
      events.push(name);
      return operation();
    },
    bbJson: async (url) => {
      events.push(url);
      if (url === "/learn/api/v1/courses/_course_1") return { id: "_course_1" };
      if (url === "/learn/api/v1/users/me") return { id: "_student_1" };
      assert.equal(url, "/learn/api/v1/courses/_course_1/contents/_folder_1");
      if (detailError) throw detailError;
      return { id: "_folder_1" };
    },
    getAllPages: async (url) => {
      assert.match(url, /\/contents\/ROOT\/children\?/);
      events.push("ROOT request");
      return rootChildren;
    },
    primeGradeCache: async () => 0,
    saveAnnouncements: async () => events.push("save announcements"),
    processItem: async (item) => events.push(`process ${item.id}`),
  };
  vm.createContext(sandbox);
  vm.runInContext(mainSource, sandbox);
  await assert.rejects(sandbox.main(), (error) => error === stop);
  return events;
}

test("bootstrap checks content access before exports and reuses the root inventory", async () => {
  const events = await runThroughContent({ rootChildren: [{ id: "_folder_1" }, { id: "_folder_2" }] });
  assert.equal(events.filter((event) => event === "ROOT request").length, 1);
  const probeIndex = events.indexOf("/learn/api/v1/courses/_course_1/contents/_folder_1");
  assert.ok(probeIndex >= 0);
  assert.ok(probeIndex < events.indexOf("save announcements"));
  assert.ok(probeIndex < events.indexOf("prepare archive"));
  assert.ok(events.includes("process _folder_1"));
  assert.ok(events.includes("process _folder_2"));
});

test("empty courses continue without probing a nonexistent child", async () => {
  const events = await runThroughContent({ rootChildren: [] });
  assert.ok(events.includes("save announcements"));
  assert.equal(events.filter((event) => /\/contents\//.test(event)).length, 0);
});

for (const [status, message] of [
  [403, "This content item is not visible to the current user"],
  [404, MEMBERSHIP_DENIAL],
]) {
  test(`an isolated content error (${status}) does not reject the whole course`, async () => {
    const detailError = new Error(`GET /contents/_folder_1 failed: ${status} Error ${JSON.stringify({ status, message })}`);
    const events = await runThroughContent({ detailError });
    assert.ok(events.includes("save announcements"));
    assert.ok(events.includes("process _folder_1"));
  });
}
