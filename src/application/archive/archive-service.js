const { httpError } = require("../../shared/http-error");
const {
  ARTIFACT_ORIGINS,
  artifactCountSummary,
  artifactMatchesScope,
  createArtifactClassifier,
} = require("../../domain/archive/archive-artifact");
const {
  TEXT_EXTENSIONS,
  archiveBasename,
  compactCourseName,
  displayTerm,
  fileCategory,
  fileExtension,
  mimeType,
  normalizeArchivePath,
  previewKind,
} = require("../../domain/archive/archive-metadata");
const {
  effectiveArchiveCoverage,
} = require("../../domain/archive/archive-coverage");

class ArchiveService {
  constructor({ archiveRepository, clock = () => new Date() }) {
    if (!archiveRepository) throw new TypeError("ArchiveService requires an archiveRepository");
    this.archiveRepository = archiveRepository;
    this.clock = clock;
    this.fileCache = new Map();
    this.setRoot(archiveRepository.archiveRoot);
  }

  nowMs() {
    return this.clock().getTime();
  }

  setRoot(archiveRoot) {
    this.archiveRepository.setRoot(archiveRoot);
    this.archiveRoot = this.archiveRepository.archiveRoot;
    this.fileCache?.clear();
    this.manifestCache = new Map();
    this.inventoryCache = null;
    this.summaryCache = null;
    this.externalFileIndex = null;
  }

  invalidate(options = {}) {
    this.fileCache.clear();
    this.manifestCache.clear();
    this.inventoryCache = null;
    this.summaryCache = null;
    if (options.fileIndex === true) this.externalFileIndex = null;
  }

  setFileIndex(index) {
    if (!index || !this.archiveRepository.matchesRoot(index.archiveRoot) || !index.courses) return false;
    this.externalFileIndex = index;
    this.fileCache.clear();
    this.summaryCache = null;
    return true;
  }

  inventoryFile() {
    return this.archiveRepository.inventoryFile();
  }

  rawInventory() {
    const inventory = this.archiveRepository.readInventory();
    return inventory && Array.isArray(inventory.courses)
      ? inventory
      : {
          schemaVersion: 1,
          generatedAt: null,
          blackboardBase: null,
          downloadMode: "placeholder",
          inventoryCount: 0,
          courses: [],
        };
  }

  coursePath(course) {
    return this.archiveRepository.coursePath(course);
  }

  loadManifest(course) {
    const key = course.id;
    if (this.manifestCache.has(key)) return this.manifestCache.get(key);
    const manifest = this.archiveRepository.loadManifest(course);
    this.manifestCache.set(key, manifest);
    return manifest;
  }

  enrichCourse(course) {
    const manifest = this.loadManifest(course);
    const failedManifest = this.archiveRepository.loadFailedManifest(course);
    const effectiveCoverage = effectiveArchiveCoverage(manifest);
    const archiveExists = Boolean(manifest || this.archiveRepository.courseExists(course));
    const generatedAt = manifest?.generatedAt || course.existingArchive?.generatedAt || null;
    const errors = manifest?.errors?.length ?? failedManifest?.errors?.length ?? course.existingArchive?.errors ?? 0;
    const warnings = manifest?.warnings?.length ?? course.existingArchive?.warnings ?? 0;
    const status = !archiveExists
      ? "not_fetched"
      : failedManifest && !manifest
        ? "failed"
        : effectiveCoverage.complete
          ? "complete"
          : "incomplete";
    return {
      ...course,
      code: compactCourseName(course),
      termName: displayTerm(course),
      archive: {
        exists: archiveExists,
        status,
        generatedAt,
        downloadMode: manifest?.downloadMode || course.existingArchive?.downloadMode || null,
        coverageComplete: effectiveCoverage.complete,
        coverageReportedComplete: effectiveCoverage.reportedComplete,
        coverageIssue: effectiveCoverage.issue,
        coverageIssueCode: effectiveCoverage.issueCode,
        coverageIssues: effectiveCoverage.issues,
        coverageIssueCodes: effectiveCoverage.issueCodes,
        errors,
        warnings,
        contentCount: manifest?.contents?.length || 0,
        fileCount: manifest?.downloads?.length || 0,
        assessmentCount: manifest?.assessments?.length || 0,
        announcementCount: manifest?.announcements?.length || 0,
        gradeCount: manifest?.gradebook?.items?.length || 0,
        totalMs: manifest?.timings?.totalMs || null,
        bytes: manifest?.transfer
          ? Number(manifest.transfer.networkBytes || 0) + Number(manifest.transfer.reusedBytes || 0)
          : null,
      },
    };
  }

  getInventory() {
    const cacheKey = this.archiveRepository.inventoryVersion();
    if (this.inventoryCache?.key === cacheKey) {
      return this.inventoryCache.value;
    }
    const inventory = this.rawInventory();
    const courses = inventory.courses.map((course) => this.enrichCourse(course));
    const value = {
      ...inventory,
      inventoryCount: courses.length,
      courses,
      terms: [...new Set(courses.map((course) => course.termName))],
    };
    this.inventoryCache = { key: cacheKey, cachedAt: this.nowMs(), value };
    return value;
  }

  getCourseRecord(courseId) {
    const course = this.rawInventory().courses.find((item) => item.id === courseId);
    if (!course) throw httpError(404, "Course not found in the local inventory");
    return course;
  }

  resolveCourseFile(courseId, relativePath) {
    const course = this.getCourseRecord(courseId);
    return this.archiveRepository.resolveCourseFile(course, relativePath);
  }

  readFileText(courseId, relativePath, fallback = "") {
    const course = this.getCourseRecord(courseId);
    return this.archiveRepository.readCourseText(course, relativePath, fallback);
  }

  listFiles(courseId) {
    const indexed = this.externalFileIndex?.courses?.[courseId];
    if (Array.isArray(indexed)) return indexed;
    const course = this.getCourseRecord(courseId);
    const cacheKey = this.archiveRepository.courseVersion(course);
    const cached = this.fileCache.get(courseId);
    if (cached?.key === cacheKey) return cached.files;
    const files = this.archiveRepository.listCourseFiles(course);
    this.fileCache.set(courseId, { key: cacheKey, files });
    return files;
  }

  indexCourseFiles(courseId) {
    const course = this.getCourseRecord(courseId);
    const indexed = this.archiveRepository.indexCourseFiles(course);
    const cacheKey = this.archiveRepository.courseVersion(course);
    this.fileCache.set(courseId, { key: cacheKey, files: indexed.files });
    return indexed;
  }

  loadAnnouncement(course, announcement) {
    return this.archiveRepository.loadAnnouncement(course, announcement);
  }

  getCourse(courseId) {
    const sourceCourse = this.getCourseRecord(courseId);
    const course = this.enrichCourse(sourceCourse);
    const manifest = this.loadManifest(sourceCourse);
    const failedManifest = this.archiveRepository.loadFailedManifest(sourceCourse);
    const gradebook = this.archiveRepository.readCourseJson(sourceCourse, ["gradebook.json"], manifest?.gradebook || null);
    const assessments = (manifest?.assessments || []).map((assessment) => ({
      ...assessment,
      status: assessment.grade?.submissionStatus || assessment.grade?.status || assessment.attempts?.at(-1)?.status || "NOT_STARTED",
      latestAttempt: assessment.attempts?.at(-1) || null,
    }));
    const announcements = (manifest?.announcements || [])
      .map((announcement) => this.loadAnnouncement(sourceCourse, announcement))
      .sort((left, right) => String(right.postedAt || right.createdDate || "").localeCompare(String(left.postedAt || left.createdDate || "")));
    return {
      course,
      manifest,
      failedManifest,
      gradebook,
      calendar: this.archiveRepository.readCourseJson(sourceCourse, ["03_Calendar/calendar.json", "04_Calendar/calendar.json"], { count: 0, items: [] }),
      discussions: this.archiveRepository.readCourseJson(sourceCourse, ["04_Discussions/discussions.json", "05_Discussions/discussions.json"], { count: 0, items: [], forums: [] }),
      messages: this.archiveRepository.readCourseJson(sourceCourse, ["05_Messages/messages.json", "06_Messages/messages.json"], { counts: { totalCount: 0, unreadCount: 0 }, conversations: [] }),
      groups: this.archiveRepository.readCourseJson(sourceCourse, ["06_Groups/groups.json", "07_Groups/groups.json"], { groupSets: [], accessibleGroups: [], totalGroups: 0, restrictedGroupCount: 0 }),
      achievements: this.archiveRepository.readCourseJson(sourceCourse, ["07_Achievements/achievements.json", "08_Achievements/achievements.json"], { count: 0, items: [] }),
      assessments,
      announcements,
      contents: manifest?.contents || [],
      files: this.listFiles(courseId),
      currentStatus: this.archiveRepository.readCourseText(sourceCourse, "CURRENT_STATUS.md", ""),
      readme: this.archiveRepository.readCourseText(sourceCourse, "README.md", ""),
    };
  }

  summary() {
    if (this.summaryCache) return this.summaryCache.value;
    const inventory = this.getInventory();
    const archived = inventory.courses.filter((course) => course.archive.exists);
    const deadlines = [];
    const announcements = [];
    const recentFiles = [];
    const fallbackIndexedFiles = [];
    let trackedBytes = 0;
    let trackedFiles = 0;
    for (const course of archived) {
      const manifest = this.loadManifest(course);
      const classifyArtifact = createArtifactClassifier(manifest || {});
      for (const assessment of manifest?.assessments || []) {
        if (!assessment.dueDate) continue;
        deadlines.push({
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          title: assessment.title,
          dueDate: assessment.dueDate,
          status: assessment.grade?.submissionStatus || assessment.grade?.status || assessment.attempts?.at(-1)?.status || "NOT_STARTED",
          score: assessment.grade?.score ?? null,
          pointsPossible: assessment.grade?.pointsPossible ?? assessment.possiblePoints ?? null,
        });
      }
      for (const announcement of manifest?.announcements || []) {
        announcements.push({
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          ...announcement,
        });
      }
      const managedFiles = new Map();
      for (const download of manifest?.downloads || []) {
        if (!download.path || managedFiles.has(download.path)) continue;
        managedFiles.set(download.path, download);
      }
      trackedFiles += managedFiles.size;
      trackedBytes += [...managedFiles.values()].reduce((sum, file) => sum + (Number(file.size) || 0), 0);
      for (const download of managedFiles.values()) {
        if (/\.annotations\.json$/i.test(download.path)) continue;
        const name = archiveBasename(download.path);
        const preview = previewKind(name);
        const file = {
          ...classifyArtifact(download.path),
          path: normalizeArchivePath(download.path),
          name,
          extension: fileExtension(name),
          category: fileCategory(download.path),
          size: Number(download.size) || null,
          modifiedAt: download.lastModified || manifest.generatedAt,
          mimeType: download.contentType || mimeType(name),
          preview,
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
        };
        fallbackIndexedFiles.push(file);
        if (artifactMatchesScope(file, "materials")) recentFiles.push(file);
      }
    }
    deadlines.sort((left, right) => String(left.dueDate).localeCompare(String(right.dueDate)));
    announcements.sort((left, right) => String(right.postedAt || right.createdDate || "").localeCompare(String(left.postedAt || left.createdDate || "")));
    let artifactCounts = artifactCountSummary(fallbackIndexedFiles);
    if (this.externalFileIndex) {
      artifactCounts = this.externalFileIndex.artifactCounts || artifactCountSummary(this.externalFileIndex.files || []);
      trackedFiles = artifactCounts.all.files;
      trackedBytes = artifactCounts.all.bytes;
      recentFiles.length = 0;
      recentFiles.push(...(this.externalFileIndex.files || []).filter((file) => artifactMatchesScope(file, "materials")));
    }
    recentFiles.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
    const value = {
      generatedAt: inventory.generatedAt,
      archiveRoot: this.archiveRoot,
      courseCount: inventory.courses.length,
      archivedCount: archived.length,
      completeCount: archived.filter((course) => course.archive.status === "complete").length,
      issueCount: archived.filter((course) => ["incomplete", "failed"].includes(course.archive.status)).length,
      files: trackedFiles,
      bytes: trackedBytes,
      materialFiles: artifactCounts.materials.files,
      materialBytes: artifactCounts.materials.bytes,
      exportFiles: artifactCounts.exports.files,
      exportBytes: artifactCounts.exports.bytes,
      recordFiles: artifactCounts.records.files,
      recordBytes: artifactCounts.records.bytes,
      artifactCounts,
      deadlines,
      announcements: announcements.slice(0, 30),
      recentFiles: recentFiles.slice(0, 20),
    };
    this.summaryCache = { cachedAt: this.nowMs(), value };
    return value;
  }

  allFiles(options = {}) {
    const query = String(options.query || "").trim().toLowerCase();
    const preview = String(options.preview || "all");
    const courseId = String(options.courseId || "");
    const scope = ["materials", "exports", "records", "all"].includes(options.scope)
      ? options.scope
      : "materials";
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.min(Math.max(1, Number(options.limit) || 250), 5000);
    const courses = this.getInventory().courses.filter(
      (course) => course.archive.exists && (!courseId || course.id === courseId)
    );
    const candidates = [];
    for (const course of courses) {
      for (const file of this.listFiles(course.id)) {
        candidates.push({ ...file, courseId: course.id, courseCode: course.code, courseName: course.name });
      }
    }
    const counts = artifactCountSummary(candidates);
    const files = [];
    for (const file of candidates) {
        if (!artifactMatchesScope(file, scope)) continue;
        if (preview !== "all" && file.preview !== preview) continue;
        if (query && !`${file.name} ${file.path} ${file.courseName} ${file.courseCode}`.toLowerCase().includes(query)) continue;
        files.push(file);
    }
    files.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)) || left.path.localeCompare(right.path));
    return { total: files.length, offset, limit, scope, counts, files: files.slice(offset, offset + limit) };
  }

  search(query, options = {}) {
    const needle = String(query || "").trim().toLowerCase();
    if (needle.length < 2) return [];
    const inventory = this.getInventory();
    const courses = options.courseId
      ? inventory.courses.filter((course) => course.id === options.courseId)
      : inventory.courses.filter((course) => course.archive.exists);
    const results = [];
    const seenGroups = new Set();
    const maxResults = Math.min(Number(options.limit) || 80, 200);
    for (const course of courses) {
      if (course.name.toLowerCase().includes(needle) || course.code.toLowerCase().includes(needle)) {
        results.push({ type: "course", courseId: course.id, courseCode: course.code, title: course.name, path: null, snippet: course.termName });
      }
      const courseFiles = this.listFiles(course.id);
      const filesByPath = new Map(courseFiles.map((file) => [file.path, file]));
      for (const file of courseFiles) {
        if (results.length >= maxResults) return results;
        if (file.origin === ARTIFACT_ORIGINS.fetcherRecord || file.searchable === false) continue;
        const pathMatch = file.path.toLowerCase().includes(needle);
        let snippet = "";
        let contentMatch = false;
        if (!pathMatch && ["text", "json", "link"].includes(file.preview) && file.size <= 2_000_000) {
          try {
            const indexedText = this.externalFileIndex?.searchDocuments?.[course.id]?.[file.path];
            const text = typeof indexedText === "string"
              ? indexedText
              : this.archiveRepository.readCourseText(course, file.path, "");
            const index = text.toLowerCase().indexOf(needle);
            if (index >= 0) {
              contentMatch = true;
              snippet = text.slice(Math.max(0, index - 70), Math.min(text.length, index + needle.length + 130)).replace(/\s+/g, " ").trim();
            }
          } catch {}
        }
        if (pathMatch || contentMatch) {
          const target = filesByPath.get(file.primaryPath) || file;
          const resultKey = `${course.id}:${file.groupKey || target.path}`;
          if (seenGroups.has(resultKey)) continue;
          seenGroups.add(resultKey);
          const useLogicalTitle = [
            ARTIFACT_ORIGINS.blackboardContentExport,
            ARTIFACT_ORIGINS.derivedSearchText,
          ].includes(file.origin);
          results.push({
            ...target,
            type: "file",
            courseId: course.id,
            courseCode: course.code,
            title: useLogicalTitle && file.logicalItemTitle ? file.logicalItemTitle : target.name,
            path: target.path,
            preview: target.preview,
            origin: target.origin,
            role: target.role,
            snippet: snippet || target.path,
          });
        }
      }
    }
    return results;
  }
}

module.exports = { ArchiveService, TEXT_EXTENSIONS, mimeType, previewKind };
