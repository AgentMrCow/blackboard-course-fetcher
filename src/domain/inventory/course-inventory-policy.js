function sanitizeInventoryPart(value, fallback = "item", maxLength = 120) {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || fallback).slice(0, maxLength).trim().replace(/[. ]+$/g, "") || fallback;
}

function canonicalTermName(value) {
  return String(value || "No Term").replace(/^Old\s+/i, "").trim() || "No Term";
}

function termSegments(value) {
  const term = canonicalTermName(value);
  const match = term.match(/^(\d{4}-\d{2}):\s*(.+)$/);
  return match
    ? [sanitizeInventoryPart(match[1], "Unknown Year", 30), sanitizeInventoryPart(match[2], "Unknown Term", 50)]
    : ["Other", sanitizeInventoryPart(term, "No Term", 70)];
}

function courseFolder(course) {
  const externalId = String(course.courseId || course.displayId || course.id).replace(/-ULTRA$/i, "");
  let title = String(course.displayName || course.name || course.id);
  title = title.replace(/^\d{4}[A-Z]\d?\s+/, "").replace(/\s+\([^()]*(?:ULTRA)?\)\s*$/i, "").trim();
  return sanitizeInventoryPart(`${externalId} - ${title}`, sanitizeInventoryPart(course.id), 125);
}

function normalizeMembership(membership) {
  const course = membership?.course;
  if (!course || course.isOrganization) return null;
  const sourceTermName = course.term?.name || "No Term";
  return {
    course: {
      id: course.id,
      externalId: course.courseId || course.displayId || null,
      name: course.displayName || course.name || course.id,
      term: {
        id: course.term?.id || course.termId || null,
        sourceName: sourceTermName,
        name: canonicalTermName(sourceTermName),
        startDate: course.term?.startDate || null,
        endDate: course.term?.endDate || null,
      },
      view: String(course.ultraStatus || "UNKNOWN").toUpperCase(),
      available: course.isAvailable !== false && membership.isAvailable !== false,
      membershipPresent: true,
      archiveOnly: false,
      hidden: membership.userHasHidden === true,
      lastAccessDate: membership.lastAccessDate || null,
    },
    pathSegments: [...termSegments(sourceTermName), courseFolder(course)],
  };
}

function initialFetchStatus(existingArchive) {
  if (!existingArchive) return "not selected";
  return existingArchive.coverageComplete ? "existing complete" : "existing incomplete";
}

function reconcileArchivedCourses(liveCourses, archivedCourses) {
  const archivesById = new Map(archivedCourses.map((course) => [course.id, course]));
  const liveIds = new Set(liveCourses.map((course) => course.id));
  return [
    ...liveCourses.map((course) => {
      const archived = archivesById.get(course.id);
      if (!archived) return course;
      // A renamed course or term must keep pointing at its existing local files.
      return {
        ...course,
        outputDirectory: archived.outputDirectory,
        outputPath: archived.outputPath,
        existingArchive: archived.existingArchive,
        fetchStatus: initialFetchStatus(archived.existingArchive),
      };
    }),
    ...archivedCourses.filter((course) => !liveIds.has(course.id)).map((course) => ({
      ...course,
      available: false,
      membershipPresent: false,
      archiveOnly: true,
      selected: false,
      fetchStatus: "archive only: not in current memberships",
      exitCode: null,
    })),
  ];
}

function applyCourseSelection(courses, options = {}) {
  const requestedIds = new Set(Array.isArray(options.courseIds) ? options.courseIds : []);
  const unknownIds = [...requestedIds].filter((id) => !courses.some((course) => course.id === id));
  if (unknownIds.length) throw new Error(`Course ID not present in memberships: ${unknownIds.join(", ")}`);

  const view = String(options.view || "ALL").toUpperCase();
  const term = options.term === undefined ? null : String(options.term).toLowerCase();
  let selected = courses.filter((course) => {
    if (course.archiveOnly || course.membershipPresent === false) return false;
    if (!options.all && !requestedIds.has(course.id)) return false;
    if (!options.includeUnavailable && !course.available) return false;
    if (view !== "ALL" && course.view !== view) return false;
    if (term && !course.term.sourceName.toLowerCase().includes(term)) return false;
    return true;
  });
  if (options.limit !== null && options.limit !== undefined) selected = selected.slice(0, options.limit);

  const selectedIds = new Set(selected.map((course) => course.id));
  for (const course of courses) {
    course.selected = selectedIds.has(course.id);
    if (requestedIds.has(course.id) && (course.archiveOnly || course.membershipPresent === false)) {
      course.fetchStatus = "skipped: not in current memberships";
    } else if (requestedIds.has(course.id) && !course.available && !options.includeUnavailable) {
      course.fetchStatus = "skipped: unavailable";
    }
  }
  return selected;
}

module.exports = {
  applyCourseSelection,
  canonicalTermName,
  courseFolder,
  initialFetchStatus,
  normalizeMembership,
  reconcileArchivedCourses,
  sanitizeInventoryPart,
  termSegments,
};
