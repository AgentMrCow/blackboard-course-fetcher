const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ARCHIVE_DIRECTORIES,
  createArchiveLayout,
  knownTopLevelDirectory,
  migrateLegacyArchiveLayout,
  relativeDirectoryForAncestors,
  relativeDirectoryForItem,
} = require("../src/adapters/filesystem/blackboard-archive-layout");

test("recognizes known categories without depending on case or separators", () => {
  assert.equal(knownTopLevelDirectory(" Course-Outline "), ARCHIVE_DIRECTORIES.courseOutline);
  assert.equal(knownTopLevelDirectory("COURSE_CONTENTS"), ARCHIVE_DIRECTORIES.courseContents);
  assert.equal(knownTopLevelDirectory("Library"), ARCHIVE_DIRECTORIES.library);
  assert.equal(ARCHIVE_DIRECTORIES.library, "08_Library");
});

test("migrates the old numbered directories without collisions", (context) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-layout-"));
  context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const previousManifest = {
    schemaVersion: 4,
    downloads: [
      { path: "02_Library/link.url" },
      { path: "03_Announcements/week-1/announcement.txt" },
      { path: "08_Achievements/achievements.json" },
    ],
  };
  const fixtures = [
    ["02_Library/link.url", "library"],
    ["03_Announcements/week-1/announcement.txt", "announcement"],
    ["04_Calendar/calendar.json", "calendar"],
    ["05_Discussions/discussions.json", "discussions"],
    ["06_Messages/messages.json", "messages"],
    ["07_Groups/groups.json", "groups"],
    ["08_Achievements/achievements.json", "achievements"],
  ];
  for (const [relativePath, contents] of fixtures) {
    const file = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  const migrated = migrateLegacyArchiveLayout(outputRoot, previousManifest);

  assert.equal(migrated.length, 7);
  assert.equal(fs.readFileSync(path.join(outputRoot, "02_Announcements/week-1/announcement.txt"), "utf8"), "announcement");
  assert.equal(fs.readFileSync(path.join(outputRoot, "03_Calendar/calendar.json"), "utf8"), "calendar");
  assert.equal(fs.readFileSync(path.join(outputRoot, "07_Achievements/achievements.json"), "utf8"), "achievements");
  assert.equal(fs.readFileSync(path.join(outputRoot, "08_Library/link.url"), "utf8"), "library");
  assert.deepEqual(previousManifest.downloads.map((item) => item.path), [
    "08_Library/link.url",
    "02_Announcements/week-1/announcement.txt",
    "07_Achievements/achievements.json",
  ]);
});

test("collapses known Blackboard wrapper folders into fixed archive categories", () => {
  assert.equal(
    relativeDirectoryForAncestors(["Course Contents", "Week 1"]),
    path.join("01_Course_Contents", "Week 1")
  );
  assert.equal(
    relativeDirectoryForItem([], "Course Outline", true),
    "00_Course_Outline"
  );
});

test("places every unknown top-level folder under course contents", () => {
  assert.equal(
    relativeDirectoryForAncestors(["Lectures", "Week 1"]),
    path.join("01_Course_Contents", "Lectures", "Week 1")
  );
  assert.equal(
    relativeDirectoryForItem([], "Final Project", true),
    path.join("01_Course_Contents", "Final Project")
  );
});

test("does not reinterpret known category words below the top level", () => {
  assert.equal(
    relativeDirectoryForAncestors(["Lectures", "Course Outline"]),
    path.join("01_Course_Contents", "Lectures", "Course Outline")
  );
});

test("sanitizes Blackboard titles used as path components", () => {
  assert.equal(
    relativeDirectoryForItem([], "Labs: FPGA/SoC", true),
    path.join("01_Course_Contents", "Labs FPGA SoC")
  );
});

for (const [label, titles] of [
  ["identical", ["Lecture", "Lecture"]],
  ["case-insensitive", ["Verbal reasoning test", "Verbal Reasoning Test"]],
  ["sanitized", ["Lab: FPGA/SoC", "Lab FPGA SoC"]],
  ["truncated", ["x".repeat(151) + "a", "x".repeat(151) + "b"]],
  ["Unicode-normalized", ["ＡＢＣ", "ABC"]],
]) {
  test(`allocates separate fixed-name content files for ${label} titles`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-content-paths-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const layout = createArchiveLayout(root);
    const directories = titles.map((title, index) => layout.registerItem({ id: `item-${index}`, title }));
    assert.notEqual(directories[0].normalize("NFKC").toLowerCase(), directories[1].normalize("NFKC").toLowerCase());
    for (let index = 0; index < directories.length; index += 1) {
      fs.mkdirSync(directories[index], { recursive: true });
      fs.writeFileSync(path.join(directories[index], "document.html"), `body ${index}`);
      assert.equal(layout.directoryForItem([], titles[index], true, `item-${index}`), directories[index]);
    }
    assert.equal(fs.readFileSync(path.join(directories[0], "document.html"), "utf8"), "body 0");
    assert.equal(fs.readFileSync(path.join(directories[1], "document.html"), "utf8"), "body 1");
    assert.equal(path.dirname(directories[0]), path.join(root, ARCHIVE_DIRECTORIES.courseContents));
  });
}

test("collision allocation follows parent IDs through distinct folder subtrees", () => {
  const root = path.resolve("synthetic-course");
  const layout = createArchiveLayout(root);
  const left = layout.registerItem({ id: "folder-a", title: "Week 1", container: true });
  const right = layout.registerItem({ id: "folder-b", title: "WEEK 1", container: true });
  for (const [id, directory] of [["folder-a", left], ["folder-b", right]]) {
    const document = layout.registerItem({ id: `${id}-document`, parentId: id, ancestors: ["Week 1"], title: "Notes" });
    const file = layout.registerItem({ id: `${id}-file`, parentId: id, ancestors: ["Week 1"], title: "Slides", ownDirectory: false });
    assert.equal(path.dirname(document), directory);
    assert.equal(file, directory);
  }
});

for (const handler of ["resource/x-bb-document", "resource/x-bb-file", "resource/x-bb-folder"]) {
  test(`refetch preserves ${handler} paths when same-title traversal order changes`, () => {
    const root = path.resolve("synthetic-course");
    const first = createArchiveLayout(root);
    const previousContents = ["a", "b"].map((id) => ({
      id, title: "Lecture", handler, ownDirectory: true,
      container: handler === "resource/x-bb-folder",
      directory: path.relative(root, first.registerItem({ id, title: "Lecture" })),
    }));
    const refetch = createArchiveLayout(root, { previousContents });
    for (const item of [...previousContents].reverse()) {
      const directory = refetch.registerItem(item);
      assert.equal(path.relative(root, directory), item.directory);
    }
  });
}

test("legacy shared file directories do not reserve the parent folder twice", () => {
  const root = path.resolve("synthetic-course");
  const previousContents = [
    { id: "file", parentId: "folder", handler: "resource/x-bb-file", directory: "01_Course_Contents/Week 1" },
    { id: "folder", handler: "resource/x-bb-folder", directory: "01_Course_Contents/Week 1", container: true },
  ];
  const layout = createArchiveLayout(root, { previousContents });
  assert.equal(layout.registerItem({ id: "folder", title: "Week 1", container: true }), path.join(root, previousContents[1].directory));
  assert.equal(layout.registerItem({ id: "file", parentId: "folder", title: "Slides", ownDirectory: false }), path.join(root, previousContents[1].directory));
});

test("existing paths remain reserved for old IDs before a new same-title item is visited", () => {
  const root = path.resolve("synthetic-course");
  const existing = path.join("01_Course_Contents", "Notes");
  const layout = createArchiveLayout(root, { previousContents: [{ id: "old", directory: existing }] });
  const added = layout.registerItem({ id: "new", title: "Notes" });
  assert.notEqual(path.relative(root, added), existing);
  assert.equal(path.relative(root, layout.registerItem({ id: "old", title: "Notes" })), existing);
});

test("duplicate canonical wrappers use separate subfolders and survive reverse refetch", () => {
  const root = path.resolve("synthetic-course");
  const first = createArchiveLayout(root);
  const previousContents = ["a", "b"].map((id) => {
    const item = { id, title: "Course Contents", container: true, ownDirectory: true };
    return { ...item, directory: path.relative(root, first.registerItem(item)) };
  });
  assert.equal(previousContents[0].directory, ARCHIVE_DIRECTORIES.courseContents);
  assert.equal(path.dirname(previousContents[1].directory), ARCHIVE_DIRECTORIES.courseContents);
  const refetch = createArchiveLayout(root, { previousContents });
  for (const item of [...previousContents].reverse()) {
    assert.equal(path.relative(root, refetch.registerItem(item)), item.directory);
  }
});

test("invalid previous paths cannot redirect items outside the archive", () => {
  const root = path.resolve("synthetic-course");
  const layout = createArchiveLayout(root, { previousContents: [{ id: "item", directory: "../outside" }] });
  assert.equal(layout.registerItem({ id: "item", title: "Notes" }), path.join(root, "01_Course_Contents", "Notes"));
});

test("known top-level documents retain their canonical category without requiring a wrapper", () => {
  const root = path.resolve("synthetic-course");
  const previousContents = [{ id: "outline", handler: "resource/x-bb-document", directory: "00_Course_Outline" }];
  const layout = createArchiveLayout(root, { previousContents });
  const added = layout.registerItem({ id: "new-outline", title: "Course Syllabus" });
  assert.equal(path.dirname(added), path.join(root, "00_Course_Outline"));
  assert.equal(layout.registerItem({ id: "outline", title: "Course Outline" }), path.join(root, "00_Course_Outline"));
});
