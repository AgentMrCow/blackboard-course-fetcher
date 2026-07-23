const { cookieHeader } = require("./session-state");
const {
  isBlackboardAuthenticationRedirect,
} = require("../../domain/course-fetch/blackboard-attachment-policy");

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const STRICT_PAGINATION_POLICY = Object.freeze({
  continueWithoutCount: false,
  enforceExactCount: true,
  rejectDuplicateIds: true,
  stopOnEmptyPage: false,
});
const INVENTORY_PAGINATION_POLICY = Object.freeze({
  continueWithoutCount: true,
  enforceExactCount: false,
  rejectDuplicateIds: false,
  stopOnEmptyPage: true,
});

class BlackboardAuthenticationError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = "BlackboardAuthenticationError";
    this.code = "BLACKBOARD_AUTHENTICATION_REQUIRED";
    this.status = status;
    this.url = url;
  }
}

class BlackboardResponseFormatError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = "BlackboardResponseFormatError";
    this.code = "BLACKBOARD_INVALID_RESPONSE";
    this.status = status;
    this.url = url;
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function calculateRetryDelay(response, attempt, now = Date.now()) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 10000);
    const date = new Date(retryAfter).getTime();
    if (Number.isFinite(date)) return Math.min(Math.max(date - now, 0), 10000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 5000);
}

function responseDestination(response, requestedUrl) {
  const location = response?.headers?.get?.("location");
  const value = location || response?.url;
  if (!value) return requestedUrl;
  try {
    return new URL(value, requestedUrl);
  } catch {
    return requestedUrl;
  }
}

function looksLikeHtml(value) {
  return /^\s*(?:<!doctype\s+html|<html|<head|<body|<form)\b/i.test(String(value || ""));
}

function isAuthenticationResponse(response, requestedUrl, base, body = "") {
  if (response?.status === 401) return true;
  const destination = responseDestination(response, requestedUrl);
  const redirected = response?.redirected || (response?.status >= 300 && response?.status < 400);
  if (redirected && isBlackboardAuthenticationRedirect(destination, base)) return true;

  const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
  return Boolean(response?.ok && (contentType.includes("text/html") || looksLikeHtml(body)));
}

function createBlackboardRestClient({
  base,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  describeErrorUrl = (url) => url.toString(),
  fetchImpl = fetch,
  maxAttempts = 4,
  maxPages = 1000,
  now = () => Date.now(),
  paginationPolicy = STRICT_PAGINATION_POLICY,
  resolveUrl,
  state = { cookies: [] },
  warn = () => {},
}) {
  const {
    continueWithoutCount,
    enforceExactCount,
    rejectDuplicateIds,
    stopOnEmptyPage,
  } = paginationPolicy;
  const resolve = (value) => {
    const resolved = resolveUrl ? resolveUrl(value) : new URL(value, base);
    return resolved instanceof URL ? new URL(resolved.toString()) : new URL(String(resolved), base);
  };

  function cookieHeaderFor(value) {
    return cookieHeader(state, resolve(value));
  }

  function retryDelay(response, attempt) {
    return calculateRetryDelay(response, attempt, now());
  }

  async function request(urlValue, options = {}, label = null, requestMaxAttempts = maxAttempts) {
    const url = resolve(urlValue);
    const requestLabel = label || url.pathname;
    let lastError = null;
    for (let attempt = 1; attempt <= requestMaxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, options);
        const retryable = RETRYABLE_STATUS_CODES.has(response.status);
        if (!retryable || attempt === requestMaxAttempts) return response;

        const milliseconds = retryDelay(response, attempt);
        await response.body?.cancel().catch(() => {});
        warn(
          `retrying ${requestLabel} after HTTP ${response.status} ` +
            `(${attempt}/${requestMaxAttempts}, ${milliseconds} ms)`
        );
        await delay(milliseconds);
      } catch (error) {
        lastError = error;
        if (attempt === requestMaxAttempts) throw error;
        const milliseconds = retryDelay(null, attempt);
        warn(
          `retrying ${requestLabel} after ${error.message} ` +
            `(${attempt}/${requestMaxAttempts}, ${milliseconds} ms)`
        );
        await delay(milliseconds);
      }
    }
    throw lastError || new Error(`Failed to fetch ${url}`);
  }

  async function get(apiPath) {
    const url = resolve(apiPath);
    const response = await request(
      url,
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          Cookie: cookieHeaderFor(url),
          "User-Agent": "Mozilla/5.0",
        },
      },
      `Blackboard API ${url.pathname}`
    );
    const body = await response.text().catch(() => "");
    const errorUrl = String(describeErrorUrl(url));
    if (isAuthenticationResponse(response, url, base, body)) {
      throw new BlackboardAuthenticationError(
        `Blackboard authentication is required for ${errorUrl}; refresh the saved session`,
        { status: response.status, url: errorUrl }
      );
    }
    if (!response.ok) {
      throw new Error(
        `GET ${errorUrl} failed: ${response.status} ${response.statusText} ${body.slice(0, 200)}`
      );
    }
    try {
      return JSON.parse(body);
    } catch {
      const contentType = response.headers?.get?.("content-type") || "unknown content type";
      throw new BlackboardResponseFormatError(
        `Blackboard API ${errorUrl} returned invalid JSON (${contentType})`,
        { status: response.status, url: errorUrl }
      );
    }
  }

  function advanceOffset(pageUrl, paging) {
    const limit = finiteNumber(paging.limit) || finiteNumber(pageUrl.searchParams.get("limit")) || 100;
    const offset = finiteNumber(paging.offset) ?? finiteNumber(pageUrl.searchParams.get("offset")) ?? 0;
    const nextUrl = new URL(pageUrl);
    nextUrl.searchParams.set("limit", String(limit));
    nextUrl.searchParams.set("offset", String(offset + limit));
    return nextUrl;
  }

  async function all(firstUrl) {
    const results = [];
    const seenPages = new Set();
    const seenIds = new Set();
    let expectedCount = null;
    let pageUrl = resolve(firstUrl);
    if (!pageUrl.searchParams.has("limit")) pageUrl.searchParams.set("limit", "100");
    if (!pageUrl.searchParams.has("offset")) pageUrl.searchParams.set("offset", "0");

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const normalizedUrl = pageUrl.toString();
      if (seenPages.has(normalizedUrl)) {
        throw new Error(`Pagination loop detected for ${firstUrl}`);
      }
      seenPages.add(normalizedUrl);

      const data = await get(normalizedUrl);
      if (!Array.isArray(data.results)) {
        throw new Error(`Paginated response has no results array: ${normalizedUrl}`);
      }

      for (const item of data.results) {
        if (rejectDuplicateIds && item?.id && seenIds.has(item.id)) {
          throw new Error(`Duplicate result ${item.id} while paginating ${firstUrl}`);
        }
        if (item?.id) seenIds.add(item.id);
        results.push(item);
      }

      const paging = data.paging || {};
      const pageCount = finiteNumber(paging.count);
      if (expectedCount === null && pageCount !== null) expectedCount = pageCount;

      if (expectedCount !== null && results.length >= expectedCount) {
        if (enforceExactCount && results.length !== expectedCount) {
          throw new Error(
            `Pagination count mismatch for ${firstUrl}: expected ${expectedCount}, received ${results.length}`
          );
        }
        return results;
      }

      if (paging.nextPage) {
        pageUrl = resolve(paging.nextPage);
        continue;
      }

      if (stopOnEmptyPage && data.results.length === 0) return results;

      if (pageCount !== null && results.length < pageCount) {
        pageUrl = advanceOffset(pageUrl, paging);
        continue;
      }

      if (expectedCount !== null && results.length !== expectedCount && enforceExactCount) {
        throw new Error(
          `Pagination count mismatch for ${firstUrl}: expected ${expectedCount}, received ${results.length}`
        );
      }

      if (continueWithoutCount && data.results.length > 0) {
        pageUrl = advanceOffset(pageUrl, paging);
        continue;
      }
      return results;
    }

    throw new Error(`Pagination guard tripped for ${firstUrl}`);
  }

  return {
    all,
    cookieHeaderFor,
    get,
    request,
    retryDelay,
  };
}

module.exports = {
  BlackboardAuthenticationError,
  BlackboardResponseFormatError,
  calculateRetryDelay,
  createBlackboardRestClient,
  INVENTORY_PAGINATION_POLICY,
  isAuthenticationResponse,
  RETRYABLE_STATUS_CODES,
  STRICT_PAGINATION_POLICY,
};
