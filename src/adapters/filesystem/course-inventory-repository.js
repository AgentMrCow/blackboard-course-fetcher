const fs = require("fs");
const path = require("path");
const { ensureDirectory, writeJson } = require("./json-file-store");

function markdownLink(label, relativePath) {
  return `[${String(label).replace(/\|/g, "\\|")}](<${String(relativePath).replace(/\\/g, "/")}>)`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

class CourseInventoryRepository {
  constructor({ archiveRoot }) {
    if (!archiveRoot) throw new TypeError("CourseInventoryRepository requires an archiveRoot");
    this.archiveRoot = path.resolve(archiveRoot);
  }

  ensureRoot() {
    ensureDirectory(this.archiveRoot);
  }

  assertContained(file) {
    const absolute = path.resolve(file);
    if (!isInside(this.archiveRoot, absolute)) {
      throw new Error("Course inventory path is outside the archive root");
    }
    if (fs.existsSync(this.archiveRoot)) {
      let existingAncestor = absolute;
      while (!fs.existsSync(existingAncestor) && isInside(this.archiveRoot, existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) break;
        existingAncestor = parent;
      }
      const realRoot = fs.realpathSync(this.archiveRoot);
      const realAncestor = fs.realpathSync(existingAncestor);
      if (!isInside(realRoot, realAncestor)) {
        throw new Error("Course inventory path is outside the archive root");
      }
    }
    return absolute;
  }

  courseLocation(pathSegments) {
    if (!Array.isArray(pathSegments) || pathSegments.length === 0) {
      throw new TypeError("Course inventory path requires at least one segment");
    }
    const outputPath = this.assertContained(path.resolve(this.archiveRoot, ...pathSegments));
    return {
      outputDirectory: path.relative(this.archiveRoot, outputPath),
      outputPath,
    };
  }

  readExistingArchive(outputPath) {
    try {
      const manifest = JSON.parse(fs.readFileSync(this.assertContained(path.join(outputPath, "manifest.json")), "utf8"));
      return {
        generatedAt: manifest.generatedAt || null,
        downloadMode: manifest.downloadMode || "full",
        coverageComplete: manifest.coverage?.complete === true,
        warnings: manifest.warnings?.length || 0,
        errors: manifest.errors?.length || 0,
      };
    } catch (error) {
      if (error.message === "Course inventory path is outside the archive root") throw error;
      return null;
    }
  }

  readArchivedCourses() {
    const indexPath = this.assertContained(path.join(this.archiveRoot, "courses.json"));
    if (!fs.existsSync(indexPath)) return [];
    let index;
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (!Array.isArray(index.courses)) throw new Error("courses must be an array");
    } catch (error) {
      throw new Error(`Cannot refresh an unreadable course inventory: ${error.message}`);
    }

    const archived = [];
    const seen = new Set();
    for (const course of index.courses) {
      if (!course?.id || typeof course.outputDirectory !== "string" || !course.outputDirectory || seen.has(course.id)) continue;
      const location = this.courseLocation([course.outputDirectory.replace(/\\/g, "/")]);
      const manifestPath = this.assertContained(path.join(location.outputPath, "manifest.json"));
      if (!fs.existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (error) {
        // An unreadable manifest is not evidence that an archive was removed.
        throw new Error(`Cannot inspect archived course ${course.id}: ${error.message}`);
      }
      if ((manifest.courseId || manifest.course?.id) !== course.id) continue;
      const existingArchive = this.readExistingArchive(location.outputPath);
      archived.push({
        id: course.id,
        externalId: course.externalId || null,
        name: course.name || manifest.course?.displayName || manifest.course?.name || course.id,
        term: { ...course.term, name: course.term?.name || "No Term", sourceName: course.term?.sourceName || course.term?.name || "No Term" },
        view: course.view || "UNKNOWN",
        hidden: course.hidden === true,
        lastAccessDate: course.lastAccessDate || null,
        ...location,
        existingArchive,
      });
      seen.add(course.id);
    }
    return archived;
  }

  save(index) {
    this.ensureRoot();
    const serializable = {
      ...index,
      courses: index.courses.map(({ outputPath, ...course }) => course),
    };
    writeJson(path.join(this.archiveRoot, "courses.json"), serializable);

    const lines = [
      "# Blackboard Course Archive",
      "",
      `Generated: ${index.generatedAt}`,
      `Courses in inventory: ${index.courses.length}`,
      `Current memberships: ${index.courses.filter((course) => course.membershipPresent !== false).length}`,
      `Local archives without current membership: ${index.courses.filter((course) => course.archiveOnly).length}`,
      `Selected this run: ${index.courses.filter((course) => course.selected).length}`,
      `Download mode: ${index.downloadMode}`,
      "",
    ];
    const terms = [...new Set(index.courses.map((course) => course.term.name))]
      .sort((left, right) => right.localeCompare(left));
    for (const term of terms) {
      lines.push(`## ${term}`, "", "| Course | View | Available | Fetch status | Archive |", "| --- | --- | --- | --- | --- |");
      for (const course of index.courses
        .filter((item) => item.term.name === term)
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const readme = path.join(course.outputDirectory, "README.md");
        const archive = fs.existsSync(path.join(this.archiveRoot, readme)) ? markdownLink("open", readme) : "-";
        lines.push(
          `| ${course.name.replace(/\|/g, "\\|")} | ${course.view} | ${course.available ? "yes" : "no"} | ${course.fetchStatus} | ${archive} |`
        );
      }
      lines.push("");
    }
    fs.writeFileSync(path.join(this.archiveRoot, "README.md"), `${lines.join("\n")}\n`, "utf8");
    return index;
  }
}

module.exports = { CourseInventoryRepository, markdownLink };
