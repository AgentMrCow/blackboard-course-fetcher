const {
  isBlackboardAuthenticationRedirect,
} = require("../../domain/course-fetch/blackboard-attachment-policy");
const { launchChromium } = require("../system/playwright-runtime");

class PlaywrightFeedbackDownloadGateway {
  constructor({
    base,
    stateFile,
    launchBrowser = (options) => launchChromium(options),
    timeoutMs = 30000,
  }) {
    if (!base || !stateFile || typeof launchBrowser !== "function") {
      throw new Error("PlaywrightFeedbackDownloadGateway requires base, stateFile, and launchBrowser");
    }
    this.base = base;
    this.stateFile = stateFile;
    this.launchBrowser = launchBrowser;
    this.timeoutMs = timeoutMs;
  }

  async downloadAll(requests) {
    let browser;
    let context;
    try {
      browser = await this.launchBrowser({ headless: true });
      context = await browser.newContext({
        storageState: this.stateFile,
        acceptDownloads: true,
      });
      const page = await context.newPage();
      const results = [];
      for (const request of requests) {
        try {
          await page.goto(request.url, {
            waitUntil: "domcontentloaded",
            timeout: this.timeoutMs,
          });
          if (isBlackboardAuthenticationRedirect(page.url(), this.base)) {
            throw new Error("Saved Blackboard session expired before the UI fallback ran");
          }

          const feedbackButton = page.getByRole("button", {
            name: `Feedback for attempt ${request.attemptNumber}`,
            exact: true,
          });
          await feedbackButton.waitFor({ state: "visible", timeout: this.timeoutMs });
          await feedbackButton.click();

          const moreOptions = page.getByRole("button", {
            name: `More options for ${request.fileName}`,
            exact: true,
          });
          await moreOptions.waitFor({ state: "visible", timeout: this.timeoutMs });
          await moreOptions.click();

          const downloadPromise = page.waitForEvent("download", { timeout: this.timeoutMs });
          await page.getByRole("menuitem", { name: "Download", exact: true }).click();
          const download = await downloadPromise;
          await download.saveAs(request.destination);
          const failure = await download.failure();
          if (failure) throw new Error(failure);
          results.push({ id: request.id, downloadUrl: download.url() });
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

module.exports = { PlaywrightFeedbackDownloadGateway };
