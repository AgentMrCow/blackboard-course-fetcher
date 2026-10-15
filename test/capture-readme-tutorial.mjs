import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { bootstrap, courseDetail, filePage, runningBatch } from "./fixtures/dashboard.mjs";
import { startStaticDashboard } from "./helpers/dashboard-static-server.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "docs", "assets", "tutorial");
const artifactDirectory = path.join(projectRoot, "test", "artifacts", "readme-tutorial");
let dashboardUrl = process.env.DASHBOARD_URL;

async function installApiFixtures(page) {
  await page.route("**/api/**", (route) => route.fulfill({
    status: 404, contentType: "application/json", body: JSON.stringify({ error: "No synthetic fixture for this route" }),
  }));
  await page.route("**/api/bootstrap*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(bootstrap),
  }));
  await page.route("**/api/auth/check", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(bootstrap.auth),
  }));
  await page.route("**/api/fetch", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(runningBatch()),
  }));
  await page.route("**/api/files*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(filePage),
  }));
  await page.route("**/api/courses/_demo_design_1", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(courseDetail),
  }));
}

async function createContext(browser, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 960 },
    colorScheme: "light",
    locale: "en-HK",
    reducedMotion: "reduce",
    recordVideo: options.recordVideo,
  });
  await context.addInitScript(() => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
  });
  return context;
}

async function openDashboard(page) {
  await installApiFixtures(page);
  await page.goto(`${dashboardUrl}/#/home`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Overview" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: ".toast-region { display: none !important; }" });
}

async function pause(page, milliseconds = 450) {
  await page.waitForTimeout(milliseconds);
}

async function screenshot(page, name) {
  await pause(page, 250);
  await page.screenshot({
    path: path.join(outputDirectory, name),
    animations: "disabled",
    fullPage: false,
  });
}

async function captureScreenshots(browser) {
  const context = await createContext(browser);
  const page = await context.newPage();
  await openDashboard(page);

  await screenshot(page, "01-overview.png");

  await page.getByRole("button", { name: "Setup guide" }).click();
  await page.locator("button.setup-step").filter({ hasText: "Configure" }).click();
  await screenshot(page, "02-configure.png");

  await page.locator("button.setup-step").filter({ hasText: "Sign in" }).click();
  await screenshot(page, "03-sign-in.png");

  await page.locator(".setup-dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("link", { name: /^Courses/ }).click();
  await page.getByRole("heading", { name: "Courses" }).waitFor();
  await page.getByLabel("Select Web Application Engineering").check();
  await screenshot(page, "04-select-course.png");

  await page.getByRole("button", { name: "Fetch selected" }).click();
  await page.getByRole("heading", { name: "Start fetch" }).waitFor();
  await screenshot(page, "05-full-archive.png");

  await page.getByRole("button", { name: "Start fetch" }).click();
  await page.getByRole("heading", { name: "Fetch activity" }).waitFor();
  await screenshot(page, "06-fetch-activity.png");

  await page.goto(`${dashboardUrl}/#/course/${encodeURIComponent("_demo_design_1")}/overview`);
  await page.getByRole("heading", { name: "Product Design Studio" }).waitFor();
  await screenshot(page, "07-course-workspace.png");

  await page.getByRole("link", { name: "Files", exact: true }).first().click();
  await page.getByRole("heading", { name: "Files" }).waitFor();
  await page.getByText("Studio brief.pdf", { exact: true }).waitFor();
  await screenshot(page, "08-files.png");

  await context.close();
}

async function captureWorkflowVideo(browser) {
  const videoDirectory = path.join(artifactDirectory, "video");
  await rm(videoDirectory, { recursive: true, force: true });
  await mkdir(videoDirectory, { recursive: true });

  const context = await createContext(browser, {
    viewport: { width: 1200, height: 800 },
    recordVideo: {
      dir: videoDirectory,
      size: { width: 1200, height: 800 },
    },
  });
  const page = await context.newPage();
  await openDashboard(page);

  await pause(page, 900);
  await page.getByRole("button", { name: "Fetch courses" }).hover();
  await pause(page, 450);
  await page.getByRole("button", { name: "Fetch courses" }).click();
  await page.getByRole("heading", { name: "Courses" }).waitFor();
  await pause(page, 700);

  await page.getByLabel("Select Web Application Engineering").hover();
  await pause(page, 350);
  await page.getByLabel("Select Web Application Engineering").check();
  await pause(page, 650);

  await page.getByRole("button", { name: "Fetch selected" }).hover();
  await pause(page, 350);
  await page.getByRole("button", { name: "Fetch selected" }).click();
  await page.getByRole("heading", { name: "Start fetch" }).waitFor();
  await pause(page, 1_100);

  await page.getByRole("button", { name: "Start fetch" }).hover();
  await pause(page, 350);
  await page.getByRole("button", { name: "Start fetch" }).click();
  await page.getByRole("heading", { name: "Fetch activity" }).waitFor();
  await pause(page, 1_600);

  const video = page.video();
  await context.close();
  return video.path();
}

async function buildGif(videoPath) {
  const gifPath = path.join(outputDirectory, "fetch-workflow.gif");
  const filter = [
    "fps=10",
    "scale=960:-1:flags=lanczos",
    "split[s0][s1]",
    "[s0]palettegen=max_colors=128:stats_mode=diff[p]",
    "[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  ].join(",");
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-filter_complex",
      filter,
      "-loop",
      "0",
      gifPath,
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.warn("ffmpeg was not found; PNG screenshots were generated, but the GIF was skipped.");
      return;
    }
    throw error;
  }
}

async function main() {
  const server = dashboardUrl ? null : await startStaticDashboard(path.join(projectRoot, "dashboard/public"));
  dashboardUrl ||= server.url;
  let browser;
  try {
    const response = await fetch(dashboardUrl);
    if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}. Build it with npm run dashboard:build.`);
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(artifactDirectory, { recursive: true });
    browser = await chromium.launch({ headless: true });
    await captureScreenshots(browser);
    const videoPath = await captureWorkflowVideo(browser);
    await buildGif(videoPath);
  } finally {
    await browser?.close();
    await server?.close();
  }

  console.log(`README tutorial assets written to ${path.relative(projectRoot, outputDirectory)}`);
}

await main();
