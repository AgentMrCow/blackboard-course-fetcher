const { EventEmitter } = require("events");
const { httpError } = require("../../shared/http-error");
const {
  ACTIVE_BATCH_STATES,
  PHASES,
  PHASE_WEIGHT,
  TERMINAL_BATCH_STATES,
  TERMINAL_TASK_STATES,
  reconcilePersistedBatches,
  transitionBatchAfterTaskExit,
  transitionTaskAfterExit,
} = require("../../domain/fetch-jobs/job-state");

const PROGRESS_PREFIX = "@@BB_PROGRESS@@";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cleanLogLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 900);
}

class JobManager extends EventEmitter {
  constructor({ archiveService, clock = () => new Date(), idFactory, jobRepository, processRunner, scheduler }) {
    super();
    if (!jobRepository) throw new TypeError("JobManager requires a jobRepository");
    if (!processRunner) throw new TypeError("JobManager requires a processRunner");
    this.archiveService = archiveService;
    this.clock = clock;
    this.idFactory = idFactory || (() => `fetch-${this.nowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
    this.jobRepository = jobRepository;
    this.processRunner = processRunner;
    this.scheduler = scheduler || {
      cancel: (timer) => clearTimeout(timer),
      delay: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        timer.unref?.();
        return timer;
      },
      soon: (callback) => setImmediate(callback),
    };
    this.batches = [];
    this.children = new Map();
    this.persistTimer = null;
    this.load();
  }

  nowIso() {
    return this.clock().toISOString();
  }

  nowMs() {
    return this.clock().getTime();
  }

  load() {
    const reconciled = reconcilePersistedBatches(this.jobRepository.load(), this.nowIso());
    this.batches = reconciled.batches;
    if (reconciled.changed) this.persistNow();
  }

  setArchiveService(archiveService) {
    this.archiveService = archiveService;
  }

  activeBatch() {
    return this.batches.find((batch) => ACTIVE_BATCH_STATES.has(batch.status));
  }

  estimateDuration(course, mode) {
    if (course.archive?.totalMs && course.archive?.downloadMode === mode) {
      return clamp(course.archive.totalMs, 15_000, 4 * 60 * 60 * 1000);
    }
    const comparable = this.archiveService
      .getInventory()
      .courses.filter((item) => item.archive?.downloadMode === mode)
      .map((item) => Number(item.archive?.totalMs))
      .filter((value) => Number.isFinite(value) && value > 0);
    return median(comparable) || (mode === "full" ? 6 * 60_000 : 90_000);
  }

  createBatch(options) {
    if (this.activeBatch()) {
      throw httpError(409, "Finish or cancel the active batch before starting another one");
    }
    const inventory = this.archiveService.getInventory();
    const requested = new Set(Array.isArray(options.courseIds) ? options.courseIds : []);
    const courses = inventory.courses.filter((course) => requested.has(course.id));
    if (!courses.length) throw httpError(400, "Select at least one course");
    if (courses.length !== requested.size) throw httpError(400, "One or more selected courses are not in the current inventory");
    const mode = String(options.mode || "placeholder").toLowerCase();
    if (!new Set(["placeholder", "full"]).has(mode)) throw httpError(400, "Download mode must be placeholder or full");
    if (mode === "full" && courses.length > 1 && options.confirmFull !== true) {
      throw httpError(400, "Confirm the multi-course full download before starting");
    }
    const courseConcurrency = Number(options.courseConcurrency || 1);
    const attachmentConcurrency = Number(options.attachmentConcurrency || 2);
    if (!Number.isInteger(courseConcurrency) || courseConcurrency < 1 || courseConcurrency > 4) {
      throw httpError(400, "Course concurrency must be from 1 to 4");
    }
    if (!Number.isInteger(attachmentConcurrency) || attachmentConcurrency < 1 || attachmentConcurrency > 8) {
      throw httpError(400, "Attachment concurrency must be from 1 to 8");
    }
    const id = this.idFactory();
    const createdAt = this.nowIso();
    const batch = {
      id,
      kind: "fetch",
      status: "queued",
      createdAt,
      startedAt: null,
      finishedAt: null,
      options: {
        mode,
        courseConcurrency,
        attachmentConcurrency,
        reuseValidatedCache: options.reuseValidatedCache === true,
      },
      tasks: courses.map((course) => ({
        id: `${id}:${course.id}`,
        courseId: course.id,
        courseCode: course.code,
        courseName: course.name,
        outputDirectory: course.outputDirectory,
        status: "queued",
        progress: 0,
        currentPhase: "Queued",
        currentItem: "Waiting for a fetch slot",
        createdAt,
        startedAt: null,
        finishedAt: null,
        runStartedAt: null,
        pausedAt: null,
        pausedMs: 0,
        expectedMs: this.estimateDuration(course, mode),
        completedPhases: [],
        phaseStartedAt: null,
        transfer: { networkFiles: 0, networkBytes: 0, reusedFiles: 0, reusedBytes: 0, placeholderFiles: 0, unresolvedFiles: 0 },
        retryCount: 0,
        exitCode: null,
        logs: [],
        result: null,
        processPaused: false,
        desiredAfterExit: null,
      })),
    };
    this.batches.unshift(batch);
    this.batches = this.batches.slice(0, 30);
    this.persistNow();
    this.emitUpdate();
    this.scheduler.soon(() => this.pump(batch.id));
    return this.snapshotBatch(batch);
  }

  getBatch(batchId) {
    const batch = this.batches.find((item) => item.id === batchId);
    if (!batch) throw httpError(404, "Fetch batch not found");
    return batch;
  }

  getTask(batch, courseId) {
    const task = batch.tasks.find((item) => item.courseId === courseId);
    if (!task) throw httpError(404, "Course task not found");
    return task;
  }

  elapsedMs(task) {
    if (!task.runStartedAt) return 0;
    const end = task.finishedAt ? Date.parse(task.finishedAt) : this.nowMs();
    const livePause = task.pausedAt ? Math.max(0, end - Date.parse(task.pausedAt)) : 0;
    return Math.max(0, end - Date.parse(task.runStartedAt) - Number(task.pausedMs || 0) - livePause);
  }

  remainingMs(task) {
    if (TERMINAL_TASK_STATES.has(task.status)) return 0;
    const elapsed = this.elapsedMs(task);
    const progress = Number(task.progress || 0) / 100;
    let projected = Number(task.expectedMs || 0);
    if (elapsed > 5_000 && progress > 0.04) projected = Math.max(projected * 0.55, elapsed / progress);
    return Math.max(5_000, projected - elapsed);
  }

  snapshotTask(task) {
    const remainingMs = this.remainingMs(task);
    return {
      ...task,
      logs: task.logs.slice(-120),
      elapsedMs: this.elapsedMs(task),
      remainingMs,
      estimatedEndAt: ["running", "queued"].includes(task.status) ? new Date(this.nowMs() + remainingMs).toISOString() : null,
    };
  }

  snapshotBatch(batch) {
    const tasks = batch.tasks.map((task) => this.snapshotTask(task));
    const concurrency = Number(batch.options.courseConcurrency || 1);
    const lanes = Array.from({ length: concurrency }, () => 0);
    for (const remaining of tasks.map((task) => task.remainingMs).sort((left, right) => right - left)) {
      const index = lanes.indexOf(Math.min(...lanes));
      lanes[index] += remaining;
    }
    const remainingMs = batch.status === "paused" ? null : Math.max(0, ...lanes);
    return {
      ...batch,
      tasks,
      progress: tasks.length ? Math.round(tasks.reduce((sum, task) => sum + Number(task.progress || 0), 0) / tasks.length) : 0,
      remainingMs,
      estimatedEndAt: remainingMs === null || TERMINAL_BATCH_STATES.has(batch.status)
        ? null
        : new Date(this.nowMs() + remainingMs).toISOString(),
      counts: tasks.reduce((counts, task) => {
        counts[task.status] = (counts[task.status] || 0) + 1;
        return counts;
      }, {}),
    };
  }

  snapshot() {
    return this.batches.map((batch) => this.snapshotBatch(batch));
  }

  emitUpdate() {
    this.emit("update", this.snapshot());
  }

  schedulePersist() {
    this.scheduler.cancel(this.persistTimer);
    this.persistTimer = this.scheduler.delay(() => this.persistNow(), 250);
  }

  persistNow() {
    this.scheduler.cancel(this.persistTimer);
    this.persistTimer = null;
    this.jobRepository.save(this.batches);
  }

  log(task, stream, line) {
    const clean = cleanLogLine(line);
    if (!clean) return;
    task.logs.push({ at: this.nowIso(), stream, line: clean });
    if (task.logs.length > 160) task.logs.splice(0, task.logs.length - 160);
  }

  phaseBaseProgress(task) {
    return task.completedPhases.reduce((sum, phase) => sum + (PHASE_WEIGHT.get(phase) || 0), 0);
  }

  handleProgressEvent(task, event) {
    if (event.type === "phase-start") {
      task.currentPhase = event.phase || "Working";
      task.phaseStartedAt = this.nowIso();
      task.progress = Math.max(task.progress, this.phaseBaseProgress(task));
    } else if (event.type === "phase-end") {
      if (event.phase && !task.completedPhases.includes(event.phase)) task.completedPhases.push(event.phase);
      task.progress = Math.max(task.progress, this.phaseBaseProgress(task));
      task.currentPhase = event.phase || task.currentPhase;
    } else if (event.type === "item") {
      task.currentItem = event.label || event.path || task.currentItem;
      if (event.phase) task.currentPhase = event.phase;
    } else if (event.type === "transfer") {
      task.currentItem = event.path || event.label || task.currentItem;
      if (event.transfer) task.transfer = { ...task.transfer, ...event.transfer };
    } else if (event.type === "done") {
      task.progress = 100;
      task.currentPhase = "Complete";
      task.currentItem = event.summary || "Archive written and audited";
    }
  }

  handleLine(batch, task, stream, rawLine) {
    const line = cleanLogLine(rawLine);
    if (!line) return;
    if (line.startsWith(PROGRESS_PREFIX)) {
      try {
        this.handleProgressEvent(task, JSON.parse(line.slice(PROGRESS_PREFIX.length)));
      } catch {
        this.log(task, stream, line);
      }
    } else {
      this.log(task, stream, line);
      const phase = line.match(/^phase ([A-Za-z]+):/);
      if (phase) this.handleProgressEvent(task, { type: "phase-end", phase: phase[1] });
      const item = line.match(/^(?:downloaded(?: via UI)?|placeholder|reused validated|validated cached|validated identical)\s+(.+?)(?:\s+\(\d+ bytes|\s+\([^)]*type\)|$)/i);
      if (item) task.currentItem = item[1];
      if (/^(?:FAILED|UNRESOLVED|DEFERRED)/.test(line)) task.currentItem = line;
    }
    const currentWeight = PHASE_WEIGHT.get(task.currentPhase) || 0;
    if (currentWeight && task.phaseStartedAt) {
      const phaseElapsed = this.nowMs() - Date.parse(task.phaseStartedAt);
      const phaseHint = clamp(phaseElapsed / Math.max(task.expectedMs * (currentWeight / 100), 1), 0, 0.88);
      task.progress = Math.max(task.progress, this.phaseBaseProgress(task) + currentWeight * phaseHint);
    }
    task.progress = Math.round(clamp(task.progress, 0, 99));
    this.schedulePersist();
    this.emitUpdate();
  }

  processKey(batchId, courseId) {
    return `${batchId}:${courseId}`;
  }

  runningCount(batch) {
    return batch.tasks.filter((task) => this.children.has(this.processKey(batch.id, task.courseId))).length;
  }

  startTask(batch, task) {
    const course = this.archiveService.getCourseRecord(task.courseId);
    const outputPath = this.archiveService.coursePath(course);
    const child = this.processRunner.startFetch({
      attachmentConcurrency: batch.options.attachmentConcurrency,
      base: batch.runtime.base,
      courseId: task.courseId,
      courseName: task.courseName,
      courseTerm: course.term?.sourceName || course.term?.name || "",
      mode: batch.options.mode,
      outputPath,
      reuseValidatedCache: batch.options.reuseValidatedCache || task.retryCount > 0,
      stateFile: batch.runtime.stateFile,
    }, {
      onError: (error) => {
        this.log(task, "stderr", `Unable to start fetch: ${error.message}`);
        this.schedulePersist();
        this.emitUpdate();
      },
      onExit: (code, signal) => this.handleExit(batch, task, code, signal),
      onStderr: (line) => this.handleLine(batch, task, "stderr", line),
      onStdout: (line) => this.handleLine(batch, task, "stdout", line),
    });
    const key = this.processKey(batch.id, task.courseId);
    this.children.set(key, child);
    task.status = "running";
    task.startedAt ||= this.nowIso();
    task.runStartedAt = this.nowIso();
    task.finishedAt = null;
    task.pausedAt = null;
    task.pausedMs = 0;
    task.processPaused = false;
    task.desiredAfterExit = null;
    task.progress = 0;
    task.completedPhases = [];
    task.currentPhase = "Starting";
    task.currentItem = "Connecting to Blackboard";
    task.exitCode = null;
    task.result = null;
    this.schedulePersist();
    this.emitUpdate();
  }

  handleExit(batch, task, code, signal) {
    this.children.delete(this.processKey(batch.id, task.courseId));
    Object.assign(task, transitionTaskAfterExit(task, { code, signal, timestamp: this.nowIso() }));
    try {
      this.archiveService.invalidate();
      const refreshed = this.archiveService.enrichCourse(this.archiveService.getCourseRecord(task.courseId));
      task.result = refreshed.archive;
      if (refreshed.archive.totalMs) task.expectedMs = refreshed.archive.totalMs;
    } catch {}
    this.finishOrPump(batch);
  }

  finishOrPump(batch) {
    const tasks = batch.tasks || [];
    const activeChildren = this.runningCount(batch);
    const queued = tasks.some((task) => task.status === "queued");
    Object.assign(batch, transitionBatchAfterTaskExit(batch, { activeChildren, timestamp: this.nowIso() }));
    this.persistNow();
    this.emitUpdate();
    if (queued && !["paused", "cancelled"].includes(batch.status)) this.scheduler.soon(() => this.pump(batch.id));
  }

  pump(batchId) {
    const batch = this.getBatch(batchId);
    if (batch.status === "paused" || batch.status === "cancelled") return;
    if (!batch.runtime?.base || !batch.runtime?.stateFile) {
      batch.status = "failed";
      batch.finishedAt = this.nowIso();
      for (const task of batch.tasks.filter((item) => item.status === "queued")) {
        task.status = "failed";
        task.currentItem = "Dashboard runtime settings were unavailable";
      }
      this.persistNow();
      this.emitUpdate();
      return;
    }
    batch.status = "running";
    batch.startedAt ||= this.nowIso();
    while (this.runningCount(batch) < batch.options.courseConcurrency) {
      const task = batch.tasks.find((item) => item.status === "queued");
      if (!task) break;
      this.startTask(batch, task);
    }
    this.schedulePersist();
    this.emitUpdate();
  }

  attachRuntime(batchId, runtime) {
    const batch = this.getBatch(batchId);
    batch.runtime = { base: runtime.base, stateFile: String(runtime.stateFile) };
    this.persistNow();
    return batch;
  }

  createAndStart(options, runtime) {
    const snapshot = this.createBatch(options);
    const batch = this.attachRuntime(snapshot.id, runtime);
    this.scheduler.soon(() => this.pump(batch.id));
    return this.snapshotBatch(batch);
  }

  signalTask(batch, task, signal) {
    const child = this.children.get(this.processKey(batch.id, task.courseId));
    if (!child) return false;
    return this.processRunner.signal(child, signal);
  }

  controlTask(batchId, courseId, action) {
    const batch = this.getBatch(batchId);
    const task = this.getTask(batch, courseId);
    if (action === "resume") {
      const otherActive = this.activeBatch();
      if (otherActive && otherActive.id !== batch.id) {
        throw httpError(409, "Another fetch batch is active");
      }
    }
    if (action === "pause") {
      if (task.status === "queued") {
        task.status = "paused";
        task.currentPhase = "Paused";
        task.currentItem = "Waiting until you resume this course";
      } else if (task.status === "running") {
        if (!this.processRunner.supportsLivePause) {
          task.status = "pausing";
          task.desiredAfterExit = "paused";
          this.signalTask(batch, task, "SIGTERM");
        } else if (this.signalTask(batch, task, "SIGSTOP")) {
          task.status = "paused";
          task.processPaused = true;
          task.pausedAt = this.nowIso();
          task.currentPhase = "Paused";
        }
      }
    } else if (action === "resume") {
      if (task.status === "paused" && task.processPaused) {
        if (this.signalTask(batch, task, "SIGCONT")) {
          task.status = "running";
          task.processPaused = false;
          task.pausedMs += this.nowMs() - Date.parse(task.pausedAt);
          task.pausedAt = null;
          task.currentPhase = task.completedPhases.at(-1) || "Working";
        }
      } else if (["paused", "interrupted", "failed", "incomplete", "cancelled"].includes(task.status)) {
        task.status = "queued";
        task.retryCount += 1;
        task.finishedAt = null;
        task.currentPhase = "Queued for repair";
        task.currentItem = "Completed files will be hash-validated and reused";
        batch.status = "running";
        batch.finishedAt = null;
      }
    } else if (action === "cancel") {
      if (["queued", "paused", "interrupted"].includes(task.status) && !this.children.has(this.processKey(batch.id, task.courseId))) {
        task.status = "cancelled";
        task.finishedAt = this.nowIso();
        task.currentPhase = "Cancelled";
        task.currentItem = "No process is running";
      } else if (["running", "paused", "pausing"].includes(task.status)) {
        task.desiredAfterExit = "cancelled";
        task.currentPhase = "Cancelling";
        if (task.processPaused) this.signalTask(batch, task, "SIGCONT");
        this.signalTask(batch, task, "SIGTERM");
        this.scheduler.delay(() => {
          if (this.children.has(this.processKey(batch.id, task.courseId))) this.signalTask(batch, task, "SIGKILL");
        }, 5_000);
      }
    } else {
      throw httpError(400, "Unsupported task action");
    }
    this.persistNow();
    this.emitUpdate();
    if (action === "resume") this.scheduler.soon(() => this.pump(batch.id));
    else this.finishOrPump(batch);
    return this.snapshotBatch(batch);
  }

  controlBatch(batchId, action) {
    const batch = this.getBatch(batchId);
    if (action === "pause") {
      batch.status = "paused";
      for (const task of batch.tasks.filter((item) => ["queued", "running"].includes(item.status))) {
        this.controlTask(batchId, task.courseId, "pause");
      }
    } else if (action === "resume") {
      const otherActive = this.activeBatch();
      if (otherActive && otherActive.id !== batch.id) {
        throw httpError(409, "Another fetch batch is active");
      }
      batch.status = "running";
      batch.finishedAt = null;
      for (const task of batch.tasks.filter((item) => ["paused", "interrupted"].includes(item.status))) {
        this.controlTask(batchId, task.courseId, "resume");
      }
      this.scheduler.soon(() => this.pump(batch.id));
    } else if (action === "cancel") {
      batch.status = "cancelled";
      batch.finishedAt = this.nowIso();
      for (const task of batch.tasks.filter((item) => !TERMINAL_TASK_STATES.has(item.status))) {
        this.controlTask(batchId, task.courseId, "cancel");
      }
    } else {
      throw httpError(400, "Unsupported batch action");
    }
    this.persistNow();
    this.emitUpdate();
    return this.snapshotBatch(batch);
  }

  stopAll() {
    for (const batch of this.batches) {
      for (const task of batch.tasks || []) {
        if (!this.children.has(this.processKey(batch.id, task.courseId))) continue;
        task.desiredAfterExit = "cancelled";
        if (task.processPaused) this.signalTask(batch, task, "SIGCONT");
        this.signalTask(batch, task, "SIGTERM");
      }
    }
  }
}

module.exports = { JobManager, PHASES, PROGRESS_PREFIX };
