const PHASES = [
  ["bootstrap", 4],
  ["announcements", 7],
  ["content", 38],
  ["quizReviewFallbacks", 10],
  ["gradebook", 10],
  ["classicSubmissions", 6],
  ["feedbackDownloads", 5],
  ["additionalAreas", 12],
  ["coverageAudit", 5],
  ["status", 3],
];

const PHASE_WEIGHT = new Map(PHASES);
const TERMINAL_TASK_STATES = new Set(["completed", "incomplete", "failed", "cancelled"]);
const TERMINAL_BATCH_STATES = new Set(["completed", "completed_with_issues", "failed", "cancelled", "interrupted"]);
const ACTIVE_BATCH_STATES = new Set(["queued", "running", "paused"]);

function reconcilePersistedBatches(batches, timestamp) {
  let changed = false;
  const reconciled = (Array.isArray(batches) ? batches : []).map((batch) => {
    const tasks = (batch.tasks || []).map((task) => {
      if (!["running", "pausing"].includes(task.status) && !(task.status === "paused" && task.processPaused)) {
        return { ...task };
      }
      changed = true;
      return {
        ...task,
        status: "interrupted",
        processPaused: false,
        currentItem: "Dashboard stopped while this course was running",
        finishedAt: timestamp,
      };
    });
    if (!["running", "queued"].includes(batch.status)) return { ...batch, tasks };
    changed = true;
    return { ...batch, tasks, status: "interrupted", finishedAt: timestamp };
  });
  return { batches: reconciled, changed };
}

function transitionTaskAfterExit(task, { code, signal, timestamp }) {
  const next = {
    ...task,
    desiredAfterExit: null,
    exitCode: Number.isInteger(code) ? code : null,
    finishedAt: timestamp,
    processPaused: false,
  };
  if (task.desiredAfterExit === "cancelled") {
    return {
      ...next,
      status: "cancelled",
      currentPhase: "Cancelled",
      currentItem: "Partial archive retained for a validated resume",
    };
  }
  if (task.desiredAfterExit === "paused") {
    return {
      ...next,
      status: "paused",
      currentPhase: "Paused",
      currentItem: "Resume will validate and reuse completed files",
      finishedAt: null,
    };
  }
  if (code === 0) {
    return {
      ...next,
      status: "completed",
      progress: 100,
      currentPhase: "Complete",
      currentItem: "Archive written and coverage audit passed",
    };
  }
  if (code === 2) {
    return {
      ...next,
      status: "incomplete",
      progress: 100,
      currentPhase: "Completed with issues",
      currentItem: "Archive is usable; coverage audit reported gaps",
    };
  }
  return {
    ...next,
    status: "failed",
    currentPhase: "Failed",
    currentItem: signal ? `Process stopped by ${signal}` : `Fetcher exited with code ${code ?? "unknown"}`,
  };
}

function transitionBatchAfterTaskExit(batch, { activeChildren, timestamp }) {
  const next = { ...batch };
  if (batch.status === "cancelled") {
    if (activeChildren === 0 && !next.finishedAt) next.finishedAt = timestamp;
    return next;
  }
  const tasks = batch.tasks || [];
  const hasQueued = tasks.some((task) => task.status === "queued");
  if (activeChildren !== 0 || hasQueued) return next;
  if (tasks.some((task) => task.status === "paused")) {
    next.status = "paused";
    return next;
  }
  const hasIssues = tasks.some((task) => ["incomplete", "failed", "cancelled"].includes(task.status));
  next.status = hasIssues ? "completed_with_issues" : "completed";
  next.finishedAt = timestamp;
  return next;
}

module.exports = {
  ACTIVE_BATCH_STATES,
  PHASES,
  PHASE_WEIGHT,
  TERMINAL_BATCH_STATES,
  TERMINAL_TASK_STATES,
  reconcilePersistedBatches,
  transitionBatchAfterTaskExit,
  transitionTaskAfterExit,
};
