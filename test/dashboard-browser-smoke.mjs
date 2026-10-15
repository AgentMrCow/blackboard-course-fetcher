import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bootstrap as fixture, courseDetail, filePage } from "./fixtures/dashboard.mjs";
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

async function capture(name) {
  const style = await page.addStyleTag({ content: ".toast-region { display: none !important; }" });
  try {
    await page.screenshot({ path: path.join(artifacts, name), fullPage: true });
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
  const runs = [
    { id: "2026-10-16T08-00-00-000Z-demo", createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), fileCount: 3, totalBytes: 420, status: "available", warnings: [] },
    { id: "2026-10-15T08-00-00-000Z-demo", createdAt: new Date(Date.now() - 27 * 3_600_000).toISOString(), fileCount: 1, totalBytes: 100, status: "available", warnings: [] },
  ];
  const savedFiles = ["gradebook.json", "02_Announcements/notice/announcement.txt", "manifest.json"].map((file, index) => ({
    path: file, backupPath: `.fetch-history/${runs[0].id}/files/${file}`, size: 140,
    sha256: "0".repeat(64), preservedAt: runs[0].createdAt, status: index === 2 ? "missing" : "available",
  }));
  savedFiles[2].backupPath = null;
  let failFiles = false;
  let filesRequests = 0;
  let fetchRequests = 0;
  let failHistory = false;
  let searchRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (pathname === "/api/bootstrap") return json(bootstrap);
    if (pathname === "/api/auth/check") return json(bootstrap.auth);
    if (pathname === "/api/search") { searchRequests += 1; return json({ results: [] }); }
    if (pathname === "/api/summary") return json(bootstrap.summary);
    if (pathname === "/api/courses/_demo_design_1") return json(courseDetail);
    if (pathname === "/api/courses/_demo_design_1/history") return failHistory
      ? json({ error: "Synthetic history failure" }, 503)
      : json({ runs, truncated: false, warnings: [] });
    if (pathname.startsWith("/api/courses/_demo_design_1/history/")) {
      const run = runs.find((item) => pathname.endsWith(item.id));
      return json({ ...run, files: run.id === runs[0].id ? savedFiles : [{ ...savedFiles[0], path: "previous-gradebook.json" }], truncated: false });
    }
    if (pathname === "/api/files") {
      filesRequests += 1;
      return failFiles ? json({ error: "Synthetic file index failure" }, 503) : json(filePage);
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
    await page.getByRole("searchbox", { name: "Archive search" }).fill("pending old query");
    await page.locator(".command-dialog").getByRole("button", { name: "Close", exact: true }).click();
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
    assert.equal(await page.getByRole("button", { name: "View saved gradebook.json", exact: true }).count(), 0);
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
  for (const route of ["home", "courses", "course/_demo_design_1/history"]) {
    await check(`mobile ${route} stays within viewport`, async () => {
      await page.goto(`${origin}/#/${route}`);
      await page.locator(route.startsWith("course/") ? ".history-section" : ".page h1").waitFor();
      await eventually(async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true));
      await capture(`mobile-${route.split("/")[0]}.png`);
    });
  }
  await check("navigation is available at mobile widths", async () => {
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByLabel("Primary navigation").getByRole("link", { name: "Overview" }).click();
    await page.locator(".page h1").waitFor();
  });
  assert.deepEqual(pageErrors, [], "No uncaught browser errors");
  assert.deepEqual(unexpectedRequests, [], "No unexpected or real API traffic");
  console.log(`${checks} browser checks passed. Screenshots: test/artifacts/dashboard-smoke`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
