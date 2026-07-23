const DOWNLOAD_MODES = new Set(["full", "placeholder"]);

function validateCourseFetchInput(input, stateRepository) {
  if (!input.courseId) {
    throw new Error("Missing --course-id (or BB_COURSE_ID).");
  }
  if (!input.base || !/^https?:\/\//i.test(input.base)) {
    throw new Error("Missing or invalid --base Blackboard URL (or BB_BASE).");
  }
  if (!DOWNLOAD_MODES.has(input.downloadMode)) {
    throw new Error(`Unsupported download mode ${input.downloadMode}; expected full or placeholder.`);
  }
  if (
    !Number.isInteger(input.attachmentConcurrency) ||
    input.attachmentConcurrency < 1 ||
    input.attachmentConcurrency > 8
  ) {
    throw new Error("Invalid --attachment-concurrency; expected an integer from 1 to 8.");
  }
  if (!stateRepository.exists(input.stateFile)) {
    throw new Error(
      `Missing session state ${input.stateFile}. Run playwright-cli state-save after logging in.`
    );
  }
}

module.exports = { validateCourseFetchInput };
