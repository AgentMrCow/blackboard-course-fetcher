const {
  blackboardResourceUrlsFromText,
  isBlackboardAuthenticationRedirect,
  uiPageLabel,
} = require("../../domain/course-fetch/blackboard-attachment-policy");

class BlackboardAttachmentHtmlGateway {
  constructor({ base, client }) {
    if (!base || !client?.request || !client?.cookieHeaderFor) {
      throw new Error("BlackboardAttachmentHtmlGateway requires base and client");
    }
    this.base = base;
    this.client = client;
  }

  async discover({ targetUrl, uiUrls }) {
    const values = [];
    const diagnostics = [];
    for (const uiUrl of uiUrls) {
      const label = uiPageLabel(uiUrl, this.base);
      try {
        const response = await this.client.request(
          uiUrl,
          {
            redirect: "follow",
            headers: {
              Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
              Cookie: this.client.cookieHeaderFor(uiUrl),
              "User-Agent": "Mozilla/5.0",
            },
          },
          `attachment resolver ${label}`
        );
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (isBlackboardAuthenticationRedirect(response.url, this.base)) {
          throw new Error("redirected outside the authenticated Blackboard UI");
        }
        const matches = blackboardResourceUrlsFromText(await response.text(), targetUrl, this.base);
        values.push(...matches);
        diagnostics.push(`${label}: HTTP ${response.status}, ${matches.length} exact resource match(es)`);
        if (matches.some((candidate) => candidate !== targetUrl)) break;
      } catch (error) {
        diagnostics.push(`${label}: HTTP resolver failed (${error.message})`);
      }
    }
    return { values, diagnostics };
  }
}

module.exports = { BlackboardAttachmentHtmlGateway };
