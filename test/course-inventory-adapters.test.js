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

test("archived inventory rows require a matching local manifest and reject escaping metadata", (context) => {
  const archiveRoot = temporaryDirectory(context);
  const repository = new CourseInventoryRepository({ archiveRoot });
  const rows = ["valid", "deleted", "empty", "wrong-id"].map((id) => ({ id, name: id, outputDirectory: id }));
  fs.writeFileSync(path.join(archiveRoot, "courses.json"), JSON.stringify({ courses: rows }));
  for (const id of ["valid", "empty", "wrong-id"]) fs.mkdirSync(path.join(archiveRoot, id));
  fs.writeFileSync(path.join(archiveRoot, "valid", "manifest.json"), JSON.stringify({ courseId: "valid" }));
  fs.writeFileSync(path.join(archiveRoot, "wrong-id", "manifest.json"), JSON.stringify({ courseId: "someone-else" }));
  assert.deepEqual(repository.readArchivedCourses().map((item) => item.id), ["valid"]);

  const outside = temporaryDirectory(context);
  const outsideManifest = path.join(outside, "manifest.json");
  fs.writeFileSync(outsideManifest, JSON.stringify({ courseId: "empty" }));
  fs.symlinkSync(outsideManifest, path.join(archiveRoot, "empty", "manifest.json"));
  assert.throws(() => repository.readArchivedCourses(), /outside the archive root/);
  assert.throws(() => repository.readExistingArchive(path.join(archiveRoot, "empty")), /outside the archive root/);
});

test("unreadable archived manifests stop inventory replacement instead of silently dropping the course", (context) => {
  const archiveRoot = temporaryDirectory(context);
  const repository = new CourseInventoryRepository({ archiveRoot });
  fs.mkdirSync(path.join(archiveRoot, "course"));
  fs.writeFileSync(path.join(archiveRoot, "courses.json"), JSON.stringify({ courses: [{ id: "course", outputDirectory: "course" }] }));
  fs.writeFileSync(path.join(archiveRoot, "course", "manifest.json"), "{");
  assert.throws(() => repository.readArchivedCourses(), /Cannot inspect archived course course/);
});

test("archived inventory paths survive moving a Windows catalog to another platform", (context) => {
  const archiveRoot = temporaryDirectory(context);
  const repository = new CourseInventoryRepository({ archiveRoot });
  const segments = ["2025-26", "1st Term", "Example Course"];
  const courseDirectory = path.join(archiveRoot, ...segments);
  fs.mkdirSync(courseDirectory, { recursive: true });
  fs.writeFileSync(path.join(courseDirectory, "manifest.json"), JSON.stringify({ courseId: "course" }));
  fs.writeFileSync(path.join(archiveRoot, "courses.json"), JSON.stringify({
    courses: [{ id: "course", outputDirectory: segments.join("\\") }],
  }));
  const [course] = repository.readArchivedCourses();
  assert.equal(course.id, "course");
  assert.equal(course.outputPath, courseDirectory);
  assert.equal(course.outputDirectory, path.join(...segments));
});
