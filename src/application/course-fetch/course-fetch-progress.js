const PROGRESS_PREFIX = "@@BB_PROGRESS@@";

class CourseFetchProgressReporter {
  constructor({
    clock = () => new Date(),
    elapsedNow = () => Date.now(),
    enabled = false,
    log = () => {},
    manifest,
    output = () => {},
    relativePath = (value) => value,
  }) {
    this.clock = clock;
    this.elapsedNow = elapsedNow;
    this.enabled = enabled;
    this.log = log;
    this.manifest = manifest;
    this.output = output;
    this.relativePath = relativePath;
  }

  emit(type, details = {}) {
    if (!this.enabled) return;
    this.output(
      `${PROGRESS_PREFIX}${JSON.stringify({
        type,
        at: this.clock().toISOString(),
        ...details,
      })}\n`
    );
  }

  transfer(kind, outPath, size = null, label = null) {
    this.emit("transfer", {
      kind,
      path: outPath ? this.relativePath(outPath) : null,
      size,
      label,
      transfer: { ...this.manifest.transfer },
    });
  }

  async runPhase(name, operation) {
    const startedAt = this.elapsedNow();
    this.emit("phase-start", { phase: name });
    try {
      return await operation();
    } finally {
      const durationMs = Math.round(this.elapsedNow() - startedAt);
      this.manifest.timings.phases[name] = durationMs;
      this.emit("phase-end", { phase: name, durationMs });
      this.log(`phase ${name}: ${(durationMs / 1000).toFixed(2)}s`);
    }
  }
}

module.exports = { CourseFetchProgressReporter, PROGRESS_PREFIX };
