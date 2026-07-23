const path = require("path");
const { createDefaultSettings } = require("../../application/dashboard-settings");
const { readJson, writeJson } = require("./json-file-store");

class SettingsRepository {
  constructor({ scriptDirectory, settingsFile, environment = process.env }) {
    this.scriptDirectory = path.resolve(scriptDirectory);
    this.settingsFile = path.resolve(settingsFile);
    this.environment = environment;
  }

  defaults() {
    const archiveRoot = path.join(this.scriptDirectory, "Blackboard_Archive");
    const blackboardBase = readJson(path.join(archiveRoot, "courses.json"), {})?.blackboardBase || "";
    return createDefaultSettings({
      scriptDirectory: this.scriptDirectory,
      blackboardBase,
      environment: this.environment,
    });
  }

  load() {
    return { ...this.defaults(), ...(readJson(this.settingsFile, {}) || {}) };
  }

  save(settings) {
    writeJson(this.settingsFile, settings);
    return settings;
  }
}

module.exports = { SettingsRepository };
