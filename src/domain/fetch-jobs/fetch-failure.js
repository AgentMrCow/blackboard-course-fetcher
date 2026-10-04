function describeFetchFailure(value) {
  const details = String(value || "").trim().slice(0, 4000);
  if (!details) return null;
  if (/bb-rest-course-is-private|the course is not available/i.test(details)) {
    return {
      code: "course-unavailable",
      message: "Course unavailable (HTTP 403). Check that you can open it on Blackboard before retrying.",
      details,
    };
  }
  if (/authentication is required|401\s+Unauthorized|refresh the saved session|missing session state/i.test(details)) {
    return {
      code: "session-required",
      message: "Blackboard sign-in is required. Refresh the saved session in Setup, then retry.",
      details,
    };
  }
  if (/\b403\s+Forbidden\b|HTTP\s+403\b/i.test(details)) {
    return {
      code: "permission-denied",
      message: "Access denied (HTTP 403). Check your permission to view this resource on Blackboard.",
      details,
    };
  }
  return {
    code: "fetch-error",
    message: details.replace(/^[A-Za-z]*Error:\s*/, "").replace(/\s+/g, " ").slice(0, 900),
    details,
  };
}

function failureFromTaskLogs(task) {
  const startedAt = Date.parse(task.runStartedAt || task.startedAt);
  const lines = (task.logs || []).filter((entry) =>
    entry.stream === "stderr" && (!Number.isFinite(startedAt) || Date.parse(entry.at) >= startedAt)
  ).map((entry) => String(entry.line || "").trim()).filter((line) =>
    line && !/^(?:at\s|Previous manifest retained;|retrying\s|WARN(?:ING)?\b|\^|Node\.js v|\(node:)/i.test(line)
  );
  const error = lines.findLast((line) => /^(?:[A-Za-z]*Error:|Unable to start fetch:)/.test(line));
  return describeFetchFailure(error || lines[0]);
}

module.exports = { describeFetchFailure, failureFromTaskLogs };
