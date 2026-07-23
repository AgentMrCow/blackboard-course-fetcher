import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "docs", "assets", "tutorial");
const artifactDirectory = path.join(projectRoot, "test", "artifacts", "readme-tutorial");
const dashboardUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:4173";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();

function archive(overrides = {}) {
  return {
    exists: false,
    status: "not_fetched",
    generatedAt: null,
    downloadMode: null,
    coverageComplete: false,
    coverageReportedComplete: false,
    coverageIssue: null,
    coverageIssueCode: null,
    coverageIssues: [],
    coverageIssueCodes: [],
    errors: 0,
    warnings: 0,
    contentCount: 0,
    fileCount: 0,
    assessmentCount: 0,
    announcementCount: 0,
    gradeCount: 0,
    totalMs: null,
    bytes: null,
    ...overrides,
  };
}

const courses = [
  {
    id: "_demo_design_1",
    externalId: "2026-DESN2100",
    name: "Product Design Studio",
    code: "DESN2100",
    termName: "2025-26: 2nd Term",
    view: "ULTRA",
    available: true,
    hidden: false,
    outputDirectory: "2025-26/2nd Term/DESN2100 - Product Design Studio",
    archive: archive({
      exists: true,
      status: "complete",
      generatedAt: iso(-35 * minute),
      downloadMode: "full",
      coverageComplete: true,
      coverageReportedComplete: true,
      contentCount: 58,
      fileCount: 184,
      assessmentCount: 6,
      announcementCount: 4,
      gradeCount: 8,
      totalMs: 428_000,
      bytes: 286_400_000,
    }),
  },
  {
    id: "_demo_web_1",
    externalId: "2026-CSCI3200",
    name: "Web Application Engineering",
    code: "CSCI3200",
    termName: "2025-26: 2nd Term",
    view: "ULTRA",
    available: true,
    hidden: false,
    outputDirectory: "2025-26/2nd Term/CSCI3200 - Web Application Engineering",
    archive: archive(),
  },
  {
    id: "_demo_business_1",
    externalId: "2026-BUSI2400",
    name: "Digital Entrepreneurship",
    code: "BUSI2400",
    termName: "2025-26: 2nd Term",
    view: "CLASSIC",
    available: true,
    hidden: false,
    outputDirectory: "2025-26/2nd Term/BUSI2400 - Digital Entrepreneurship",
    archive: archive({
      exists: true,
      status: "complete",
      generatedAt: iso(-2 * hour),
      downloadMode: "full",
      coverageComplete: true,
      coverageReportedComplete: true,
      contentCount: 42,
      fileCount: 126,
      assessmentCount: 5,
      announcementCount: 7,
      gradeCount: 6,
      totalMs: 332_000,
      bytes: 198_200_000,
    }),
  },
  {
    id: "_demo_data_1",
    externalId: "2025-DATA3100",
    name: "Applied Data Analytics",
    code: "DATA3100",
    termName: "2025-26: 1st Term",
    view: "ULTRA",
    available: true,
    hidden: false,
    outputDirectory: "2025-26/1st Term/DATA3100 - Applied Data Analytics",
    archive: archive({
      exists: true,
      status: "incomplete",
      generatedAt: iso(-3 * day),
      downloadMode: "full",
      coverageIssue: "One external video needs verification",
      coverageIssueCode: "external-resource",
      coverageIssues: ["One external video needs verification"],
      coverageIssueCodes: ["external-resource"],
      warnings: 1,
      contentCount: 36,
      fileCount: 92,
      assessmentCount: 4,
      announcementCount: 3,
      gradeCount: 5,
      totalMs: 274_000,
      bytes: 142_800_000,
    }),
  },
  {
    id: "_demo_communication_1",
    externalId: "2025-COMM2200",
    name: "Professional Communication",
    code: "COMM2200",
    termName: "2025-26: 1st Term",
    view: "CLASSIC",
    available: true,
    hidden: false,
    outputDirectory: "2025-26/1st Term/COMM2200 - Professional Communication",
    archive: archive(),
  },
];

function file(overrides) {
  return {
    courseId: "_demo_design_1",
    courseCode: "DESN2100",
    courseName: "Product Design Studio",
    category: "Course content",
    preview: "pdf",
    size: 1_200_000,
    modifiedAt: iso(-2 * hour),
    origin: "blackboard-original",
    role: "attachment",
    hiddenByDefault: false,
    searchable: true,
    primaryPath: overrides.path,
    groupKey: overrides.path,
    ...overrides,
  };
}

const files = [
  file({
    path: "01_Course_Contents/Week 01/Studio brief.pdf",
    name: "Studio brief.pdf",
    size: 2_840_000,
  }),
  file({
    path: "01_Course_Contents/Week 02/Design research toolkit.pdf",
    name: "Design research toolkit.pdf",
    size: 4_120_000,
  }),
  file({
    path: "01_Course_Contents/Week 03/Interview template.docx",
    name: "Interview template.docx",
    preview: "office",
    size: 186_000,
  }),
  file({
    path: "01_Course_Contents/Week 04/Prototype walkthrough.mp4",
    name: "Prototype walkthrough.mp4",
    preview: "video",
    size: 48_600_000,
  }),
  file({
    path: "02_Announcements/Studio schedule/announcement.html",
    name: "announcement.html",
    category: "Announcements",
    preview: "html",
    size: 18_400,
    origin: "blackboard-content-export",
    role: "announcement-rendered",
  }),
  file({
    path: "01_Course_Contents/Assessment/Project rubric.pdf",
    name: "Project rubric.pdf",
    category: "Assessments",
    size: 628_000,
  }),
  file({
    path: "01_Course_Contents/References/Material samples.jpg",
    name: "Material samples.jpg",
    preview: "image",
    size: 3_780_000,
  }),
  file({
    path: "01_Course_Contents/Week 05/Accessibility checklist.pdf",
    name: "Accessibility checklist.pdf",
    size: 940_000,
  }),
];

const courseDetail = {
  course: courses[0],
  assessments: [
    {
      contentId: "_assessment_1",
      title: "Concept validation report",
      directory: "01_Course_Contents/Assessment/Concept validation report",
      dueDate: iso(6 * day),
      isGroup: true,
      assignedGroups: ["Studio Team 4"],
      status: "in_progress",
      possiblePoints: 30,
      attempts: [],
    },
    {
      contentId: "_assessment_2",
      title: "Prototype demonstration",
      directory: "01_Course_Contents/Assessment/Prototype demonstration",
      dueDate: iso(13 * day),
      isGroup: true,
      assignedGroups: ["Studio Team 4"],
      status: "not_started",
      possiblePoints: 35,
      attempts: [],
    },
    {
      contentId: "_assessment_3",
      title: "Research reflection",
      directory: "01_Course_Contents/Assessment/Research reflection",
      dueDate: iso(-8 * day),
      isGroup: false,
      status: "graded",
      possiblePoints: 20,
      attempts: [{ status: "graded" }],
      grade: {
        score: 17,
        pointsPossible: 20,
        percentage: 85,
        status: "graded",
        submissionStatus: "graded",
      },
    },
  ],
  announcements: [
    {
      id: "_announcement_1",
      title: "Studio consultations available",
      postedAt: iso(-4 * hour),
      text: "Consultation slots are now available before the concept review.",
      read: false,
    },
    {
      id: "_announcement_2",
      title: "Prototype lab hours extended",
      postedAt: iso(-2 * day),
      text: "The prototype lab will remain open until 8:00 PM this week.",
      read: true,
    },
  ],
  contents: [
    {
      id: "_content_1",
      title: "Week 01 - Framing the design problem",
      path: "Course Content / Week 01",
      container: true,
      files: ["01_Course_Contents/Week 01/Studio brief.pdf"],
    },
    {
      id: "_content_2",
      title: "Design research toolkit",
      path: "Course Content / Week 02 / Design research toolkit",
      handler: "resource/x-bb-file",
      files: ["01_Course_Contents/Week 02/Design research toolkit.pdf"],
    },
    {
      id: "_content_3",
      title: "Prototype walkthrough",
      path: "Course Content / Week 04 / Prototype walkthrough",
      handler: "resource/x-bb-video",
      files: ["01_Course_Contents/Week 04/Prototype walkthrough.mp4"],
    },
  ],
  files,
  gradebook: {
    summary: {
      performanceToDate: {
        title: "Performance to date",
        percentage: 86.5,
        earned: 43.25,
        possible: 50,
      },
    },
    items: [],
  },
  calendar: { items: [] },
  discussions: { forums: [], messageCount: 0 },
  messages: { conversations: [], counts: { totalCount: 0 } },
  groups: {
    totalGroups: 8,
    accessibleGroups: [
      {
        title: "Studio Team 4",
        studentCount: 4,
        hasSubmittedGroupAttempt: true,
        members: [
          { displayName: "Alex Chen", courseRole: "Student" },
          { displayName: "Jordan Lee", courseRole: "Student" },
        ],
      },
    ],
  },
  achievements: { count: 0, items: [] },
  manifest: {
    generatedAt: iso(-35 * minute),
    downloadMode: "full",
    course: { externalAccessUrl: "https://blackboard.example.edu/ultra/courses/_demo_design_1/outline" },
    coverage: {
      content: { discovered: 58 },
      courseFiles: { expected: 184, covered: 184 },
      announcements: { embeddedAttachmentExpected: 3, covered: 3 },
      assessments: { expected: 6, processed: 6 },
      downloads: { unresolved: 0 },
    },
    transfer: {
      networkFiles: 184,
      networkBytes: 286_400_000,
      reusedFiles: 0,
      reusedBytes: 0,
      placeholderFiles: 0,
      unresolvedFiles: 0,
    },
    timings: {
      totalMs: 428_000,
      phases: { content: 184_000, additionalAreas: 96_000, coverageAudit: 8_000 },
    },
    quizReviews: { expected: 2, archived: 2 },
    warnings: [],
    errors: [],
  },
};

const bootstrap = {
  app: { name: "Blackboard Archive", version: "0.2.0" },
  settings: {
    blackboardBase: "https://blackboard.example.edu",
    archiveRoot: "/home/student/blackboard-fetcher/Blackboard_Archive",
    stateFile: "/home/student/blackboard-fetcher/.blackboard-state.json",
    downloadMode: "full",
    courseConcurrency: 1,
    attachmentConcurrency: 2,
    reuseValidatedCache: false,
  },
  auth: {
    status: "connected",
    exists: true,
    stateFile: "/home/student/blackboard-fetcher/.blackboard-state.json",
    modifiedAt: iso(-8 * minute),
    cookieCount: 14,
    message: "Blackboard session verified",
    validation: { valid: true, user: { userName: "Demo Student" } },
  },
  inventoryTask: {
    status: "idle",
    message: "",
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    logs: [],
  },
  inventory: {
    schemaVersion: 1,
    blackboardBase: "https://blackboard.example.edu",
    generatedAt: iso(-6 * minute),
    inventoryCount: courses.length,
    downloadMode: "full",
    courses,
    terms: [
      { name: "2025-26: 2nd Term", courseCount: 3 },
      { name: "2025-26: 1st Term", courseCount: 2 },
    ],
  },
  summary: {
    courseCount: courses.length,
    archivedCount: 3,
    completeCount: 2,
    issueCount: 1,
    materialFiles: 402,
    recordFiles: 138,
    files: 540,
    materialBytes: 627_400_000,
    bytes: 627_400_000,
    deadlines: [
      {
        courseId: "_demo_design_1",
        courseCode: "DESN2100",
        title: "Concept validation report",
        dueDate: iso(6 * day),
        status: "in_progress",
        score: null,
        pointsPossible: 30,
      },
      {
        courseId: "_demo_business_1",
        courseCode: "BUSI2400",
        title: "Customer discovery interview",
        dueDate: iso(9 * day),
        status: "not_started",
        score: null,
        pointsPossible: 20,
      },
      {
        courseId: "_demo_design_1",
        courseCode: "DESN2100",
        title: "Prototype demonstration",
        dueDate: iso(13 * day),
        status: "not_started",
        score: null,
        pointsPossible: 35,
      },
    ],
    announcements: [
      {
        id: "_announcement_1",
        courseId: "_demo_design_1",
        courseCode: "DESN2100",
        title: "Studio consultations available",
        postedAt: iso(-4 * hour),
        read: false,
      },
      {
        id: "_announcement_3",
        courseId: "_demo_business_1",
        courseCode: "BUSI2400",
        title: "Pitch workshop room updated",
        postedAt: iso(-1 * day),
        read: true,
      },
    ],
    recentFiles: files.slice(0, 4),
  },
  jobs: [],
  fileIndex: {
    status: "ready",
    indexing: false,
    fileCount: 540,
    scannedCourses: 3,
    totalCourses: 3,
  },
  system: {
    node: "v22.0.0",
    platform: "linux",
    architecture: "x64",
    liveProcessPause: true,
    chromiumInstalled: true,
    archiveRootExists: true,
    disk: {
      freeBytes: 128 * 1024 ** 3,
      totalBytes: 512 * 1024 ** 3,
    },
  },
};

function runningBatch() {
  return {
    id: "fetch-demo-batch",
    kind: "fetch",
    status: "running",
    createdAt: iso(-2 * minute),
    startedAt: iso(-2 * minute),
    finishedAt: null,
    options: {
      mode: "full",
      courseConcurrency: 1,
      attachmentConcurrency: 2,
      reuseValidatedCache: false,
    },
    tasks: [
      {
        id: "fetch-demo-batch:_demo_web_1",
        courseId: "_demo_web_1",
        courseCode: "CSCI3200",
        courseName: "Web Application Engineering",
        outputDirectory: "2025-26/2nd Term/CSCI3200 - Web Application Engineering",
        status: "running",
        progress: 42,
        currentPhase: "Course content",
        currentItem: "Downloading Week 04 - Routing and state.pdf",
        createdAt: iso(-2 * minute),
        startedAt: iso(-2 * minute),
        finishedAt: null,
        remainingMs: 8 * minute,
        transfer: {
          networkFiles: 31,
          networkBytes: 48_600_000,
          reusedFiles: 0,
          reusedBytes: 0,
          placeholderFiles: 0,
          unresolvedFiles: 0,
        },
        logs: [
          { at: iso(-100 * 1000), stream: "stdout", line: "Authenticated course context loaded" },
          { at: iso(-78 * 1000), stream: "stdout", line: "phase announcements: 3.18s" },
          { at: iso(-44 * 1000), stream: "stdout", line: "downloaded Week 03 - Component architecture.pdf (2841200 bytes)" },
          { at: iso(-12 * 1000), stream: "stdout", line: "downloading Week 04 - Routing and state.pdf" },
        ],
      },
    ],
    runtime: {
      base: "https://blackboard.example.edu",
      stateFile: "/home/student/blackboard-fetcher/.blackboard-state.json",
    },
    progress: 42,
    remainingMs: 8 * minute,
    estimatedEndAt: iso(8 * minute),
    counts: { running: 1 },
  };
}

const filePage = {
  files,
  total: files.length,
  offset: 0,
  limit: 50,
  scope: "materials",
  counts: {
    materials: { files: 402, bytes: 627_400_000 },
    exports: { files: 74, bytes: 2_400_000 },
    records: { files: 138, bytes: 4_800_000 },
    all: { files: 540, bytes: 634_600_000 },
  },
  indexing: false,
  status: { status: "ready", fileCount: 540 },
};

async function installApiFixtures(page) {
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
  const response = await fetch(dashboardUrl);
  if (!response.ok) {
    throw new Error(`Dashboard returned HTTP ${response.status}. Start it with npm run dashboard.`);
  }

  await mkdir(outputDirectory, { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    await captureScreenshots(browser);
    const videoPath = await captureWorkflowVideo(browser);
    await buildGif(videoPath);
  } finally {
    await browser.close();
  }

  console.log(`README tutorial assets written to ${path.relative(projectRoot, outputDirectory)}`);
}

await main();
