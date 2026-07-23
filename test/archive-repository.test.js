const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  archiveBasename,
  compactCourseName,
  fileCategory,
  fileExtension,
  mimeType,
  previewKind,
} = require("../src/domain/archive/archive-metadata");
const { FileSystemArchiveRepository } = require("../src/adapters/filesystem/archive-repository");

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("archive metadata policy is platform-independent", () => {
  assert.equal(archiveBasename("01_Course_Contents\\Week 1\\slides.PDF"), "slides.PDF");
  assert.equal(fileExtension("slides.PDF"), ".pdf");
  assert.equal(mimeType("slides.PDF"), "application/pdf");
  assert.equal(mimeType("quiz.h5p"), "application/zip");
  assert.equal(previewKind("slides.pdf.placeholder.json"), "placeholder");
  assert.equal(previewKind("submission.DOCX"), "office");
  assert.equal(previewKind("quiz.h5p"), "archive");
  assert.equal(fileCategory("01_Course_Contents/Week 1/slides.pdf"), "Course content");
  assert.equal(compactCourseName({ externalId: "2025R1-SEEM3450-ULTRA" }), "SEEM3450");
});

test("archive repository rejects traversal and a course-root symlink outside the archive", (context) => {
  const root = temporaryDirectory(context, "blackboard-archive-repository-");
  const outside = temporaryDirectory(context, "blackboard-outside-course-");
  const repository = new FileSystemArchiveRepository({ archiveRoot: root });
  assert.throws(() => repository.coursePath({ id: "root", outputDirectory: "." }), /Unsafe or missing/);
  assert.throws(() => repository.coursePath({ id: "traversal", outputDirectory: "../outside" }), /Unsafe or missing/);

  fs.symlinkSync(outside, path.join(root, "linked-course"), "dir");
  assert.throws(() => repository.coursePath({ id: "linked", outputDirectory: "linked-course" }), /Unsafe or missing/);
});

test("archive repository lists files and reads only contained course records", (context) => {
  const root = temporaryDirectory(context, "blackboard-contained-course-");
  const course = { id: "_1_1", outputDirectory: "2025-26/1st Term/Test Course" };
  const courseRoot = path.join(root, course.outputDirectory);
  fs.mkdirSync(path.join(courseRoot, "01_Course_Contents"), { recursive: true });
  fs.mkdirSync(path.join(courseRoot, "02_Announcements", "Notice"), { recursive: true });
  fs.writeFileSync(path.join(courseRoot, "01_Course_Contents", "notes.txt"), "searchable notes");
  fs.writeFileSync(path.join(courseRoot, "gradebook.json"), JSON.stringify({ items: [{ id: "grade" }] }));
  fs.writeFileSync(path.join(courseRoot, "02_Announcements", "Notice", "announcement.txt"), "Important update");
  fs.writeFileSync(path.join(courseRoot, "02_Announcements", "Notice", "announcement.html"), "<p>Important update</p>");
  const repository = new FileSystemArchiveRepository({ archiveRoot: root });

  assert.equal(repository.listCourseFiles(course).some((file) => file.path === "01_Course_Contents/notes.txt"), true);
  assert.equal(repository.readCourseJson(course, ["gradebook.json"], null).items[0].id, "grade");
  assert.equal(repository.readCourseText(course, "01_Course_Contents/notes.txt"), "searchable notes");
  assert.deepEqual(repository.loadAnnouncement(course, { directory: "02_Announcements/Notice" }), {
    directory: "02_Announcements/Notice",
    text: "Important update",
    htmlPath: "02_Announcements/Notice/announcement.html",
  });
  assert.throws(() => repository.readCourseText(course, "../../secret.txt"), /Invalid archive file path/);
});

test("archive repository classifies legacy files by manifest provenance and indexes one search representation", (context) => {
  const root = temporaryDirectory(context, "blackboard-artifact-provenance-");
  const course = { id: "_2_1", outputDirectory: "2025-26/1st Term/Provenance Course" };
  const courseRoot = path.join(root, course.outputDirectory);
  const assessmentDirectory = "01_Course_Contents/Assignments/Project";
  const linkDirectory = "01_Course_Contents/Reference Site";
  fs.mkdirSync(path.join(courseRoot, assessmentDirectory), { recursive: true });
  fs.mkdirSync(path.join(courseRoot, linkDirectory), { recursive: true });
  fs.writeFileSync(path.join(courseRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 8,
    downloads: [
      { path: "01_Course_Contents/notes.txt", sourceUrl: "https://blackboard.example.edu/notes.txt" },
      { path: `${linkDirectory}/Reference Site.url`, linkOnly: true },
      { path: `${linkDirectory}/external_snapshot.html`, externalSnapshot: true },
    ],
    assessments: [{ contentId: "_content_1", title: "Project", directory: assessmentDirectory }],
    contents: [{
      id: "_content_2",
      title: "Reference Site",
      directory: linkDirectory,
      files: [`${linkDirectory}/Reference Site.url`],
    }],
  }));
  fs.writeFileSync(path.join(courseRoot, "01_Course_Contents", "notes.txt"), "original Blackboard notes");
  fs.writeFileSync(path.join(courseRoot, assessmentDirectory, "instructions.html"), "<p>Submit a report</p>");
  fs.writeFileSync(path.join(courseRoot, assessmentDirectory, "instructions.txt"), "Submit a report");
  fs.writeFileSync(path.join(courseRoot, linkDirectory, "Reference Site.url"), "[InternetShortcut]\nURL=https://example.edu\n");
  fs.writeFileSync(path.join(courseRoot, linkDirectory, "Reference Site.html"), "<a href=\"https://example.edu\">Reference Site</a>");
  fs.writeFileSync(path.join(courseRoot, linkDirectory, "external_snapshot.html"), "<p>External snapshot</p>");
  fs.writeFileSync(path.join(courseRoot, "README.md"), "# Generated summary");
  fs.writeFileSync(path.join(courseRoot, "personal-notes.md"), "Local addition");
  const repository = new FileSystemArchiveRepository({ archiveRoot: root });

  const indexed = repository.indexCourseFiles(course);
  const files = new Map(indexed.files.map((file) => [file.path, file]));
  const original = files.get("01_Course_Contents/notes.txt");
  const instructionsHtml = files.get(`${assessmentDirectory}/instructions.html`);
  const instructionsText = files.get(`${assessmentDirectory}/instructions.txt`);

  assert.equal(original.origin, "blackboard-original");
  assert.equal(original.hiddenByDefault, false);
  assert.equal(instructionsHtml.origin, "blackboard-content-export");
  assert.equal(instructionsHtml.logicalItemTitle, "Project");
  assert.equal(instructionsText.origin, "derived-search-text");
  assert.equal(instructionsText.primaryPath, instructionsHtml.path);
  assert.equal(files.get("README.md").origin, "fetcher-record");
  assert.equal(files.get("personal-notes.md").origin, "local-file");
  assert.equal(files.get(`${linkDirectory}/Reference Site.html`).role, "external-link-rendered");
  assert.equal(files.get(`${linkDirectory}/Reference Site.html`).primaryPath, `${linkDirectory}/Reference Site.url`);
  assert.equal(files.get(`${linkDirectory}/external_snapshot.html`).origin, "external-resource");
  assert.equal(files.get(`${linkDirectory}/external_snapshot.html`).hiddenByDefault, true);
  assert.equal(indexed.searchDocuments[instructionsText.path], "Submit a report");
  assert.equal(indexed.searchDocuments["README.md"], undefined);
  assert.equal(indexed.searchDocuments["manifest.json"], undefined);
});
