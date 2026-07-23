const { artifactCountSummary } = require("../../domain/archive/archive-artifact");

function buildArchiveFileIndex({ archiveService, clock = () => new Date(), onProgress = () => {} }) {
  const inventory = archiveService.getInventory();
  const archivedCourses = inventory.courses.filter((course) => course.archive.exists);
  const courses = {};
  const files = [];
  const searchDocuments = {};
  let bytes = 0;
  let scannedCourses = 0;
  for (const course of archivedCourses) {
    const indexedCourse = archiveService.indexCourseFiles(course.id);
    const courseFiles = indexedCourse.files.map((file) => ({
      ...file,
      courseId: course.id,
      courseCode: course.code,
      courseName: course.name,
    }));
    courses[course.id] = courseFiles.map(({ courseId, courseCode, courseName, ...file }) => file);
    const courseSearchDocuments = indexedCourse.searchDocuments;
    if (Object.keys(courseSearchDocuments).length) searchDocuments[course.id] = courseSearchDocuments;
    files.push(...courseFiles);
    bytes += courseFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
    scannedCourses += 1;
    onProgress({ scannedCourses, totalCourses: archivedCourses.length, fileCount: files.length });
  }
  files.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)) || left.path.localeCompare(right.path));
  const artifactCounts = artifactCountSummary(files);
  return {
    schemaVersion: 3,
    generatedAt: clock().toISOString(),
    archiveRoot: archiveService.archiveRoot,
    inventoryGeneratedAt: inventory.generatedAt,
    archiveSignature: inventory.courses.map((course) => `${course.id}:${course.archive.generatedAt || ""}`).join("|"),
    courseCount: Object.keys(courses).length,
    fileCount: files.length,
    bytes,
    artifactCounts,
    courses,
    files,
    searchDocuments,
  };
}

module.exports = { buildArchiveFileIndex };
