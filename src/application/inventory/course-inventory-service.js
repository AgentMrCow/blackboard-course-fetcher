const {
  applyCourseSelection,
  initialFetchStatus,
  normalizeMembership,
} = require("../../domain/inventory/course-inventory-policy");

class CourseInventoryService {
  constructor({ clock = () => new Date(), membershipGateway, repository }) {
    if (!membershipGateway) throw new TypeError("CourseInventoryService requires a membershipGateway");
    if (!repository) throw new TypeError("CourseInventoryService requires a repository");
    this.clock = clock;
    this.membershipGateway = membershipGateway;
    this.repository = repository;
  }

  async refresh({
    attachmentConcurrency,
    base,
    courseConcurrency,
    downloadMode,
    selection = {},
    stateFile,
  }) {
    const memberships = await this.membershipGateway.listMemberships({ base, stateFile });
    if (!Array.isArray(memberships)) throw new Error("Blackboard memberships response must be an array");

    const courses = memberships
      .map((membership) => normalizeMembership(membership))
      .filter(Boolean)
      .map(({ course, pathSegments }) => {
        const location = this.repository.courseLocation(pathSegments);
        const existingArchive = this.repository.readExistingArchive(location.outputPath);
        return {
          ...course,
          ...location,
          existingArchive,
          selected: false,
          fetchStatus: initialFetchStatus(existingArchive),
          exitCode: null,
        };
      })
      .sort((left, right) => right.term.name.localeCompare(left.term.name) || left.name.localeCompare(right.name));

    const index = {
      schemaVersion: 1,
      generatedAt: this.clock().toISOString(),
      blackboardBase: base,
      downloadMode,
      settings: { courseConcurrency, attachmentConcurrency },
      inventoryCount: courses.length,
      courses,
    };
    const selected = applyCourseSelection(courses, selection);
    this.repository.save(index);
    return { index, selected };
  }

  prepare() {
    return this.repository.ensureRoot();
  }

  refreshArchiveStatus(course) {
    course.existingArchive = this.repository.readExistingArchive(course.outputPath);
    return course.existingArchive;
  }

  save(index) {
    return this.repository.save(index);
  }
}

module.exports = { CourseInventoryService };
