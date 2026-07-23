const test = require("node:test");
const assert = require("node:assert/strict");
const { ArchiveService } = require("../src/application/archive/archive-service");
const { buildArchiveFileIndex } = require("../src/application/archive/build-file-index");

function memoryArchiveRepository() {
  const course = {
    id: "_1_1",
    externalId: "2025R1-SEEM3450-ULTRA",
    name: "Engineering Innovation",
    outputDirectory: "2025-26/1st Term/SEEM3450",
    term: { name: "2025-26: 1st Term" },
  };
  const manifest = {
    generatedAt: "2026-07-23T00:00:00.000Z",
    downloadMode: "full",
    coverage: { complete: true },
    contents: [{ id: "content" }],
    assessments: [{
      id: "assessment",
      title: "Project",
      dueDate: "2026-07-24T01:00:00.000Z",
      grade: { submissionStatus: "DRAFT", pointsPossible: 20 },
    }],
    announcements: [{ id: "announcement", directory: "02_Announcements/Notice", postedAt: "2026-07-22T00:00:00.000Z" }],
    gradebook: { items: [{ id: "grade" }] },
    downloads: [{ path: "01_Course_Contents/notes.txt", size: 17, contentType: "text/plain" }],
    errors: [],
    warnings: [],
    timings: { totalMs: 30_000 },
    transfer: { networkBytes: 17, reusedBytes: 0 },
  };
  const files = [{
    path: "01_Course_Contents/notes.txt",
    name: "notes.txt",
    extension: ".txt",
    category: "Course content",
    size: 17,
    modifiedAt: "2026-07-23T00:00:00.000Z",
    mimeType: "text/plain; charset=utf-8",
    preview: "text",
  }];
  return {
    archiveRoot: "/memory/archive",
    courseExists: () => true,
    coursePath: () => "/memory/archive/course",
    courseVersion: () => "course-v1",
    inventoryFile: () => "/memory/archive/courses.json",
    inventoryVersion: () => "inventory-v1",
    indexCourseFiles: () => ({ files, searchDocuments: { [files[0].path]: "value proposition workshop" } }),
    listCourseFiles: () => files,
    loadAnnouncement: (_course, announcement) => ({ ...announcement, text: "Important update", htmlPath: null }),
    loadFailedManifest: () => null,
    loadManifest: () => manifest,
    matchesRoot: (candidate) => candidate === "/memory/archive",
    readCourseJson: (_course, candidates, fallback) => candidates.includes("gradebook.json") ? manifest.gradebook : fallback,
    readCourseText: (_course, relativePath, fallback) => relativePath === files[0].path ? "value proposition workshop" : fallback,
    readInventory: () => ({ generatedAt: manifest.generatedAt, courses: [course] }),
    resolveCourseFile: (_course, relativePath) => ({ course, root: "/memory/archive/course", file: `/memory/${relativePath}`, relativePath }),
    setRoot(value) {
      this.archiveRoot = value;
    },
  };
}

test("archive query service enriches inventory through the repository port", () => {
  const service = new ArchiveService({
    archiveRepository: memoryArchiveRepository(),
    clock: () => new Date("2026-07-23T02:00:00.000Z"),
  });
  const inventory = service.getInventory();

  assert.equal(inventory.inventoryCount, 1);
  assert.equal(inventory.courses[0].code, "SEEM3450");
  assert.equal(inventory.courses[0].archive.status, "complete");
  assert.equal(inventory.courses[0].archive.bytes, 17);
  assert.deepEqual(inventory.terms, ["2025-26: 1st Term"]);
});

test("archive query service builds course, summary, file, and search views without filesystem access", () => {
  const service = new ArchiveService({ archiveRepository: memoryArchiveRepository() });
  const course = service.getCourse("_1_1");
  const summary = service.summary();

  assert.equal(course.announcements[0].text, "Important update");
  assert.equal(course.assessments[0].status, "DRAFT");
  assert.equal(summary.archivedCount, 1);
  assert.equal(summary.files, 1);
  assert.equal(summary.deadlines[0].title, "Project");
  assert.equal(service.allFiles({ preview: "text" }).total, 1);
  assert.equal(service.search("proposition")[0].path, "01_Course_Contents/notes.txt");
});

test("archive query service accepts only matching external file indexes", () => {
  const service = new ArchiveService({ archiveRepository: memoryArchiveRepository() });
  assert.equal(service.setFileIndex({ archiveRoot: "/other", courses: {} }), false);
  assert.equal(service.setFileIndex({
    archiveRoot: "/memory/archive",
    courses: { "_1_1": [] },
    files: [],
    fileCount: 0,
    bytes: 0,
  }), true);
  assert.deepEqual(service.listFiles("_1_1"), []);
});

test("archive queries hide support artifacts by default and deduplicate derived search results", () => {
  const repository = memoryArchiveRepository();
  const original = repository.listCourseFiles()[0];
  const instructionsHtml = {
    ...original,
    path: "01_Course_Contents/Project/instructions.html",
    name: "instructions.html",
    preview: "html",
    origin: "blackboard-content-export",
    role: "instructions-rendered",
    hiddenByDefault: true,
    searchable: false,
    groupKey: "01_Course_Contents/Project/instructions.html",
    primaryPath: "01_Course_Contents/Project/instructions.html",
    logicalItemTitle: "Project",
  };
  const instructionsText = {
    ...original,
    path: "01_Course_Contents/Project/instructions.txt",
    name: "instructions.txt",
    preview: "text",
    origin: "derived-search-text",
    role: "instructions-search-text",
    hiddenByDefault: true,
    searchable: true,
    groupKey: instructionsHtml.groupKey,
    primaryPath: instructionsHtml.path,
    logicalItemTitle: "Project",
  };
  const readme = {
    ...original,
    path: "README.md",
    name: "README.md",
    origin: "fetcher-record",
    role: "archive-summary",
    hiddenByDefault: true,
    searchable: false,
    groupKey: "README.md",
    primaryPath: "README.md",
  };
  const files = [original, instructionsHtml, instructionsText, readme];
  repository.listCourseFiles = () => files;
  repository.readCourseText = (_course, relativePath, fallback) =>
    relativePath === instructionsText.path ? "Submit the value proposition report" : fallback;
  const service = new ArchiveService({ archiveRepository: repository });

  assert.equal(service.allFiles().total, 1);
  assert.equal(service.allFiles({ scope: "exports" }).total, 1);
  assert.equal(service.allFiles({ scope: "records" }).total, 1);
  assert.equal(service.allFiles({ scope: "all" }).total, 4);
  const matches = service.search("submit");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, instructionsHtml.path);
  assert.equal(matches[0].title, "Project");
  assert.equal(matches[0].origin, "blackboard-content-export");
  assert.equal(matches[0].size, instructionsHtml.size);
});

test("file-index use case builds schema v3 with artifact counts through archive query ports", () => {
  const service = new ArchiveService({ archiveRepository: memoryArchiveRepository() });
  const progress = [];
  const index = buildArchiveFileIndex({
    archiveService: service,
    clock: () => new Date("2026-07-23T03:00:00.000Z"),
    onProgress: (event) => progress.push(event),
  });

  assert.equal(index.schemaVersion, 3);
  assert.equal(index.generatedAt, "2026-07-23T03:00:00.000Z");
  assert.equal(index.fileCount, 1);
  assert.equal(index.bytes, 17);
  assert.deepEqual(index.artifactCounts.materials, { files: 1, bytes: 17 });
  assert.equal(index.searchDocuments["_1_1"]["01_Course_Contents/notes.txt"], "value proposition workshop");
  assert.deepEqual(progress, [{ scannedCourses: 1, totalCourses: 1, fileCount: 1 }]);
});
