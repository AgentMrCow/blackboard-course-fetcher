const {
  isBlackboardAuthenticationRedirect,
} = require("../../domain/course-fetch/blackboard-attachment-policy");
const { launchChromium } = require("../system/playwright-runtime");

const DOWNLOAD_SELECTOR = 'a[href*="/webapps/assignment/download?"]';
const BLOCKED_RESOURCE_TYPES = new Set(["font", "image", "media"]);

class PlaywrightClassicSubmissionGateway {
  constructor({
    base,
    stateFile,
    launchBrowser = (options) => launchChromium(options),
    navigationTimeoutMs = 30000,
    selectorTimeoutMs = 12000,
    settleMs = 500,
  }) {
    if (!base || !stateFile || typeof launchBrowser !== "function") {
      throw new Error("PlaywrightClassicSubmissionGateway requires base, stateFile, and launchBrowser");
    }
    this.base = base;
    this.stateFile = stateFile;
    this.launchBrowser = launchBrowser;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.selectorTimeoutMs = selectorTimeoutMs;
    this.settleMs = settleMs;
  }

  async discoverAll(requests, { blockHeavyResources = false } = {}) {
    let browser;
    let context;
    try {
      browser = await this.launchBrowser({ headless: true });
      context = await browser.newContext({
        storageState: this.stateFile,
        acceptDownloads: true,
      });
      if (blockHeavyResources) {
        await context.route("**/*", async (route) => {
          const request = route.request();
          let hostname = "";
          try {
            hostname = new URL(request.url()).hostname;
          } catch {}
          if (hostname.includes("annotate") || BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
            await route.abort();
          } else {
            await route.continue();
          }
        });
      }

      const page = await context.newPage();
      const results = [];
      for (const request of requests) {
        try {
          const response = await page.goto(request.url, {
            waitUntil: "domcontentloaded",
            timeout: this.navigationTimeoutMs,
          });
          if (!response?.ok()) {
            throw new Error(
              `Classic submission history returned HTTP ${response?.status() || "unknown"}`
            );
          }
          if (isBlackboardAuthenticationRedirect(page.url(), this.base)) {
            throw new Error(
              "Saved Blackboard session expired before the Classic submission fallback ran"
            );
          }
          await page.waitForSelector(DOWNLOAD_SELECTOR, {
            timeout: this.selectorTimeoutMs,
          }).catch(() => {});
          const discovered = await page.locator(DOWNLOAD_SELECTOR).evaluateAll((anchors) =>
            anchors.map((anchor) => {
              const url = new URL(anchor.href);
              return {
                attemptId: url.searchParams.get("attempt_id"),
                fileId: url.searchParams.get("file_id"),
                fileName:
                  url.searchParams.get("fileName") || anchor.textContent?.trim() || "submission",
                url: url.toString(),
              };
            })
          );
          const seen = new Set();
          const files = discovered.filter((file) => {
            if (file.attemptId && file.attemptId !== request.attemptId) return false;
            const key = file.fileId || file.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (files.length === 0) {
            results.push({ id: request.id, files, annotateUrl: null });
            continue;
          }

          await page.waitForTimeout(this.settleMs);
          const annotateFrame = page
            .frames()
            .find((frame) => frame.url().includes("annotate") && frame.url().includes("ticket="));
          results.push({
            id: request.id,
            files,
            annotateUrl: annotateFrame?.url() || null,
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

module.exports = { PlaywrightClassicSubmissionGateway };
