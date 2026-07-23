function canonicalizeEmbeddedBlackboardUrl(value, base, owner = null) {
  const absolute = new URL(value, base);
  const blackboard = new URL(base);
  if (absolute.origin !== blackboard.origin || owner?.type !== "announcement") {
    return absolute.toString();
  }

  const xidMatch = absolute.pathname.match(/^\/bbcswebdav\/xid-(\d+_\d+)\/?$/i);
  const announcementMatch = String(owner.id || "").match(/^_(\d+)_\d+$/);
  if (!xidMatch || !announcementMatch) return absolute.toString();

  const resourceId = xidMatch[1];
  absolute.pathname =
    `/bbcswebdav/pid-${announcementMatch[1]}-dt-announcement-rid-${resourceId}` +
    `/xid-${resourceId}`;
  return absolute.toString();
}

function blackboardXid(value, base) {
  try {
    const url = new URL(value, base);
    return url.pathname.match(/(?:^|\/)xid-(\d+_\d+)(?:\/|$)/i)?.[1] || null;
  } catch {
    return null;
  }
}

function matchingBlackboardResourceUrls(values, targetUrl, base) {
  const blackboard = new URL(base);
  const targetXid = blackboardXid(targetUrl, base);
  if (!targetXid) return [];

  const matches = new Map();
  for (const value of values || []) {
    let candidate;
    try {
      candidate = new URL(value, base);
    } catch {
      continue;
    }
    if (
      candidate.origin !== blackboard.origin ||
      !candidate.pathname.startsWith("/bbcswebdav/") ||
      blackboardXid(candidate, base) !== targetXid
    ) {
      continue;
    }
    matches.set(candidate.toString(), candidate);
  }

  return [...matches.values()]
    .sort((left, right) => {
      const rank = (url) => {
        if (/\/bbcswebdav\/pid-/i.test(url.pathname)) return 0;
        if (/\/bbcswebdav\/internal\//i.test(url.pathname)) return 1;
        return 2;
      };
      return rank(left) - rank(right) || left.toString().localeCompare(right.toString());
    })
    .map((url) => url.toString());
}

function blackboardResourceUrlsFromText(value, targetUrl, base) {
  const normalized = String(value || "")
    .replace(/\\\//g, "/")
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, "&");
  const candidates = normalized.match(/(?:https?:\/\/[^\s"'<>]+)?\/bbcswebdav\/[^\s"'<>]+/gi) || [];
  return matchingBlackboardResourceUrls(candidates, targetUrl, base);
}

function safeHeaderFilename(value, decodePercentEncoding) {
  let filename = String(value || "").trim();
  if (!filename) return null;
  if (decodePercentEncoding) {
    const encodedValue = filename.match(/^[^']*'[^']*'(.*)$/)?.[1] ?? filename;
    try {
      filename = decodeURIComponent(encodedValue);
    } catch {
      filename = encodedValue;
    }
  }
  filename = filename
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return filename && filename !== "." ? filename : null;
}

function filenameFromContentDisposition(value) {
  const header = String(value || "");
  const extended = header.match(/(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  if (extended) {
    const filename = safeHeaderFilename(extended[1] ?? extended[2], true);
    if (filename) return filename;
  }

  const basic = header.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i);
  if (!basic) return null;
  const raw = (basic[1] ?? basic[2] ?? "").replace(/\\(["\\])/g, "$1");
  return safeHeaderFilename(raw, false);
}

function isOpaqueBlackboardFilename(value) {
  return /^xid-\d+_\d+$/i.test(String(value || ""));
}

function isBlackboardAuthenticationRedirect(value, base) {
  try {
    const current = new URL(value, base);
    const blackboard = new URL(base);
    return (
      current.origin !== blackboard.origin ||
      /(?:^|\/)(?:login|authenticate|sso)(?:\/|$)/i.test(current.pathname)
    );
  } catch {
    return true;
  }
}

function uiPageLabel(value, base) {
  try {
    const url = new URL(value, base);
    return `${url.pathname}${url.search}`;
  } catch {
    return "invalid UI URL";
  }
}

module.exports = {
  blackboardResourceUrlsFromText,
  blackboardXid,
  canonicalizeEmbeddedBlackboardUrl,
  filenameFromContentDisposition,
  isBlackboardAuthenticationRedirect,
  isOpaqueBlackboardFilename,
  matchingBlackboardResourceUrls,
  uiPageLabel,
};
