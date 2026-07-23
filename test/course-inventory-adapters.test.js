const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { BlackboardCourseMembershipGateway } = require("../src/adapters/blackboard/blackboard-course-membership-gateway");
const { CourseInventoryRepository } = require("../src/adapters/filesystem/course-inventory-repository");
const { PlaywrightStateRepository } = require("../src/adapters/filesystem/playwright-state-repository");

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "course-inventory-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Blackboard membership gateway retries and follows membership pagination", async () => {
  const requests = [];
  const delays = [];
  let userAttempts = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ options, url: String(url) });
    if (url.pathname.endsWith("/users/me")) {
      userAttempts += 1;
      if (userAttempts === 1) return new Response("busy", { status: 503 });
      return Response.json({ id: "_user_1" });
    }
    const offset = url.searchParams.get("offset");
    if (offset === "0") {
      return Response.json({
        results: [{ course: { id: "_course_1" } }],
        paging: { count: 2, nextPage: "/learn/api/v1/users/_user_1/memberships?limit=100&offset=1" },
      });
    }
    return Response.json({ results: [{ course: { id: "_course_2" } }], paging: { count: 2 } });
  };
  const gateway = new BlackboardCourseMembershipGateway({
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl,
    stateRepository: {
      load: () => ({
        cookies: [
          { name: "session", value: "expected", domain: ".example.edu", path: "/learn" },
          { name: "wrong", value: "private", domain: ".invalid.example", path: "/" },
        ],
      }),
    },
  });

  const memberships = await gateway.listMemberships({
    base: "https://blackboard.example.edu",
    stateFile: "/private/state.json",
  });

  assert.deepEqual(memberships.map((item) => item.course.id), ["_course_1", "_course_2"]);
  assert.deepEqual(delays, [500]);
  assert.equal(requests.length, 4);
  assert.equal(requests.every((request) => request.options.headers.Cookie === "session=expected"), true);
});

test("course inventory repository contains paths and preserves the public index schema", (context) => {
  const archiveRoot = temporaryDirectory(context);
  const repository = new CourseInventoryRepository({ archiveRoot });
  const location = repository.courseLocation(["2025-26", "1st Term", "TEST1000 - Test Course"]);
  fs.mkdirSync(location.outputPath, { recursive: true });
  fs.writeFileSync(path.join(location.outputPath, "manifest.json"), JSON.stringify({
    generatedAt: "2026-07-23T00:00:00.000Z",
    downloadMode: "placeholder",
    coverage: { complete: true },
    warnings: [{}],
    errors: [],
  }));
  fs.writeFileSync(path.join(location.outputPath, "README.md"), "# Course\n");

  assert.equal(repository.readExistingArchive(location.outputPath).coverageComplete, true);
  assert.throws(() => repository.courseLocation(["..", "outside"]), /outside the archive root/);
  const outside = path.join(path.dirname(archiveRoot), `${path.basename(archiveRoot)}-outside`);
  fs.mkdirSync(outside);
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(archiveRoot, "linked-term"));
  assert.throws(
    () => repository.courseLocation(["linked-term", "Outside Course"]),
    /outside the archive root/
  );

  const index = {
    generatedAt: "2026-07-23T08:00:00.000Z",
    downloadMode: "placeholder",
    courses: [{
      id: "_1_1",
      name: "Test Course",
      term: { name: "2025-26: 1st Term" },
      view: "ULTRA",
      available: true,
      selected: true,
      fetchStatus: "existing complete",
      outputDirectory: location.outputDirectory,
      outputPath: location.outputPath,
    }],
  };
  repository.save(index);
  const saved = JSON.parse(fs.readFileSync(path.join(archiveRoot, "courses.json"), "utf8"));
  assert.equal("outputPath" in saved.courses[0], false);
  const readme = fs.readFileSync(path.join(archiveRoot, "README.md"), "utf8");
  assert.match(readme, /## 2025-26: 1st Term/);
  assert.match(readme, /\[open\]/);
});

test("Playwright state repository reads storage state without exposing it elsewhere", (context) => {
  const root = temporaryDirectory(context);
  const file = path.join(root, "state.json");
  fs.writeFileSync(file, JSON.stringify({ cookies: [{ name: "session", value: "private" }] }));
  const repository = new PlaywrightStateRepository();
  assert.equal(repository.exists(file), true);
  assert.equal(repository.load(file).cookies[0].value, "private");
});
