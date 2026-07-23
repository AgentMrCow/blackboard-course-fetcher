const path = require("path");
const { readJson, writeJson } = require("./json-file-store");

class JsonJobRepository {
  constructor({ file, historyLimit = 30 }) {
    this.file = path.resolve(file);
    this.historyLimit = historyLimit;
  }

  load() {
    const parsed = readJson(this.file, { batches: [] });
    return Array.isArray(parsed?.batches) ? parsed.batches.slice(0, this.historyLimit) : [];
  }

  save(batches) {
    const serializable = (Array.isArray(batches) ? batches : []).slice(0, this.historyLimit).map((batch) => ({
      ...batch,
      tasks: (batch.tasks || []).map(({ processPaused, ...task }) => ({
        ...task,
        processPaused: Boolean(processPaused),
      })),
    }));
    writeJson(this.file, { schemaVersion: 1, batches: serializable });
  }
}

module.exports = { JsonJobRepository };
