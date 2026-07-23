const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ARCHIVE_DIRECTORIES,
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
