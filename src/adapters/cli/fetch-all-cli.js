const path = require("path");

const VALUE_OPTIONS = new Set([
  "attachment-concurrency",
  "base",
  "course-concurrency",
  "course-id",
  "download-mode",
  "limit",
  "output",
  "state",
  "term",
  "view",
]);
const BOOLEAN_OPTIONS = new Set([
  "all",
  "confirm-full",
  "help",
  "include-unavailable",
  "inventory-only",
  "reuse-validated-cache",
]);

const HELP_TEXT = `Usage:
  node bin/fetch-blackboard-all.js --base URL                         # inventory only
  node bin/fetch-blackboard-all.js --base URL --course-id _12345_1   # one course, placeholder mode
  node bin/fetch-blackboard-all.js --base URL --all --term "2025-26" --limit 2

Options:
  --course-id ID          Fetch one course; repeat for multiple courses
  --all                   Fetch all courses matching the filters
  --term TEXT             Match a Blackboard term name
  --view all|ultra|classic
  --limit N               Limit selected courses after filtering
  --download-mode placeholder|full   Default: placeholder
  --confirm-full          Required with --all --download-mode full
  --include-unavailable   Include unavailable courses in selection
  --inventory-only        Never run per-course fetches
  --reuse-validated-cache Reuse local files whose manifest SHA-256 still matches (repair runs)
  --course-concurrency N  Courses fetched at once, 1-4; default: 1
  --attachment-concurrency N  Attachments fetched at once per course, 1-8; default: 2
  --state PATH            Playwright storage-state JSON
  --output PATH           Archive root; default: ./Blackboard_Archive
  --base URL              Blackboard origin; required unless BB_BASE is set
`;

function parseFetchAllArguments(argv) {
  const options = { courseIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const key = argument.slice(2, equals > 2 ? equals : undefined);
    if (!VALUE_OPTIONS.has(key) && !BOOLEAN_OPTIONS.has(key)) throw new Error(`Unknown option: --${key}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = equals > 2 ? argument.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    if (key === "course-id") options.courseIds.push(value);
    else options[key] = value;
  }
  return options;
}

function resolveFetchAllInput(options, { cwd = process.cwd(), environment = process.env } = {}) {
  return {
    all: options.all === true,
    attachmentConcurrency: Number(options["attachment-concurrency"] || environment.BB_ATTACHMENT_CONCURRENCY || 2),
    base: String(options.base || environment.BB_BASE || "").trim().replace(/\/$/, ""),
    confirmFull: options["confirm-full"] === true,
    courseConcurrency: Number(options["course-concurrency"] || environment.BB_COURSE_CONCURRENCY || 1),
    courseIds: options.courseIds,
    downloadMode: String(options["download-mode"] || "placeholder").toLowerCase(),
    includeUnavailable: options["include-unavailable"] === true,
    inventoryOnly: options["inventory-only"] === true,
    limit: options.limit === undefined ? null : Number(options.limit),
    outputRoot: path.resolve(cwd, options.output || "Blackboard_Archive"),
    reuseValidatedCache: options["reuse-validated-cache"] === true,
    stateFile: path.resolve(cwd, options.state || environment.BB_STATE_FILE || ".blackboard-state.json"),
    term: options.term,
    view: String(options.view || "all").toUpperCase(),
  };
}

function createFetchAllObserver({ writeError, writeOutput }) {
  return {
    onCourseSignal({ course, signal }) {
      writeError(`COURSE STOPPED ${course.name}: signal ${signal}`);
    },
    onCourseStart({ course, position, total }) {
      writeOutput(`COURSE ${position + 1}/${total}: ${course.name} (${course.id}, ${course.view})`);
    },
    onCourseStartError({ course, error }) {
      writeError(`FAILED TO START ${course.name}: ${error.message}`);
    },
  };
}

function reportFetchAllResult(result, input, writeOutput) {
  if (!result.batchRan) {
    writeOutput(`INVENTORY ${result.index.courses.length} courses -> ${path.join(input.outputRoot, "courses.json")}`);
    if (result.noMatches) writeOutput("No courses matched the selection filters.");
    return;
  }
  writeOutput(`ALL DONE ${result.completed}/${result.total} courses complete; ${result.failures} incomplete`);
}

module.exports = {
  createFetchAllObserver,
  HELP_TEXT,
  parseFetchAllArguments,
  reportFetchAllResult,
  resolveFetchAllInput,
};
