import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bootstrap as fixture, backupHistory, courseDetail, filePage } from "./fixtures/dashboard.mjs";
import { startStaticDashboard } from "./helpers/dashboard-static-server.mjs";

// Serve built assets only. Every API call is intercepted with synthetic data;
// this test never starts a dashboard worker or reads a user's archive/session.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "dashboard/public");
const artifacts = path.join(root, "test/artifacts/dashboard-smoke");
await mkdir(artifacts, { recursive: true });
const server = await startStaticDashboard(publicRoot);
const origin = server.url;
let browser;
let page;
let checks = 0;
const pageErrors = [];
const unexpectedRequests = [];

async function check(name, operation) {
  await operation();
  checks += 1;
  console.log(`PASS ${name}`);
}

async function capture(name, fullPage = true) {
  const viewport = page.viewportSize();
  await page.mouse.move(viewport.width - 1, viewport.height - 1);
  const style = await page.addStyleTag({ content: ".toast-region { display: none !important; }" });
  try {
    await page.screenshot({ path: path.join(artifacts, name), fullPage });
  } finally {
    await style.evaluate((element) => element.remove());
  }
}

async function eventually(operation) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await operation(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    window.EventSource = class {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 2;
      readyState = 1;
      listeners = new Map();
      constructor() {
        window.__archiveEvents = this;
        setTimeout(() => this.emit("open"), 0);
      }
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      emit(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
      close() { this.readyState = 2; }
    };
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const bootstrap = structuredClone(fixture);
  const historical = bootstrap.inventory.courses.at(-1);
  historical.archiveOnly = true;
  historical.membershipPresent = false;
  historical.available = false;
  historical.archive.exists = true;
  historical.archive.status = "complete";
  historical.archive.generatedAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
  historical.archive.fileCount = 12;
  bootstrap.summary.archivedCount = 4;
  bootstrap.summary.completeCount = 3;
  const historyFixture = backupHistory();
  const runs = historyFixture.list.runs;
  const savedFiles = historyFixture.detail.files;
  let historyFiles = savedFiles;
  let failFiles = false;
  let indexRunning = false;
  let indexRefreshes = 0;
  let filesRequests = 0;
  let fetchRequests = 0;
  let failHistory = false;
  let searchRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (pathname === "/api/bootstrap") {
      if (url.searchParams.get("refresh") === "1") {
        indexRefreshes += 1;
        bootstrap.fileIndex = { ...bootstrap.fileIndex, status: indexRunning ? "running" : "complete", indexing: indexRunning };
      }
      return json(bootstrap);
    }
    if (pathname === "/api/auth/check") return json(bootstrap.auth);
    if (/^\/api\/auth\/(start|save|cancel)$/.test(pathname)) {
      const action = pathname.split("/").at(-1);
      bootstrap.auth = { ...bootstrap.auth, status: action === "start" ? "waiting" : action === "save" ? "connected" : "idle", validation: action === "save" ? { valid: true } : null, message: action === "save" ? "Session is ready" : action === "start" ? "Complete sign-in in the browser" : "Sign-in cancelled" };
      return json(bootstrap.auth);
    }
    if (pathname === "/api/search") { searchRequests += 1; return json({ results: [] }); }
    if (pathname === "/api/summary") return json(bootstrap.summary);
    if (pathname === "/api/courses/_demo_design_1") return json(courseDetail);
    if (pathname === "/api/courses/_demo_design_1/history") return failHistory
      ? json({ error: "Synthetic history failure" }, 503)
      : json(historyFixture.list);
    if (pathname.startsWith("/api/courses/_demo_design_1/history/")) {
      const run = runs.find((item) => pathname.split("/").includes(item.id));
      if (pathname.endsWith("/compare")) {
        const filePath = url.searchParams.get("path");
        const version = { status: "available", size: 140, modifiedAt: run.createdAt, sha256: "0".repeat(64), textTruncated: false };
        if (filePath === "manifest.json") return json({ path: filePath, backupPath: null, recorded: { size: 140, sha256: version.sha256, preservedAt: run.createdAt }, saved: { status: "missing", size: null, modifiedAt: null, sha256: null, text: null, textTruncated: false }, current: { ...version, text: "{}" }, comparison: "unavailable", warnings: ["The saved file is missing."] });
        return json({ ...historyFixture.comparison, path: filePath, backupPath: `.fetch-history/${run.id}/files/${filePath}` });
      }
      const all = run.id === runs[0].id ? historyFiles : [{ ...savedFiles[0], size: 100, path: "previous-gradebook.json", backupPath: `.fetch-history/${run.id}/files/previous-gradebook.json` }];
      const matches = all.filter((item) => item.path.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase()));
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 100);
      return json({ ...run, fileCount: all.length, files: matches.slice(offset, offset + limit), offset, limit, total: matches.length, hasMore: offset + limit < matches.length, truncated: false });
    }
    if (pathname === "/api/files") {
      filesRequests += 1;
      return failFiles ? json({ error: "Synthetic file index failure" }, 503) : json(indexRunning ? { ...filePage, files: [], indexing: true, status: bootstrap.fileIndex } : filePage);
    }
    if (pathname === "/api/courses/_demo_design_1/file") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ note: "Preserved gradebook contents" }) });
    if (pathname === "/api/fetch") { fetchRequests += 1; return json({ error: "Fetch must never start in this test" }, 400); }
    unexpectedRequests.push(pathname);
    return json({ error: "Unexpected fixture request" }, 404);
  });

  await page.goto(`${origin}/#/home`);
  await page.locator(".page h1").waitFor();
  await check("overview renders without a horizontal scrollbar", async () => {
    await eventually(async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true));
    assert.equal(await page.locator(".mobile-nav-close").isVisible(), false);
    await capture("overview-desktop.png");
  });
  await page.goto(`${origin}/#/courses`);
  await check("historical course remains visible but cannot be selected", async () => {
    assert.equal(await page.getByRole("checkbox", { name: `Select ${historical.name}`, exact: true }).isDisabled(), true);
    assert.ok(await page.getByText("Local archive only", { exact: true }).count());
  });
  await check("selecting visible courses excludes historical memberships", async () => {
    await page.getByRole("button", { name: "Select visible", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { name: `Select ${historical.name}`, exact: true }).isChecked(), false);
    assert.ok(await page.locator('.course-row input[type="checkbox"]:checked').count());
  });
  await check("membership updates clear obsolete selections", async () => {
    const course = bootstrap.inventory.courses[1];
    course.membershipPresent = false;
    course.archiveOnly = true;
    course.available = false;
    await page.evaluate((inventory) => window.__archiveEvents.emit("inventory", inventory), bootstrap.inventory);
    await eventually(async () => assert.equal(await page.getByRole("checkbox", { name: `Select ${course.name}`, exact: true }).isChecked(), false));
    await capture("courses-desktop.png");
  });
  await check("skip link focuses content without changing the course route", async () => {
    const before = new URL(page.url()).hash;
    await page.locator(".skip-link").focus();
    await page.keyboard.press("Enter");
    assert.equal(new URL(page.url()).hash, before);
    assert.equal(await page.evaluate(() => document.activeElement.id), "main-content");
  });
  await check("closing and reopening search cancels a pending old query", async () => {
    await page.keyboard.press("Control+k");
    await page.getByRole("searchbox", { name: "Archive search" }).waitFor();
    // Queue the query and close within one browser task so the test specifically
    // covers a pending debounce, independent of machine/automation latency.
    await page.evaluate(() => {
      const input = document.querySelector(".command-dialog input");
      input.value = "pending old query";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('.command-dialog button[aria-label="Close"]').click();
    });
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(350);
    assert.equal(await page.getByRole("searchbox", { name: "Archive search" }).inputValue(), "");
    assert.equal(searchRequests, 0);
    await page.locator(".command-dialog").getByRole("button", { name: "Close", exact: true }).click();
  });
  await check("Escape closes the active dialog and permits reopening", async () => {
    await page.keyboard.press("Control+k");
    await page.getByRole("searchbox", { name: "Archive search" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("searchbox", { name: "Archive search" }).waitFor({ state: "hidden" });
    await page.keyboard.press("Control+k");
    await page.getByRole("searchbox", { name: "Archive search" }).waitFor();
    await page.locator(".command-dialog").getByRole("button", { name: "Close", exact: true }).click();
  });

  await check("course overview gives recent filenames readable space", async () => {
    await page.goto(`${origin}/#/course/_demo_design_1/overview`);
    const filename = page.locator(".recent-file-item strong").first();
    await filename.waitFor();
    const bounds = await filename.boundingBox();
    assert.ok(bounds.width >= 120, "Filenames must not collapse into the icon column");
  });

  await page.goto(`${origin}/#/course/_demo_design_1/history`);
  await page.getByRole("heading", { name: "Backup history", exact: true }).waitFor();
  await check("history loads saved refreshes and original paths", async () => {
    await page.getByRole("button", { name: "View saved gradebook.json", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "View saved manifest.json", exact: true }).count(), 0);
    await capture("history-desktop.png");
  });
  await check("backup preview opens preserved contents", async () => {
    await page.getByRole("button", { name: "View saved gradebook.json", exact: true }).click();
    await page.getByText(/Preserved gradebook contents/).waitFor();
    await page.locator(".file-dialog").getByRole("button", { name: "Close", exact: true }).click();
  });
  await check("history filtering and run selection work", async () => {
    await page.getByRole("searchbox", { name: "Filter backup files" }).fill("announcement");
    await eventually(async () => assert.equal(await page.getByRole("button", { name: "View saved gradebook.json", exact: true }).count(), 0));
    await page.locator(".history-run").nth(1).click();
    await page.getByRole("button", { name: "View saved previous-gradebook.json", exact: true }).waitFor();
  });
  await check("history errors have an explicit working retry", async () => {
    failHistory = true;
    await page.getByRole("button", { name: "Refresh history" }).click();
    await page.getByRole("heading", { name: "History could not be loaded" }).waitFor();
    failHistory = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("button", { name: "View saved gradebook.json", exact: true }).waitFor();
  });
  await check("backup comparison shows recovery direction and read-only destination", async () => {
    await page.getByRole("button", { name: "Compare saved gradebook.json", exact: true }).click();
    const dialog = page.locator(".history-comparison-dialog");
    await dialog.getByText("The current and saved versions differ", { exact: true }).waitFor();
    assert.match(await dialog.locator(".diff-line.removed").allTextContents().then((lines) => lines.join("\n")), /90/);
    assert.match(await dialog.locator(".diff-line.added").allTextContents().then((lines) => lines.join("\n")), /80/);
    assert.match(await dialog.locator(".recovery-plan").textContent(), /read-only preview/);
    assert.match(await dialog.getByRole("link", { name: "Download saved version" }).getAttribute("href"), /download=1/);
    await capture("history-comparison-desktop.png", false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  });
  await check("missing saved files do not offer unsafe recovery instructions", async () => {
    await page.getByRole("button", { name: "Compare saved manifest.json", exact: true }).click();
    const dialog = page.locator(".history-comparison-dialog");
    await dialog.getByText("This comparison could not be completed", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("link", { name: "Download saved version" }).count(), 0);
    assert.doesNotMatch(await dialog.locator(".recovery-plan").textContent(), /then copy the saved file/);
    await dialog.getByText("Unavailable", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  });
  await check("backup pagination and filtering reach files beyond the first page", async () => {
    historyFiles = Array.from({ length: 120 }, (_, i) => ({ ...savedFiles[0], path: `record-${String(i + 1).padStart(3, "0")}.json`, backupPath: `.fetch-history/${runs[0].id}/files/record-${String(i + 1).padStart(3, "0")}.json` }));
    await page.getByRole("button", { name: "Refresh history" }).click();
    await page.getByRole("button", { name: "View saved record-100.json", exact: true }).waitFor();
    assert.equal(await page.locator(".history-files li").count(), 100);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "View saved record-120.json", exact: true }).waitFor();
    assert.equal(await page.locator(".history-files li").count(), 20);
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await page.getByRole("searchbox", { name: "Filter backup files" }).fill("record-120");
    await eventually(async () => assert.equal(await page.locator(".history-files li").count(), 1));
    await page.getByRole("button", { name: "View saved record-120.json", exact: true }).waitFor();
    historyFiles = savedFiles;
    await page.getByRole("button", { name: "Refresh history" }).click();
    await page.getByRole("button", { name: "View saved gradebook.json", exact: true }).waitFor();
  });
  await check("file failures stop automatic retries until requested", async () => {
    failFiles = true;
    filesRequests = 0;
    await page.goto(`${origin}/#/files`);
    await page.getByRole("heading", { name: "Files could not be loaded" }).waitFor();
    await page.waitForTimeout(350);
    assert.equal(filesRequests, 1);
    failFiles = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator(".file-collection, .file-table, .file-grid, .file-browser").first().waitFor({ timeout: 5000 }).catch(async () => {
      await page.getByText(filePage.files[0].name, { exact: true }).first().waitFor();
    });
    assert.equal(filesRequests, 2);
  });
  await check("failed background indexing stops the spinner and can rebuild", async () => {
    indexRunning = true;
    await page.getByRole("button", { name: "Refresh index", exact: true }).click();
    await page.getByText(/Indexing course .* in the background/).waitFor();
    indexRunning = false;
    bootstrap.fileIndex = { ...bootstrap.fileIndex, status: "failed", indexing: false, error: "Synthetic disk read failure", message: "Synthetic disk read failure" };
    await page.evaluate((index) => window.__archiveEvents.emit("file-index", index), bootstrap.fileIndex);
    await page.getByRole("heading", { name: "File indexing failed", exact: true }).waitFor();
    assert.equal(await page.getByText(/Indexing course .* in the background/).count(), 0);
    assert.ok(await page.getByText("Synthetic disk read failure", { exact: true }).count());
    const before = indexRefreshes;
    await page.getByRole("button", { name: "Rebuild index", exact: true }).click();
    await page.getByText(filePage.files[0].name, { exact: true }).first().waitFor();
    assert.equal(indexRefreshes, before + 1);
  });
  await check("settings opens the complete shared sign-in workflow", async () => {
    await page.goto(`${origin}/#/settings`);
    await page.getByRole("button", { name: "Manage sign-in", exact: true }).click();
    const dialog = page.locator(".setup-dialog");
    await dialog.getByRole("button", { name: "Open sign-in browser", exact: true }).click();
    await dialog.getByRole("button", { name: "Save and verify session", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await dialog.getByRole("button", { name: "Open sign-in browser", exact: true }).click();
    await dialog.getByRole("button", { name: "Save and verify session", exact: true }).click();
    await dialog.getByText("Session is ready", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  });
  const originalDeadlines = bootstrap.summary.deadlines;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(12, 0, 0, 0);
  bootstrap.summary.deadlines = Array.from({ length: 20 }, (_, i) => ({ courseId: "_demo_design_1", courseCode: "DESN2100", title: `Synthetic assignment ${i + 1}`, dueDate: tomorrow.toISOString(), status: "not_started" }));
  bootstrap.summary.deadlines.push({ courseId: "_demo_design_1", courseCode: "DESN2100", title: "Synthetic overdue assignment", dueDate: new Date(Date.now() - 86_400_000).toISOString(), status: "not_started" });
  await page.evaluate((summary) => window.__archiveEvents.emit("summary", summary), bootstrap.summary);
  await check("calendar expands crowded days and all agenda pages", async () => {
    await page.goto(`${origin}/#/calendar`);
    await page.getByRole("button", { name: "Show 8 more", exact: true }).waitFor();
    assert.equal(await page.locator(".agenda-item").count(), 12);
    await page.getByRole("button", { name: "Show 8 more", exact: true }).click();
    assert.equal(await page.locator(".agenda-item").count(), 20);
    await page.locator(".calendar-more").filter({ hasText: "+17 more" }).click();
    assert.equal(await page.locator(".selected-day-item").count(), 20);
    assert.equal(await page.evaluate(() => document.activeElement.id), "selected-day-heading");
    await capture("calendar-expanded-desktop.png");
    await page.getByRole("combobox", { name: "Agenda range" }).selectOption("overdue");
    assert.equal(await page.locator(".agenda-item").count(), 1);
    await page.getByRole("combobox", { name: "Agenda range" }).selectOption("all");
    await page.getByRole("button", { name: "Show 9 more", exact: true }).click();
    assert.equal(await page.locator(".agenda-item").count(), 21);
  });
  await check("local reconnect status catches up without starting a fetch", async () => {
    await page.evaluate(() => { window.__archiveEvents.readyState = 0; window.__archiveEvents.emit("error"); });
    await page.getByText(/Reconnecting/).first().waitFor();
    await page.evaluate(() => { window.__archiveEvents.readyState = 1; window.__archiveEvents.emit("open"); });
    await eventually(async () => assert.equal(await page.getByText(/Reconnecting/).count(), 0));
    assert.equal(fetchRequests, 0);
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await check("tablet overview fits beside the navigation", async () => {
    await page.goto(`${origin}/#/home`);
    await page.locator(".page h1").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await capture("overview-tablet.png");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["home", "courses", "calendar", "course/_demo_design_1/history"]) {
    await check(`mobile ${route} stays within viewport`, async () => {
      await page.goto(`${origin}/#/${route}`);
      await page.locator(route.startsWith("course/") ? ".history-section" : ".page h1").waitFor();
      await eventually(async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true));
      await capture(`mobile-${route.split("/")[0]}.png`);
    });
  }
  await check("mobile course sections are discoverable and keep the active section", async () => {
    const picker = page.getByRole("combobox", { name: "Course section" });
    assert.equal(await picker.inputValue(), "history");
    await picker.selectOption("grades");
    await eventually(async () => assert.equal(new URL(page.url()).hash, "#/course/_demo_design_1/grades"));
    await picker.selectOption("history");
    await page.getByRole("button", { name: "Compare saved gradebook.json", exact: true }).click();
    const dialog = page.locator(".history-comparison-dialog");
    await dialog.getByText("The current and saved versions differ", { exact: true }).waitFor();
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await capture("history-comparison-mobile.png", false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  });
  await check("mobile navigation traps focus, closes with Escape, and survives resizing", async () => {
    const navigation = page.locator("#primary-navigation");
    assert.equal(await navigation.evaluate((element) => element.inert), true);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement.classList.contains("mobile-nav-close")), true));
    await page.keyboard.press("Shift+Tab");
    await eventually(async () => {
      const focus = await page.evaluate(() => ({ text: document.activeElement.textContent, element: document.activeElement.outerHTML }));
      assert.match(focus.text, /Settings/, `Reverse Tab should wrap inside navigation; focused ${focus.element}`);
    });
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("mobile-nav-close")), true);
    await capture("mobile-navigation.png", false);
    await page.keyboard.press("Escape");
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Open navigation"));
    assert.equal(await navigation.evaluate((element) => element.inert), true);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await eventually(async () => assert.equal(await navigation.evaluate((element) => element.inert), false));
    await page.setViewportSize({ width: 390, height: 844 });
    await eventually(async () => assert.equal(await navigation.evaluate((element) => element.inert), true));
    assert.equal(await page.evaluate(() => document.getElementById("primary-navigation").contains(document.activeElement)), false);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement.classList.contains("mobile-nav-close")), true));
    await page.keyboard.press("Escape");
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Open navigation"));
    await page.emulateMedia({ reducedMotion: "reduce" });
  });
  await check("dialogs opened from mobile navigation restore focus to a visible trigger", async () => {
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Setup guide", exact: true }).click();
    const dialog = page.locator(".setup-dialog");
    await dialog.getByRole("heading", { name: "Connect and build your archive", exact: true }).waitFor();
    assert.equal(await page.locator("#primary-navigation").evaluate((element) => element.inert), true);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Open navigation"));
  });
  await check("mobile calendar opens every item without horizontal overflow", async () => {
    await page.goto(`${origin}/#/calendar`);
    await page.locator(".calendar-day-count").filter({ hasText: "20 items" }).click();
    assert.equal(await page.locator(".selected-day-item").count(), 20);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await capture("calendar-expanded-mobile.png");
    bootstrap.summary.deadlines = originalDeadlines;
    await page.evaluate((summary) => window.__archiveEvents.emit("summary", summary), bootstrap.summary);
  });
  await check("navigation is available at mobile widths", async () => {
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByLabel("Primary navigation").getByRole("link", { name: "Overview" }).click();
    await page.locator(".page h1").waitFor();
  });
  assert.deepEqual(pageErrors, [], "No uncaught browser errors");
  assert.deepEqual(unexpectedRequests, [], "No unexpected or real API traffic");
  console.log(`${checks} browser checks passed. Screenshots: test/artifacts/dashboard-smoke`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: false }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
