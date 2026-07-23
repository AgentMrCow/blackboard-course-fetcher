const {
  isBlackboardAuthenticationRedirect,
} = require("../../domain/course-fetch/blackboard-attachment-policy");
const { launchChromium } = require("../system/playwright-runtime");

class PlaywrightQuizReviewGateway {
  constructor({
    base,
    stateFile,
    launchBrowser = (options) => launchChromium(options),
    navigationTimeoutMs = 30000,
  }) {
    if (!base || !stateFile || typeof launchBrowser !== "function") {
      throw new Error("PlaywrightQuizReviewGateway requires base, stateFile, and launchBrowser");
    }
    this.base = base;
    this.stateFile = stateFile;
    this.launchBrowser = launchBrowser;
    this.navigationTimeoutMs = navigationTimeoutMs;
  }

  async fetchAll(requests) {
    let browser;
    let context;
    try {
      browser = await this.launchBrowser({ headless: true });
      context = await browser.newContext({ storageState: this.stateFile });
      const page = await context.newPage();
      const results = [];
      for (const request of requests) {
        try {
          const response = await page.goto(request.url, {
            waitUntil: "domcontentloaded",
            timeout: this.navigationTimeoutMs,
          });
          if (!response?.ok()) {
            throw new Error(`Classic quiz review returned HTTP ${response?.status() || "unknown"}`);
          }
          if (isBlackboardAuthenticationRedirect(page.url(), this.base)) {
            throw new Error(
              "Saved Blackboard session expired before the quiz review browser fallback ran"
            );
          }
          results.push({
            id: request.id,
            finalUrl: page.url(),
            html: await page.content(),
          });
        } catch (error) {
          results.push({ id: request.id, error: error.message });
        }
      }
      return results;
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

module.exports = { PlaywrightQuizReviewGateway };
