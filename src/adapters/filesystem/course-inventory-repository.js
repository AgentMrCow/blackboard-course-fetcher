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
      const manifest = JSON.parse(fs.readFileSync(path.join(this.assertContained(outputPath), "manifest.json"), "utf8"));
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
