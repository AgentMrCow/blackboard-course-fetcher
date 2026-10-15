const { httpError } = require("../../shared/http-error");

const MINIMUM_FULL_FETCH_FREE_BYTES = 512 * 1024 ** 2;

class FetchCommandService {
  constructor({ jobs, settings, systemStatus }) {
    if (!jobs) throw new TypeError("FetchCommandService requires jobs");
    if (!settings) throw new TypeError("FetchCommandService requires settings");
    if (!systemStatus) throw new TypeError("FetchCommandService requires systemStatus");
    this.jobs = jobs;
    this.settings = settings;
    this.systemStatus = systemStatus;
  }

  setSettings(settings) {
    this.settings = settings;
  }

  start(input = {}) {
    const requested = new Set(Array.isArray(input.courseIds) ? input.courseIds : []);
    const inventory = this.jobs.archiveService.getInventory();
    if (inventory.courses.some((course) => requested.has(course.id)
      && (course.archiveOnly === true || course.membershipPresent === false))) {
      throw httpError(409, "A selected course has no current Blackboard membership. Its local archive remains available; scan courses again before fetching it.");
    }
    const mode = input.mode ?? this.settings.downloadMode;
    const freeBytes = this.systemStatus(this.settings).disk?.freeBytes;
    if (
      String(mode).toLowerCase() === "full"
      && Number.isFinite(freeBytes)
      && freeBytes < MINIMUM_FULL_FETCH_FREE_BYTES
    ) {
      throw httpError(507, "At least 512 MB of free archive storage is required to start a full fetch");
    }

    return this.jobs.createAndStart(
      {
        courseIds: input.courseIds,
        mode,
        courseConcurrency: input.courseConcurrency ?? this.settings.courseConcurrency,
        attachmentConcurrency: input.attachmentConcurrency ?? this.settings.attachmentConcurrency,
        reuseValidatedCache: input.reuseValidatedCache ?? this.settings.reuseValidatedCache,
        confirmFull: input.confirmFull === true,
      },
      {
        base: this.settings.blackboardBase,
        stateFile: this.settings.stateFile,
      }
    );
  }
}

module.exports = { FetchCommandService, MINIMUM_FULL_FETCH_FREE_BYTES };
