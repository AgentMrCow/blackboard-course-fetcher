const {
  isBlackboardAuthenticationRedirect,
} = require("../../domain/course-fetch/blackboard-attachment-policy");
const { launchChromium } = require("../system/playwright-runtime");

function message(error) {
  return error?.message || String(error);
}

async function waitWithTimeout(promise, timeoutMs, timeoutMessage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class PlaywrightBlackboardExtrasGateway {
  constructor({
    base,
    stateFile,
    launchBrowser = (options) => launchChromium(options),
    navigationTimeoutMs = 30000,
    responseTimeoutMs = 30000,
    achievementUnreadTimeoutMs = 5000,
    annotationSyncTimeoutMs = 25000,
    annotationSettleMs = 300,
    classicFrameAttempts = 30,
    classicFrameIntervalMs = 500,
  }) {
    if (!base || !stateFile || typeof launchBrowser !== "function") {
      throw new Error("PlaywrightBlackboardExtrasGateway requires base, stateFile, and launchBrowser");
    }
    this.base = base;
    this.stateFile = stateFile;
    this.launchBrowser = launchBrowser;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.achievementUnreadTimeoutMs = achievementUnreadTimeoutMs;
    this.annotationSyncTimeoutMs = annotationSyncTimeoutMs;
    this.annotationSettleMs = annotationSettleMs;
    this.classicFrameAttempts = classicFrameAttempts;
    this.classicFrameIntervalMs = classicFrameIntervalMs;
  }

  async collect({
    achievementsUrl = null,
    annotationRequests = [],
    refreshAnnotationViewUrl,
    onAnnotationCapture = async (_request, capture) => capture,
  } = {}) {
    if (!achievementsUrl && annotationRequests.length === 0) {
      return { achievements: null, annotations: [] };
    }

    let browser;
    let context;
    try {
      browser = await this.launchBrowser({ headless: true });
      context = await browser.newContext({
        storageState: this.stateFile,
        acceptDownloads: true,
      });

      let achievements = null;
      if (achievementsUrl) {
        try {
          achievements = { value: await this.captureAchievements(context, achievementsUrl) };
        } catch (error) {
          achievements = { error: message(error) };
        }
      }

      const annotations = await this.captureAnnotations(context, annotationRequests, {
        onAnnotationCapture,
        refreshAnnotationViewUrl,
      });
      return { achievements, annotations };
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  async captureAchievements(context, url) {
    const page = await context.newPage();
    try {
      const responseFor = (suffix, timeout = this.responseTimeoutMs) =>
        page
          .waitForResponse(
            (response) => {
              const candidate = new URL(response.url());
              return (
                candidate.pathname.includes("/lms-achievements/api/") &&
                candidate.pathname.endsWith(suffix)
              );
            },
            { timeout }
          )
          .catch(() => null);
      const listPromise = responseFor("/achievements");
      const unreadPromise = responseFor(
        "/achievements/unread",
        this.achievementUnreadTimeoutMs
      );
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.navigationTimeoutMs,
      });
      if (isBlackboardAuthenticationRedirect(page.url(), this.base)) {
        throw new Error("Saved Blackboard session expired before achievements were archived");
      }
      const [listResponse, unreadResponse] = await Promise.all([listPromise, unreadPromise]);
      if (!listResponse || !listResponse.ok()) {
        throw new Error("Achievements API response was not available");
      }
      return {
        list: await listResponse.json(),
        unread: unreadResponse?.ok() ? await unreadResponse.json() : null,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async captureAnnotations(
    context,
    requests,
    { onAnnotationCapture, refreshAnnotationViewUrl }
  ) {
    const successful = [];
    const retry = [];
    for (const request of requests) {
      try {
        successful.push({
          id: request.id,
          value: await this.captureAndArchiveAnnotation(context, request, {
            onAnnotationCapture,
            refreshAnnotationViewUrl,
          }),
        });
      } catch (error) {
        retry.push({ request, firstError: message(error) });
      }
    }

    const failed = [];
    for (const { request, firstError } of retry) {
      try {
        successful.push({
          id: request.id,
          value: await this.captureAndArchiveAnnotation(context, request, {
            onAnnotationCapture,
            refreshAnnotationViewUrl,
          }),
        });
      } catch (error) {
        failed.push({ id: request.id, firstError, retryError: message(error) });
      }
    }
    return [...successful, ...failed];
  }

  async captureAndArchiveAnnotation(
    context,
    request,
    { onAnnotationCapture, refreshAnnotationViewUrl }
  ) {
    const capture = await this.captureAnnotation(context, request, refreshAnnotationViewUrl);
    return onAnnotationCapture(request, capture);
  }

  async captureAnnotation(context, request, refreshAnnotationViewUrl) {
    const page = await context.newPage();
    let documentMetadata = null;
    let syncData = null;
    let resolveSync;
    const syncCaptured = new Promise((resolve) => {
      resolveSync = resolve;
    });
    const responseHandler = (response) => {
      const requestDetails = response.request();
      let parsed;
      try {
        parsed = new URL(response.url());
      } catch {
        return;
      }
      if (!parsed.hostname.includes("annotate")) return;
      if (/\/document\.json$/.test(parsed.pathname)) {
        response
          .json()
          .then((value) => {
            documentMetadata = value;
          })
          .catch(() => {});
      }
      if (requestDetails.method() === "POST" && /\/sync$/.test(parsed.pathname)) {
        response
          .json()
          .then((value) => {
            syncData = value;
            resolveSync(syncData);
          })
          .catch(() => {});
      }
    };
    page.on("response", responseHandler);

    try {
      const viewUrl = await this.resolveAnnotationViewUrl(
        context,
        request,
        refreshAnnotationViewUrl
      );
      await page.goto(viewUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.navigationTimeoutMs,
      });
      await waitWithTimeout(
        syncCaptured,
        this.annotationSyncTimeoutMs,
        "Annotate sync timed out"
      );
      await page.waitForTimeout(this.annotationSettleMs);
      if (!syncData) throw new Error("Annotate sync returned no data");
      return { documentMetadata, syncData };
    } finally {
      page.off("response", responseHandler);
      await page.close().catch(() => {});
    }
  }

  async resolveAnnotationViewUrl(context, request, refreshAnnotationViewUrl) {
    if (!request.classicHistoryUrl) {
      if (typeof refreshAnnotationViewUrl !== "function") {
        throw new Error("No Annotate viewer URL refresh gateway was provided");
      }
      return refreshAnnotationViewUrl(request);
    }

    const page = await context.newPage();
    try {
      const response = await page.goto(request.classicHistoryUrl, {
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
          "Saved Blackboard session expired before the Annotate viewer URL was refreshed"
        );
      }
      for (let attempt = 0; attempt < this.classicFrameAttempts; attempt += 1) {
        const frame = page
          .frames()
          .find((candidate) => candidate.url().includes("annotate") && candidate.url().includes("ticket="));
        if (frame) return frame.url();
        await page.waitForTimeout(this.classicFrameIntervalMs);
      }
      throw new Error("Classic submission history did not return an Annotate viewer URL");
    } finally {
      await page.close().catch(() => {});
    }
  }
}

module.exports = { PlaywrightBlackboardExtrasGateway, waitWithTimeout };
