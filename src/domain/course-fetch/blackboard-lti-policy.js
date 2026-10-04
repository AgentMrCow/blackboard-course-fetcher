function isLtiHandler(value) {
  return /^resource\/x-bb-blti/i.test(String(value || ""));
}

function ltiDetail(item) {
  const handler = String(item?.contentHandler || "");
  if (handler && item?.contentDetail?.[handler]) return item.contentDetail[handler];
  return Object.entries(item?.contentDetail || {}).find(([key]) => isLtiHandler(key))?.[1] || null;
}

function requiresAssessmentArchive(item) {
  const handler = item?.handler || item?.contentHandler || "";
  if (handler === "resource/x-bb-assignment" || handler === "resource/x-bb-asmt-test-link") {
    return true;
  }
  return isLtiHandler(handler) && Boolean(item?.gradingColumnId || ltiDetail(item)?.gradingColumn?.id);
}

function hostname(value) {
  if (!value) return null;
  try {
    const text = String(value);
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function ltiProviderHost({ actionUrl = null, detail = null } = {}) {
  return (
    hostname(actionUrl) ||
    hostname(detail?.url) ||
    hostname(detail?.domainConfig?.primaryDomain) ||
    null
  );
}

function isH5pLti({ actionUrl = null, detail = null } = {}) {
  const hosts = [
    hostname(actionUrl),
    hostname(detail?.url),
    hostname(detail?.domainConfig?.primaryDomain),
  ].filter(Boolean);
  return (
    hosts.some((host) => host === "h5p.com" || host.endsWith(".h5p.com")) ||
    /\bh5p\b/i.test(String(detail?.placementHandle || ""))
  );
}

function buildLtiLaunchUrl({ base, contentId, courseId, detail = null }) {
  if (!base || !courseId || !contentId) {
    throw new TypeError("Building an LTI launch URL requires base, courseId, and contentId");
  }
  if (detail?.launchLink) return new URL(detail.launchLink, base).toString();
  const url = new URL("/webapps/blackboard/execute/blti/launchLink", base);
  url.searchParams.set("course_id", courseId);
  url.searchParams.set("content_id", contentId);
  return url.toString();
}

module.exports = {
  buildLtiLaunchUrl,
  isH5pLti,
  isLtiHandler,
  ltiDetail,
  ltiProviderHost,
  requiresAssessmentArchive,
};
