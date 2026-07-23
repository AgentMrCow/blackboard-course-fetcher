const { ArchiveService } = require("../application/archive/archive-service");
const { FileSystemArchiveRepository } = require("../adapters/filesystem/archive-repository");

function createFileSystemArchiveService(archiveRoot, dependencies = {}) {
  const archiveRepository = dependencies.archiveRepository || new FileSystemArchiveRepository({ archiveRoot });
  return new ArchiveService({
    archiveRepository,
    clock: dependencies.clock,
  });
}

module.exports = { createFileSystemArchiveService };
