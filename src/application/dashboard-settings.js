const path = require("path");
const { httpError } = require("../shared/http-error");

const DOWNLOAD_MODES = new Set(["placeholder", "full"]);

function createDefaultSettings({ scriptDirectory, blackboardBase = "", environment = process.env }) {
  const root = path.resolve(scriptDirectory);
  return {
    blackboardBase: environment.BB_BASE || blackboardBase,
    archiveRoot: path.join(root, "Blackboard_Archive"),
    stateFile: path.join(root, ".blackboard-state.json"),
    downloadMode: "placeholder",
    courseConcurrency: 1,
    attachmentConcurrency: 2,
    reuseValidatedCache: false,
  };
}

function normalizeDashboardSettings(input, current, { scriptDirectory }) {
  const next = { ...current };
  if (input.blackboardBase !== undefined) {
    next.blackboardBase = String(input.blackboardBase || "").trim().replace(/\/$/, "");
    if (next.blackboardBase && !/^https?:\/\//i.test(next.blackboardBase)) {
      throw httpError(400, "Blackboard URL must begin with http:// or https://");
    }
  }
  if (input.archiveRoot !== undefined) {
    next.archiveRoot = path.resolve(scriptDirectory, String(input.archiveRoot || "Blackboard_Archive"));
  }
  if (input.stateFile !== undefined) {
    next.stateFile = path.resolve(scriptDirectory, String(input.stateFile || ".blackboard-state.json"));
  }
  if (input.downloadMode !== undefined) {
    next.downloadMode = String(input.downloadMode).toLowerCase();
    if (!DOWNLOAD_MODES.has(next.downloadMode)) throw httpError(400, "Download mode must be placeholder or full");
  }
  for (const [key, minimum, maximum] of [["courseConcurrency", 1, 4], ["attachmentConcurrency", 1, 8]]) {
    if (input[key] === undefined) continue;
    next[key] = Number(input[key]);
    if (!Number.isInteger(next[key]) || next[key] < minimum || next[key] > maximum) {
      throw httpError(400, `${key} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  if (input.reuseValidatedCache !== undefined) next.reuseValidatedCache = input.reuseValidatedCache === true;
  return next;
}

module.exports = { createDefaultSettings, DOWNLOAD_MODES, normalizeDashboardSettings };
