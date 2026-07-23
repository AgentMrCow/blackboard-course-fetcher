class CourseFetchBatchService {
  constructor({ courseRunner, inventoryService }) {
    if (!courseRunner) throw new TypeError("CourseFetchBatchService requires a courseRunner");
    if (!inventoryService) throw new TypeError("CourseFetchBatchService requires an inventoryService");
    this.courseRunner = courseRunner;
    this.inventoryService = inventoryService;
  }

  async run({
    attachmentConcurrency,
    base,
    courseConcurrency,
    downloadMode,
    index,
    reuseValidatedCache,
    selected,
    stateFile,
  }, observer = {}) {
    let failures = 0;
    let nextPosition = 0;

    const worker = async () => {
      while (nextPosition < selected.length) {
        const position = nextPosition;
        nextPosition += 1;
        const course = selected[position];
        course.fetchStatus = "running";
        this.inventoryService.save(index);
        observer.onCourseStart?.({ course, position, total: selected.length });

        let result;
        try {
          result = await this.courseRunner.run({
            attachmentConcurrency,
            base,
            courseId: course.id,
            courseName: course.name,
            courseTerm: course.term.sourceName,
            mode: downloadMode,
            outputPath: course.outputPath,
            reuseValidatedCache,
            stateFile,
          });
        } catch (error) {
          result = { exitCode: 1, signal: null, startError: error };
        }

        if (result.startError) observer.onCourseStartError?.({ course, error: result.startError });
        if (result.signal) observer.onCourseSignal?.({ course, signal: result.signal });
        course.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1;
        this.inventoryService.refreshArchiveStatus(course);
        course.fetchStatus = course.exitCode === 0 ? "complete" : `incomplete (exit ${course.exitCode})`;
        if (course.exitCode !== 0) failures += 1;
        this.inventoryService.save(index);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(courseConcurrency, selected.length) }, () => worker())
    );
    return {
      completed: selected.length - failures,
      failures,
      total: selected.length,
    };
  }
}

module.exports = { CourseFetchBatchService };
