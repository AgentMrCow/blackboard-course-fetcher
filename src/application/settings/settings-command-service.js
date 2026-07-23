const { httpError } = require("../../shared/http-error");
const { normalizeDashboardSettings } = require("../dashboard-settings");

class SettingsCommandService {
  constructor({
    authentication,
    createArchiveService,
    ensureArchiveRoot,
    fileIndexCoordinator,
    inventoryCoordinator,
    jobs,
    scriptDirectory,
    settings,
    settingsRepository,
  }) {
    if (!authentication) throw new TypeError("SettingsCommandService requires authentication");
    if (!createArchiveService) throw new TypeError("SettingsCommandService requires createArchiveService");
    if (!ensureArchiveRoot) throw new TypeError("SettingsCommandService requires ensureArchiveRoot");
    if (!fileIndexCoordinator) throw new TypeError("SettingsCommandService requires fileIndexCoordinator");
    if (!inventoryCoordinator) throw new TypeError("SettingsCommandService requires inventoryCoordinator");
    if (!jobs) throw new TypeError("SettingsCommandService requires jobs");
    if (!scriptDirectory) throw new TypeError("SettingsCommandService requires scriptDirectory");
    if (!settings) throw new TypeError("SettingsCommandService requires settings");
    if (!settingsRepository) throw new TypeError("SettingsCommandService requires settingsRepository");
    this.authentication = authentication;
    this.createArchiveService = createArchiveService;
    this.ensureArchiveRoot = ensureArchiveRoot;
    this.fileIndexCoordinator = fileIndexCoordinator;
    this.inventoryCoordinator = inventoryCoordinator;
    this.jobs = jobs;
    this.scriptDirectory = scriptDirectory;
    this.settings = settings;
    this.settingsRepository = settingsRepository;
  }

  update(input = {}) {
    if (this.jobs.activeBatch() || this.authentication.active() || this.inventoryCoordinator.active()) {
      throw httpError(409, "Archive settings cannot change while a background task is active");
    }

    const settings = normalizeDashboardSettings(input, this.settings, {
      scriptDirectory: this.scriptDirectory,
    });
    this.ensureArchiveRoot(settings.archiveRoot);
    const archiveService = this.createArchiveService(settings.archiveRoot);
    this.settingsRepository.save(settings);

    this.jobs.setArchiveService(archiveService);
    this.authentication.setSettings(settings);
    this.inventoryCoordinator.setSettings(settings);
    this.inventoryCoordinator.setArchiveService(archiveService);
    this.fileIndexCoordinator.reconfigure({ archiveService, settings });
    this.settings = settings;

    return { archiveService, settings };
  }
}

module.exports = { SettingsCommandService };
