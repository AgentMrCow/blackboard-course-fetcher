const path = require("path");
const {
  createFetchAllObserver,
  HELP_TEXT,
  parseFetchAllArguments,
  reportFetchAllResult,
  resolveFetchAllInput,
} = require("../adapters/cli/fetch-all-cli");
const { NodeCourseFetchRunner } = require("../adapters/system/node-course-fetch-runner");
const { FetchAllCommandService } = require("../application/fetch-all/fetch-all-command-service");
const { CourseFetchBatchService } = require("../application/fetch-jobs/course-fetch-batch-service");
const { createCourseInventoryRuntime } = require("./course-inventory-runtime");

const PROJECT_ROOT = path.resolve(__dirname, "../..");

function createFetchAllRuntime({
  archiveRoot,
  batchService,
  clock,
  commandService,
  courseRunner,
  delay,
  environment = process.env,
  executable,
  fetchImpl,
  membershipGateway,
  repository,
  scriptDirectory = PROJECT_ROOT,
  spawnImpl,
  stateRepository,
  stdio,
} = {}) {
  const inventoryRuntime = createCourseInventoryRuntime({
    archiveRoot,
    clock,
    delay,
    fetchImpl,
    membershipGateway,
    repository,
    stateRepository,
  });
  const resolvedCourseRunner = courseRunner || new NodeCourseFetchRunner({
    environment,
    executable,
    scriptDirectory,
    spawnImpl,
    stdio,
  });
  const resolvedBatchService = batchService || new CourseFetchBatchService({
    courseRunner: resolvedCourseRunner,
    inventoryService: inventoryRuntime.inventoryService,
  });
  const resolvedCommandService = commandService || new FetchAllCommandService({
    batchService: resolvedBatchService,
    inventoryService: inventoryRuntime.inventoryService,
    stateRepository: inventoryRuntime.stateRepository,
  });
  return {
    ...inventoryRuntime,
    batchService: resolvedBatchService,
    commandService: resolvedCommandService,
    courseRunner: resolvedCourseRunner,
  };
}

async function runFetchAllCli(argv, {
  createRuntime = createFetchAllRuntime,
  cwd = process.cwd(),
  environment = process.env,
  writeError = (value) => console.error(value),
  writeOutput = (value) => console.log(value),
  ...runtimeOptions
} = {}) {
  try {
    const options = parseFetchAllArguments(argv);
    if (options.help) {
      writeOutput(HELP_TEXT);
      return 0;
    }
    const input = resolveFetchAllInput(options, { cwd, environment });
    const runtime = createRuntime({
      ...runtimeOptions,
      archiveRoot: input.outputRoot,
      environment,
    });
    const result = await runtime.commandService.execute(
      input,
      createFetchAllObserver({ writeError, writeOutput })
    );
    reportFetchAllResult(result, input, writeOutput);
    return result.exitCode;
  } catch (error) {
    writeError(error.message || error);
    return 1;
  }
}

module.exports = { createFetchAllRuntime, runFetchAllCli };
