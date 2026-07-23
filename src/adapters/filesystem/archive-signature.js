const path = require("path");
const { readJson } = require("./json-file-store");

function currentArchiveSignature(archiveRoot) {
  const root = path.resolve(archiveRoot);
  const inventory = readJson(path.join(root, "courses.json"), { courses: [] });
  return (inventory.courses || []).map((course) => {
    const courseRoot = path.resolve(root, String(course.outputDirectory || ""));
    const relative = path.relative(root, courseRoot);
    if (!course.outputDirectory || relative.startsWith("..") || path.isAbsolute(relative)) return `${course.id}:`;
    const generatedAt = readJson(path.join(courseRoot, "manifest.json"), {})?.generatedAt || course.existingArchive?.generatedAt || "";
    return `${course.id}:${generatedAt}`;
  }).join("|");
}

module.exports = { currentArchiveSignature };
