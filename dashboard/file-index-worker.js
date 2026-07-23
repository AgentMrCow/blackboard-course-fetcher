const fs = require("fs");
const path = require("path");
const { buildArchiveFileIndex } = require("../src/application/archive/build-file-index");
const { createFileSystemArchiveService } = require("../src/composition/archive-service-factory");

function send(type, details = {}) {
  if (process.connected) process.send({ type, ...details });
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function main() {
  const archiveRoot = path.resolve(process.env.BB_ARCHIVE_ROOT || "Blackboard_Archive");
  const outputFile = path.resolve(process.env.BB_FILE_INDEX || ".dashboard-data/file-index.json");
  const service = createFileSystemArchiveService(archiveRoot);
  const index = buildArchiveFileIndex({
    archiveService: service,
    onProgress: (progress) => send("progress", progress),
  });
  writeAtomic(outputFile, index);
  send("complete", { outputFile, courseCount: index.courseCount, fileCount: index.fileCount, bytes: index.bytes });
}

try {
  main();
} catch (error) {
  send("error", { message: error.message });
  console.error(error.stack || error.message);
  process.exit(1);
}
