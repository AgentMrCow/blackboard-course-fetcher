const fs = require("fs");
const { readJson } = require("../filesystem/json-file-store");

function domainMatches(hostname, domain) {
  const clean = String(domain || "").replace(/^\./, "");
  return hostname === clean || hostname.endsWith(`.${clean}`);
}

function cookieHeader(state, urlValue) {
  const url = new URL(urlValue);
  return (state.cookies || [])
    .filter((cookie) => domainMatches(url.hostname, cookie.domain))
    .filter((cookie) => !cookie.path || url.pathname.startsWith(cookie.path))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function stateMetadata(settings) {
  if (!fs.existsSync(settings.stateFile)) {
    return { exists: false, stateFile: settings.stateFile, cookieCount: 0, modifiedAt: null, expiresAt: null, expiredCookies: 0 };
  }
  const state = readJson(settings.stateFile, { cookies: [] });
  const stat = fs.statSync(settings.stateFile);
  const expirations = (state.cookies || []).map((cookie) => Number(cookie.expires)).filter((value) => value > 0);
  const nowSeconds = Date.now() / 1000;
  return {
    exists: true,
    stateFile: settings.stateFile,
    cookieCount: state.cookies?.length || 0,
    modifiedAt: stat.mtime.toISOString(),
    expiresAt: expirations.length ? new Date(Math.max(...expirations) * 1000).toISOString() : null,
    expiredCookies: expirations.filter((expires) => expires <= nowSeconds).length,
  };
}

async function validateState(settings, { fetchImpl = fetch } = {}) {
  const metadata = stateMetadata(settings);
  if (!metadata.exists) return { ...metadata, valid: false, message: "No saved Blackboard session" };
  if (!settings.blackboardBase) return { ...metadata, valid: false, message: "Set the Blackboard URL first" };
  const state = readJson(settings.stateFile, { cookies: [] });
  const url = new URL("/learn/api/v1/users/me", settings.blackboardBase);
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader(state, url),
        "User-Agent": "Mozilla/5.0 Blackboard Archive Dashboard",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const contentType = response.headers.get("content-type") || "";
    let user = null;
    if (response.ok && contentType.includes("json")) user = await response.json().catch(() => null);
    return {
      ...metadata,
      valid: Boolean(user?.id),
      httpStatus: response.status,
      user: user
        ? { id: user.id, userName: user.userName || null, givenName: user.name?.given || null, familyName: user.name?.family || null }
        : null,
      message: user?.id ? "Blackboard session is valid" : "Blackboard requires sign-in again",
    };
  } catch (error) {
    return { ...metadata, valid: false, message: `Session check failed: ${error.message}` };
  }
}

module.exports = { cookieHeader, domainMatches, stateMetadata, validateState };
