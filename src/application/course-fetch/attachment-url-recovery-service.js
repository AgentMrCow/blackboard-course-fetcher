const {
  blackboardXid,
  canonicalizeEmbeddedBlackboardUrl,
  matchingBlackboardResourceUrls,
} = require("../../domain/course-fetch/blackboard-attachment-policy");

class AttachmentUrlRecoveryService {
  constructor({ base, resolveUrl, strategies = [] }) {
    if (!base || typeof resolveUrl !== "function") {
      throw new Error("AttachmentUrlRecoveryService requires base and resolveUrl");
    }
    this.base = base;
    this.resolveUrl = resolveUrl;
    this.strategies = strategies.filter((strategy) => strategy?.gateway);
  }

  async recover(file) {
    const originalUrl = this.resolveUrl(file.url);
    const xid = blackboardXid(originalUrl, this.base);
    const uiUrls = file.uiContext?.uiUrls || [];
    const candidatesByMethod = new Map();
    const diagnostics = [];
    const addCandidates = (values, method) => {
      for (const candidate of matchingBlackboardResourceUrls(values, originalUrl, this.base)) {
        if (!candidatesByMethod.has(candidate)) candidatesByMethod.set(candidate, method);
      }
    };
    const hasReplacement = () =>
      [...candidatesByMethod.keys()].some((candidate) => candidate !== originalUrl);

    if (xid && uiUrls.length) {
      for (const strategy of this.strategies) {
        if (hasReplacement()) break;
        try {
          const result = await strategy.gateway.discover({ targetUrl: originalUrl, uiUrls, xid });
          addCandidates(result?.values || [], strategy.method);
          diagnostics.push(...(result?.diagnostics || []));
        } catch (error) {
          diagnostics.push(`${strategy.failureLabel || strategy.method}: ${error.message}`);
        }
      }
    } else if (!xid) {
      diagnostics.push("No Blackboard xid was available for exact UI resource matching");
    } else {
      diagnostics.push("No authenticated UI page was available for this attachment context");
    }

    const ownerCandidate = canonicalizeEmbeddedBlackboardUrl(originalUrl, this.base, file.uiContext);
    if (ownerCandidate !== originalUrl && !candidatesByMethod.has(ownerCandidate)) {
      candidatesByMethod.set(ownerCandidate, "Blackboard owner URL rule");
    }

    const candidates = matchingBlackboardResourceUrls(
      [...candidatesByMethod.keys()],
      originalUrl,
      this.base
    )
      .filter((candidate) => candidate !== originalUrl)
      .map((url) => ({
        url,
        method: candidatesByMethod.get(url) || "Blackboard resource resolver",
      }));
    return { candidates, diagnostics };
  }
}

module.exports = { AttachmentUrlRecoveryService };
