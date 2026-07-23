function validateFetchAllInput(input, stateRepository) {
  if (!input.base || !/^https?:\/\//i.test(input.base)) {
    throw new Error("Missing or invalid --base Blackboard URL (or BB_BASE)");
  }
  if (!stateRepository.exists(input.stateFile)) throw new Error(`Missing session state: ${input.stateFile}`);
  if (!new Set(["placeholder", "full"]).has(input.downloadMode)) {
    throw new Error("--download-mode must be placeholder or full");
  }
  if (!new Set(["ALL", "ULTRA", "CLASSIC"]).has(input.view)) {
    throw new Error("--view must be all, ultra, or classic");
  }
  if (!Number.isInteger(input.courseConcurrency) || input.courseConcurrency < 1 || input.courseConcurrency > 4) {
    throw new Error("--course-concurrency must be an integer from 1 to 4");
  }
  if (!Number.isInteger(input.attachmentConcurrency) || input.attachmentConcurrency < 1 || input.attachmentConcurrency > 8) {
    throw new Error("--attachment-concurrency must be an integer from 1 to 8");
  }
  if (input.all && input.downloadMode === "full" && !input.confirmFull) {
    throw new Error("Refusing an all-course full download without --confirm-full");
  }
  if (input.limit !== null && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
}

class FetchAllCommandService {
  constructor({ batchService, inventoryService, stateRepository }) {
    if (!batchService) throw new TypeError("FetchAllCommandService requires a batchService");
    if (!inventoryService) throw new TypeError("FetchAllCommandService requires an inventoryService");
    if (!stateRepository) throw new TypeError("FetchAllCommandService requires a stateRepository");
    this.batchService = batchService;
    this.inventoryService = inventoryService;
    this.stateRepository = stateRepository;
  }

  async execute(input, observer = {}) {
    validateFetchAllInput(input, this.stateRepository);
    this.inventoryService.prepare();
    const { index, selected } = await this.inventoryService.refresh({
      attachmentConcurrency: input.attachmentConcurrency,
      base: input.base,
      courseConcurrency: input.courseConcurrency,
      downloadMode: input.downloadMode,
      selection: {
        all: input.all,
        courseIds: input.courseIds,
        includeUnavailable: input.includeUnavailable,
        limit: input.limit,
        term: input.term,
        view: input.view,
      },
      stateFile: input.stateFile,
    });

    if (input.inventoryOnly || selected.length === 0) {
      return {
        batchRan: false,
        exitCode: 0,
        failures: 0,
        index,
        noMatches: !input.inventoryOnly && (input.all || input.courseIds.length > 0),
        selected,
      };
    }

    const batch = await this.batchService.run({
      attachmentConcurrency: input.attachmentConcurrency,
      base: input.base,
      courseConcurrency: input.courseConcurrency,
      downloadMode: input.downloadMode,
      index,
      reuseValidatedCache: input.reuseValidatedCache,
      selected,
      stateFile: input.stateFile,
    }, observer);
    return {
      ...batch,
      batchRan: true,
      exitCode: batch.failures ? 2 : 0,
      index,
      noMatches: false,
      selected,
    };
  }
}

module.exports = { FetchAllCommandService, validateFetchAllInput };
