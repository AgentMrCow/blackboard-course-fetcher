const path = require("path");

function parseCourseFetchArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals > 2) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function resolveCourseFetchInput(options, { cwd = process.cwd(), environment = process.env } = {}) {
  return {
    attachmentConcurrency: Number(
      options["attachment-concurrency"] || environment.BB_ATTACHMENT_CONCURRENCY || 2
    ),
    base: String(options.base || environment.BB_BASE || "").trim().replace(/\/$/, ""),
    courseId: String(options["course-id"] || environment.BB_COURSE_ID || "").trim(),
    courseNameHint: String(environment.BB_COURSE_NAME || ""),
    courseTermHint: String(environment.BB_COURSE_TERM || ""),
    downloadMode: String(
      options["download-mode"] || environment.BB_DOWNLOAD_MODE || "placeholder"
    ).toLowerCase(),
    outputRoot: path.resolve(cwd, String(options.output || environment.BB_OUT_ROOT || cwd)),
    progressEvents: environment.BB_PROGRESS_EVENTS === "1",
    reuseValidatedCache:
      options["reuse-validated-cache"] === true || environment.BB_REUSE_VALIDATED_CACHE === "1",
    stateFile: path.resolve(
      cwd,
      String(options.state || environment.BB_STATE_FILE || ".blackboard-state.json")
    ),
  };
}

module.exports = { parseCourseFetchArguments, resolveCourseFetchInput };
