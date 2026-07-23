const {
  isBlackboardAuthenticationRedirect,
  matchingBlackboardResourceUrls,
  uiPageLabel,
} = require("../../domain/course-fetch/blackboard-attachment-policy");
const { launchChromium } = require("../system/playwright-runtime");

class PlaywrightAttachmentResourceGateway {
  constructor({
    base,
    stateFile,
    launchBrowser = (options) => launchChromium(options),
    navigationTimeoutMs = 30000,
    settleMs = 1200,
  }) {
    if (!base || !stateFile || typeof launchBrowser !== "function") {
      throw new Error("PlaywrightAttachmentResourceGateway requires base, stateFile, and launchBrowser");
    }
    this.base = base;
    this.stateFile = stateFile;
    this.launchBrowser = launchBrowser;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.settleMs = settleMs;
  }

  async discover({ targetUrl, uiUrls, xid }) {
    let browser;
    let context;
    const values = [];
    const diagnostics = [];
    try {
      browser = await this.launchBrowser({ headless: true });
      context = await browser.newContext({ storageState: this.stateFile });
      const page = await context.newPage();
      const needle = `xid-${xid}`;

      for (const uiUrl of uiUrls) {
        const observed = new Set();
        const captureRequest = (request) => {
          if (request.url().includes(needle)) observed.add(request.url());
        };
        page.on("request", captureRequest);
        const label = uiPageLabel(uiUrl, this.base);
        try {
          const response = await page.goto(uiUrl, {
            waitUntil: "domcontentloaded",
            timeout: this.navigationTimeoutMs,
          });
          if (isBlackboardAuthenticationRedirect(page.url(), this.base)) {
            throw new Error("redirected outside the authenticated Blackboard UI");
          }
          await page.waitForTimeout(this.settleMs);
          const domValues = await page.evaluate((target) => {
            const found = new Set();
            const visit = (value) => {
              if (typeof value === "string") {
                if (!value.includes(target)) return;
                found.add(value);
                for (const match of value.match(/https?:\/\/[^\s"'<>\\]+/g) || []) found.add(match);
                try {
                  visit(JSON.parse(value));
                } catch {}
                return;
              }
              if (Array.isArray(value)) {
                for (const item of value) visit(item);
                return;
              }
              if (value && typeof value === "object") {
                for (const item of Object.values(value)) visit(item);
              }
            };

            for (const element of document.querySelectorAll("*")) {
              for (const attribute of element.attributes) visit(attribute.value);
              for (const property of ["href", "src", "poster"]) {
                try {
                  visit(element[property]);
                } catch {}
              }
            }
            return [...found];
          }, needle);
          const matches = matchingBlackboardResourceUrls(
            [...observed, ...domValues],
            targetUrl,
            this.base
          );
          values.push(...matches);
          diagnostics.push(
            `${label}: browser HTTP ${response?.status() || "unknown"}, ${observed.size} matching request(s), ${domValues.length} matching DOM value(s)`
          );
          if (matches.some((candidate) => candidate !== targetUrl)) break;
        } catch (error) {
          diagnostics.push(`${label}: browser resolver failed (${error.message})`);
        } finally {
          page.off("request", captureRequest);
        }
      }
      return { values, diagnostics };
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

module.exports = { PlaywrightAttachmentResourceGateway };
