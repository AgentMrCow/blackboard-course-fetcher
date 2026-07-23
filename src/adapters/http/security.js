const { httpError } = require("../../shared/http-error");

function isLoopbackHost(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "::ffff:127.0.0.1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function assertLocalRequestHost(request) {
  try {
    const hostname = new URL(`http://${request.headers.host || ""}`).hostname;
    if (isLoopbackHost(hostname)) return;
  } catch {}
  throw httpError(403, "Dashboard requests must use a loopback host");
}

function assertMutationOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw httpError(403, "Cross-origin dashboard request rejected");
  }
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host === request.headers.host) return;
  } catch {}
  throw httpError(403, "Cross-origin dashboard request rejected");
}

module.exports = { assertLocalRequestHost, assertMutationOrigin, isLoopbackHost };
