// Fetch one Blackboard course, including student-visible metadata and submissions.
// Keep the Playwright storage-state file private because it contains active session cookies.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { archiveBlackboardExtras } = require("./blackboard-extra-archive");
const { streamResponseToTempFile } = require("../adapters/filesystem/blackboard-download-stream");
const {
  buildLegacyReviewUrl,
  isReviewableQuizAssessment,
  parseLegacyReviewHtml,
  renderLegacyReviewHtml,
  renderLegacyReviewText,
} = require("../adapters/blackboard/blackboard-legacy-quiz");
const {
  filenameFromContentDisposition,
  isBlackboardAuthenticationRedirect,
  isOpaqueBlackboardFilename,
  uiPageLabel,
} = require("../domain/course-fetch/blackboard-attachment-policy");
const {
  buildClassicSubmissionHistoryUrl,
  buildStudentFeedbackUrl,
  isAnnotatableSubmission,
} = require("../domain/course-fetch/blackboard-browser-workflow-policy");
const {
  buildLtiLaunchUrl,
  isLtiHandler,
  ltiDetail,
} = require("../domain/course-fetch/blackboard-lti-policy");
const {
  renderH5pHtml,
  renderH5pText,
} = require("../domain/course-fetch/h5p-content");
const {
  ARCHIVE_DIRECTORIES,
  CURRENT_ARCHIVE_LAYOUT_VERSION,
  createArchiveLayout,
  migrateLegacyArchiveLayout,
  sanitizePart,
} = require("../adapters/filesystem/blackboard-archive-layout");
const {
  parseCourseFetchArguments,
  resolveCourseFetchInput,
} = require("../adapters/cli/course-fetch-cli");
const {
  createBlackboardRestClient,
} = require("../adapters/blackboard/blackboard-rest-client");
const {
  BlackboardContentAttachmentGateway,
} = require("../adapters/blackboard/blackboard-content-attachment-gateway");
const {
  BlackboardAttachmentHtmlGateway,
} = require("../adapters/blackboard/blackboard-attachment-html-gateway");
const {
  BlackboardLtiH5pGateway,
} = require("../adapters/blackboard/blackboard-lti-h5p-gateway");
const {
  PlaywrightAttachmentResourceGateway,
} = require("../adapters/blackboard/playwright-attachment-resource-gateway");
const {
  PlaywrightBlackboardExtrasGateway,
} = require("../adapters/blackboard/playwright-blackboard-extras-gateway");
const {
  PlaywrightClassicSubmissionGateway,
} = require("../adapters/blackboard/playwright-classic-submission-gateway");
const {
  PlaywrightFeedbackDownloadGateway,
} = require("../adapters/blackboard/playwright-feedback-download-gateway");
const {
  PlaywrightQuizReviewGateway,
} = require("../adapters/blackboard/playwright-quiz-review-gateway");
const { createCourseFileStore } = require("../adapters/filesystem/course-file-store");
const { PlaywrightStateRepository } = require("../adapters/filesystem/playwright-state-repository");
const {
  AttachmentUrlRecoveryService,
} = require("../application/course-fetch/attachment-url-recovery-service");
const {
  CourseFileTransferService,
} = require("../application/course-fetch/course-file-transfer-service");
const {
  validateCourseFetchInput,
} = require("../application/course-fetch/course-fetch-configuration");
const {
  CourseFetchProgressReporter,
} = require("../application/course-fetch/course-fetch-progress");
const {
  coverageExclusions,
  coverageScope,
  createCourseFetchManifest,
  indexPreviousDownloads,
} = require("../domain/course-fetch/course-fetch-manifest");
const { recordManifestArtifact } = require("../domain/archive/archive-artifact");
const { finiteNumber } = require("../domain/course-fetch/course-file-policy");

const cli = parseCourseFetchArguments(process.argv.slice(2));
const input = resolveCourseFetchInput(cli);
const stateRepository = new PlaywrightStateRepository();
try {
  validateCourseFetchInput(input, stateRepository);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const COURSE_ID = input.courseId;
const BASE = input.base;
const STATE_FILE = input.stateFile;
const OUT_ROOT = input.outputRoot;
const DOWNLOAD_MODE = input.downloadMode;
const REUSE_VALIDATED_CACHE = input.reuseValidatedCache;
const ATTACHMENT_CONCURRENCY = input.attachmentConcurrency;
const COURSE_NAME_HINT = input.courseNameHint;
const COURSE_TERM_HINT = input.courseTermHint;
const MANIFEST_FILE = path.join(OUT_ROOT, "manifest.json");

const state = stateRepository.load(STATE_FILE);
let previousManifest = null;
try {
  previousManifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
} catch {}
const layoutMigration = migrateLegacyArchiveLayout(OUT_ROOT, previousManifest);
if (layoutMigration.length) {
  console.log(`migrated ${layoutMigration.length} archive directories to layout ${CURRENT_ARCHIVE_LAYOUT_VERSION}`);
}

const manifest = createCourseFetchManifest({
  archiveLayoutVersion: CURRENT_ARCHIVE_LAYOUT_VERSION,
  attachmentConcurrency: ATTACHMENT_CONCURRENCY,
  courseId: COURSE_ID,
  downloadMode: DOWNLOAD_MODE,
  generatedAt: new Date().toISOString(),
  layoutMigration,
  outputRoot: OUT_ROOT,
  reuseValidatedCache: REUSE_VALIDATED_CACHE,
});
const fetchStartedAt = performance.now();
const gradeCache = new Map();
const pendingFeedbackDownloads = [];
const pendingAnnotationChecks = [];
const pendingClassicAttemptFiles = [];
const pendingExternalLinks = [];
const pendingQuizReviewFallbacks = [];
let gradebookOverviewCount = 0;
let gradebookOverviewLoaded = false;
const previousDownloadsBySource = indexPreviousDownloads(previousManifest);
const progressReporter = new CourseFetchProgressReporter({
  elapsedNow: () => performance.now(),
  enabled: input.progressEvents,
  log: (message) => console.log(message),
  manifest,
  output: (line) => process.stdout.write(line),
  relativePath: (file) => path.relative(OUT_ROOT, file).replace(/\\/g, "/"),
});
const emitProgress = progressReporter.emit.bind(progressReporter);
const emitTransfer = progressReporter.transfer.bind(progressReporter);
const runPhase = progressReporter.runPhase.bind(progressReporter);
const courseFileStore = createCourseFileStore({ outputRoot: OUT_ROOT });
const ensureDir = courseFileStore.ensureDirectory;
const preferredPath = courseFileStore.preferredPath;
const uniquePath = courseFileStore.uniquePath;
const sha256File = courseFileStore.hashFile;
const writeStoredText = courseFileStore.writeText;

function archivePath(file) {
  return path.relative(OUT_ROOT, file).replace(/\\/g, "/");
}

function writeText(file, text, artifact = null) {
  writeStoredText(file, text);
  if (artifact) recordManifestArtifact(manifest, archivePath(file), artifact);
}

const CONTAINER_HANDLERS = new Set([
  "resource/x-bb-folder",
  "resource/x-bb-lesson",
  "resource/x-bb-learning-module",
]);
const LEAF_HANDLERS = new Set([
  "resource/x-bb-file",
  "resource/x-bb-asmt-test-link",
  "resource/x-bb-assignment",
  "resource/x-bb-externallink",
  "resource/x-bb-document",
  "resource/x-bb-video",
  "resource/x-bb-module-page",
]);
const KNOWN_HANDLERS = new Set([...CONTAINER_HANDLERS, ...LEAF_HANDLERS]);
const COVERAGE_SCOPE = coverageScope(DOWNLOAD_MODE);
const COVERAGE_EXCLUSIONS = coverageExclusions(DOWNLOAD_MODE);

function isKnownHandler(handler) {
  return (
    KNOWN_HANDLERS.has(handler) ||
    handler === "resource/x-plugin-scormengine" ||
    isLtiHandler(handler)
  );
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/(?:&nbsp;|&#160;|&#xa0;)/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absUrl(url) {
  return new URL(decodeHtml(String(url || "")), BASE).toString();
}

const blackboardClient = createBlackboardRestClient({
  base: BASE,
  resolveUrl: (value) => absUrl(value),
  state,
  warn: (message) => console.warn(message),
});
const bbJson = blackboardClient.get;
const cookieHeaderFor = blackboardClient.cookieHeaderFor;
const fetchWithRetry = blackboardClient.request;
const getAllPages = blackboardClient.all;
const ltiContentGateway = new BlackboardLtiH5pGateway({
  base: BASE,
  client: blackboardClient,
});
const contentAttachmentGateway = new BlackboardContentAttachmentGateway({
  client: blackboardClient,
});

const attachmentUrlRecoveryService = new AttachmentUrlRecoveryService({
  base: BASE,
  resolveUrl: (url) => absUrl(url),
  strategies: [
    {
      gateway: new BlackboardAttachmentHtmlGateway({ base: BASE, client: blackboardClient }),
      method: "authenticated Blackboard HTML",
    },
    {
      failureLabel: "Playwright resolver",
      gateway: new PlaywrightAttachmentResourceGateway({ base: BASE, stateFile: STATE_FILE }),
      method: "authenticated Blackboard browser UI",
    },
  ],
});
const quizReviewBrowserGateway = new PlaywrightQuizReviewGateway({
  base: BASE,
  stateFile: STATE_FILE,
});
const feedbackDownloadBrowserGateway = new PlaywrightFeedbackDownloadGateway({
  base: BASE,
  stateFile: STATE_FILE,
});
const classicSubmissionBrowserGateway = new PlaywrightClassicSubmissionGateway({
  base: BASE,
  stateFile: STATE_FILE,
});
const blackboardExtrasBrowserGateway = new PlaywrightBlackboardExtrasGateway({
  base: BASE,
  stateFile: STATE_FILE,
});

const fileTransferService = new CourseFileTransferService({
  client: blackboardClient,
  downloadMode: DOWNLOAD_MODE,
  emitTransfer,
  fileStore: courseFileStore,
  filenameFromContentDisposition,
  filenameFromUrl: (url) => path.basename(new URL(url).pathname),
  isOpaqueFilename: isOpaqueBlackboardFilename,
  logError: (message) => console.error(message),
  logInfo: (message) => console.log(message),
  manifest,
  previousDownloadsBySource,
  resolveUrl: (url) => absUrl(url),
  reuseValidatedCache: REUSE_VALIDATED_CACHE,
  streamResponse: streamResponseToTempFile,
});

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(html) {
  return decodeHtml(String(html || ""))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function roundNumber(value, digits = 4) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function summarizeGrade(grade, fallbackPossible = null) {
  if (!grade) return null;
  const score = finiteNumber(grade.effectiveScore ?? grade.displayGrade?.score ?? grade.manualScore);
  const possible = finiteNumber(grade.pointsPossible ?? fallbackPossible);
  return {
    id: grade.id || null,
    status: grade.status || null,
    submissionStatus: grade.submissionStatus?.status || null,
    score: roundNumber(score),
    pointsPossible: roundNumber(possible),
    percentage: score !== null && possible ? roundNumber((score / possible) * 100, 2) : null,
    attemptsLeft: finiteNumber(grade.attemptsLeft),
    isCalculated: grade.isCalculatedColumnGrade ?? false,
    isExempt: grade.isExempt ?? false,
    isOverride: grade.displayGrade?.isOverride ?? false,
    viewedByStudent: grade.hasBeenViewedByStudent ?? null,
    reviewedAt: grade.studentReviewedTimestamp || null,
    hasAttemptOrGradeFeedback: grade.hasAttemptOrGradeFeedback ?? null,
    hasRubricAssociations: grade.column?.hasRubricAssociations ?? null,
    canStudentViewGradeResults: grade.canStudentViewGradeResults ?? null,
    lastAttemptId: grade.lastAttempt?.id || grade.lastAttemptId || null,
    lastAttemptStatus: grade.lastAttempt?.status || null,
    lastAttemptDate: grade.lastAttempt?.attemptDate || null,
  };
}

async function getColumnGrade(columnId, userId) {
  if (gradeCache.has(columnId)) return gradeCache.get(columnId);
  try {
    const grades = await bbJson(
      `/learn/api/v1/courses/${COURSE_ID}/gradebook/columns/${columnId}/grades?expand=attemptsLeft&userId=${encodeURIComponent(userId)}`
    );
    const grade = (grades.results || [])[0] || null;
    gradeCache.set(columnId, grade);
    return grade;
  } catch (error) {
    if (/grade-detail-not-loaded|does not have a grade|404 Not Found/i.test(error.message)) {
      gradeCache.set(columnId, null);
      return null;
    }
    throw error;
  }
}

async function primeGradeCache(userId) {
  const query = [
    `userId=${encodeURIComponent(userId)}`,
    "sort=column.position%28asc%29",
    "expand=lastAttempt%2CattemptsLeft%2CsubmissionStatus%2ChasAttemptOrGradeFeedback%2Ccolumn%2Ccolumn.collectExternalSubmissions%2ChasRubricAssociations%2Ccolumn.restricted%2CcanStudentViewGradeResults%2Ccolumn.isLateAttemptCreationDisallowed%2CparticipationRequirements",
    "includeNoGradeItems=true",
    "skipExternalGrade=true",
    "skipKnowledgeCheck=true",
  ].join("&");
  const grades = await getAllPages(`/learn/api/v1/courses/${COURSE_ID}/gradebook/grades?${query}`);
  for (const grade of grades) {
    const columnId = grade.columnId || grade.column?.id;
    if (columnId) gradeCache.set(columnId, grade);
  }
  return grades.length;
}

function htmlPage(title, bodyHtml, meta = {}) {
  const rows = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join("\n");
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:Arial,sans-serif;line-height:1.45;max-width:960px;margin:32px auto;padding:0 20px}dt{font-weight:700}dd{margin:0 0 8px 0}img{max-width:100%}</style>",
    `<h1>${escapeHtml(title)}</h1>`,
    rows ? `<dl>${rows}</dl>` : "",
    bodyHtml || "",
  ].join("\n");
}

const archiveLayout = createArchiveLayout(OUT_ROOT);
const dirForAncestors = archiveLayout.directoryForAncestors;
const dirForItem = archiveLayout.directoryForItem;

function getFileDetail(item) {
  return item?.contentDetail?.["resource/x-bb-file"]?.file || null;
}

function getAssessmentDetail(item) {
  return (
    item?.contentDetail?.["resource/x-bb-asmt-test-link"]?.test ||
    item?.contentDetail?.["resource/x-bb-assignment"] ||
    null
  );
}

function getExternalLinkDetail(item) {
  return item?.contentDetail?.["resource/x-bb-externallink"] || null;
}

function isDocument(item) {
  return item?.contentHandler === "resource/x-bb-document";
}

function isContainer(item) {
  return (
    CONTAINER_HANDLERS.has(item?.contentHandler) ||
    !!item?.contentDetail?.["resource/x-bb-folder"]?.isFolder ||
    !!item?.contentDetail?.["resource/x-bb-lesson"] ||
    !!item?.contentDetail?.["resource/x-bb-learning-module"]
  );
}

function attachmentKey(att) {
  return att.fileId || `${att.url || ""}|${att.fileName || ""}`;
}

function mergeAttachments(...groups) {
  const merged = [];
  const seen = new Set();
  for (const attachment of groups.flat()) {
    if (!attachment) continue;
    const key = attachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(attachment);
  }
  return merged;
}

function uniqueUrls(values) {
  return [...new Set(values.filter(Boolean).map((value) => absUrl(value)))];
}

function announcementUiContext(announcement) {
  const classic = new URL("/webapps/blackboard/execute/announcement", BASE);
  classic.searchParams.set("method", "search");
  classic.searchParams.set("context", "course_entry");
  classic.searchParams.set("course_id", COURSE_ID);
  classic.searchParams.set("handle", "announcements_entry");
  classic.searchParams.set("mode", "view");
  return {
    type: "announcement",
    id: announcement.id || null,
    uiUrls: uniqueUrls([
      classic.toString(),
      `/ultra/courses/${encodeURIComponent(COURSE_ID)}/announcements`,
    ]),
  };
}

function contentUiContext(item, extraUrls = []) {
  const classicIds = [item?.parentId, item?.id].filter((id) => /^_\d+_\d+$/.test(String(id || "")));
  const classicUrls = classicIds.map((contentId) => {
    const url = new URL("/webapps/blackboard/content/listContent.jsp", BASE);
    url.searchParams.set("course_id", COURSE_ID);
    url.searchParams.set("content_id", contentId);
    return url.toString();
  });
  return {
    type: "content",
    id: item?.id || null,
    parentId: item?.parentId || null,
    uiUrls: uniqueUrls([
      ...extraUrls,
      `/ultra/courses/${encodeURIComponent(COURSE_ID)}/outline`,
      ...classicUrls,
    ]),
  };
}

function assessmentUiContext(item, columnId) {
  const gradeUrl = columnId
    ? `/ultra/courses/${encodeURIComponent(COURSE_ID)}/grades/student-grade-and-feedback?courseId=${encodeURIComponent(
        COURSE_ID
      )}&columnId=${encodeURIComponent(columnId)}&contentId=${encodeURIComponent(item?.id || "")}`
    : null;
  return contentUiContext(item, [gradeUrl]);
}

function attachUiContext(attachment, uiContext) {
  if (uiContext?.uiUrls?.length) {
    Object.defineProperty(attachment, "uiContext", {
      value: uiContext,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return attachment;
}

function extractAttachments(html, source, owner = null) {
  const found = [];
  const seen = new Set();
  const tagRe = /<a\b[^>]*>[\s\S]*?<\/a>|<(?:img|source|video|audio)\b[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(String(html || "")))) {
    const tag = match[0];
    const attrs = {};
    const attrRe = /([^\s"'=<>`]+)\s*=\s*(["'])([\s\S]*?)\2/gi;
    let attr;
    while ((attr = attrRe.exec(tag))) attrs[attr[1].toLowerCase()] = attr[3];

    const href = decodeHtml(attrs.href || attrs.src || "");
    let info = {};
    const bbFileData = attrs["data-bbfile"] || attrs["data-bb-file"];
    if (bbFileData) {
      try {
        info = JSON.parse(decodeHtml(bbFileData));
      } catch {}
    }

    const label = stripHtml(tag) || decodeHtml(attrs.alt || attrs.title || "");
    const url = info.resourceUrl || href || info.viewerUrl;
    let urlFileName = "";
    try {
      urlFileName = decodeURIComponent(path.basename(new URL(url, BASE).pathname));
    } catch {}
    const fileName = info.fileName || info.displayName || info.linkName || label || urlFileName;
    const isBbFile =
      /bbcswebdav/i.test(url) ||
      attrs["data-bbtype"] === "attachment" ||
      !!bbFileData ||
      !!info.resourceUrl ||
      !!info.viewerUrl;
    if (!isBbFile || !url || !fileName) continue;

    const att = attachUiContext({
      fileName,
      url: absUrl(url),
      mimeType: info.mimeType || "",
      fileSize: info.fileSize || null,
      fileId: info.id || info.fileId || info.existingFileReference || null,
      source,
    }, owner);
    const key = attachmentKey(att);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(att);
    }
  }
  return found;
}

function shouldProbeContentAttachmentApi(item) {
  return (
    String(manifest.course?.ultraStatus || "").toUpperCase() !== "ULTRA" &&
    item?.contentHandler !== "resource/x-bb-file" &&
    !isContainer(item)
  );
}

async function discoverContentApiAttachments(item) {
  if (!shouldProbeContentAttachmentApi(item)) {
    return {
      attachments: [],
      attempted: false,
      complete: true,
      endpoint: null,
      supported: null,
    };
  }

  try {
    const result = await contentAttachmentGateway.list({
      courseId: COURSE_ID,
      contentId: item.id,
    });
    const owner = contentUiContext(item);
    return {
      ...result,
      attachments: result.attachments.map((attachment) =>
        attachUiContext(
          {
            ...attachment,
            source: `${item.title || item.id} Blackboard content attachment`,
          },
          owner
        )
      ),
      attempted: true,
      complete: true,
    };
  } catch (error) {
    return {
      attachments: [],
      attempted: true,
      complete: false,
      endpoint: null,
      error: error.message,
      supported: null,
    };
  }
}

function inlineContentAttachments(item) {
  if (isDocument(item)) {
    const html = item?.body?.displayText || item?.body?.rawText || "";
    return extractAttachments(
      html,
      `${item.title} document`,
      contentUiContext(item)
    );
  }

  const wrapper = getAssessmentDetail(item);
  if (wrapper) {
    const assessment = wrapper.assessment || {};
    const column = wrapper.gradingColumn || {};
    const instructions = assessment.instructions || item.body || {};
    const html = instructions.displayText || instructions.rawText || "";
    return extractAttachments(
      html,
      `${item.title} instructions`,
      assessmentUiContext(item, column.id)
    );
  }

  if (getFileDetail(item)) return [];
  const html = item?.body?.displayText || item?.body?.rawText || "";
  return extractAttachments(html, `${item.title} body`, contentUiContext(item));
}

function stabilizeAttachment(attachment) {
  return attachUiContext(
    {
      ...attachment,
      sourceUrl: absUrl(attachment.sourceUrl || attachment.url),
    },
    attachment.uiContext
  );
}

function contentAttachmentRecord(attachment) {
  return {
    id: attachment.fileId || null,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType || null,
    fileSize: finiteNumber(attachment.fileSize),
    source: attachment.source || null,
    sourceUrl: attachment.sourceUrl,
    files: [],
    covered: false,
    placeholder: false,
    unresolved: false,
  };
}

function associateContentAttachmentDownloads(record, downloads) {
  for (const attachment of record.attachments) {
    const matches = downloads.filter(
      (download) => download.sourceUrl === attachment.sourceUrl
    );
    attachment.files = [...new Set(matches.map((download) => download.path).filter(Boolean))];
    attachment.placeholder = matches.some((download) => download.placeholder === true);
    attachment.unresolved = matches.some((download) => download.unresolved === true);
    attachment.covered =
      matches.some((download) => download.unresolved !== true) &&
      attachment.files.length > 0;
  }
}

function directSubmissionFiles(attemptDetail, source, uiContext = null) {
  const entries = [
    attemptDetail?.studentSubmissionFiles,
    attemptDetail?.submissionFiles,
    attemptDetail?.feedbackFiles,
    attemptDetail?.attachments,
  ]
    .filter(Array.isArray)
    .flat();
  return entries
    .map((entry) => {
      const file = entry.file || {};
      const fileName = file.fileName || entry.name || entry.linkName || entry.fileName;
      const url = file.permanentUrl || entry.downloadUrl || file.downloadUrl || file.viewerUrl || entry.viewUrl;
      if (!fileName || !url) return null;
      return attachUiContext({
        fileName,
        url: absUrl(url),
        mimeType: file.mimeType || entry.mimeType || "",
        fileSize: file.fileSize || entry.fileSize || null,
        fileId: file.existingFileReference || entry.bbFileUuid || entry.id || null,
        source,
      }, uiContext);
    })
    .filter(Boolean);
}

function viewerSubmissionFiles(...details) {
  const files = [];
  const seen = new Set();
  for (const detail of details) {
    for (const entry of detail?.studentSubmissionFiles || []) {
      if (!entry.viewUrl) continue;
      const fileName = entry.file?.fileName || entry.name || entry.linkName || entry.fileName || "submission";
      const key = entry.id || entry.bbFileUuid || `${fileName}|${entry.viewUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({
        fileName,
        viewUrl: entry.viewUrl,
        mimeType: entry.file?.mimeType || entry.mimeType || null,
      });
    }
  }
  return files;
}

async function downloadFile(file, dir, label, options = {}) {
  const prepared = fileTransferService.prepare(file);
  if (fileTransferService.usesPlaceholder(prepared)) {
    return fileTransferService.transfer(prepared, dir, label, options);
  }
  try {
    return await fileTransferService.transfer(prepared, dir, label, options);
  } catch (error) {
    let diagnostics = [];
    if (options.resolveWithUi && file.uiContext) {
      const resolution = await attachmentUrlRecoveryService.recover(file);
      diagnostics = resolution.diagnostics;
      for (const candidate of resolution.candidates) {
        let candidateError = null;
        const retryFile = attachUiContext(
          {
            ...file,
            fileName: prepared.fileName,
            url: candidate.url,
            resolutionMethod: candidate.method,
          },
          file.uiContext
        );
        const downloaded = await downloadFile(retryFile, dir, label, {
          ...options,
          resolveWithUi: false,
          recordUnresolved: false,
          onError: (retryError) => {
            candidateError = retryError;
          },
        });
        if (downloaded) {
          console.log(`resolved ${label} via ${candidate.method}`);
          return downloaded;
        }
        diagnostics.push(`${uiPageLabel(candidate.url, BASE)}: retry failed (${candidateError?.message || "unknown error"})`);
      }
    }
    if (options.recordUnresolved) {
      return fileTransferService.writeUnresolved(prepared, dir, label, error, diagnostics);
    }
    if (options.onError) options.onError(error);
    fileTransferService.recordFailure(prepared, label, error, {
      deferred: Boolean(options.onError),
    });
    return null;
  }
}

async function downloadAttachments(attachments, dir, label) {
  const uniqueAttachments = [];
  const seen = new Set();
  for (const att of attachments) {
    const key = attachmentKey(att);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAttachments.push(att);
  }

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < uniqueAttachments.length) {
      const index = nextIndex;
      nextIndex += 1;
      const att = uniqueAttachments[index];
      await downloadFile(att, dir, `${label}: ${att.fileName}`, {
        allowSizeMismatch: true,
        recordUnresolved: true,
        resolveWithUi: true,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ATTACHMENT_CONCURRENCY, uniqueAttachments.length) }, () => worker())
  );
}

async function downloadFeedbackAttachments(attachments, dir, label, context) {
  const paths = [];
  const seen = new Set();
  for (const att of attachments) {
    const key = attachmentKey(att);
    if (seen.has(key)) continue;
    seen.add(key);

    let directError = null;
    const downloaded = await downloadFile(att, dir, `${label}: ${att.fileName}`, {
      allowSizeMismatch: true,
      onError: (error) => {
        directError = error;
      },
    });
    if (downloaded) {
      paths.push(path.relative(OUT_ROOT, downloaded));
      continue;
    }

    pendingFeedbackDownloads.push({
      ...context,
      attachment: att,
      dir,
      label: `${label}: ${att.fileName}`,
      directError: directError?.message || "Direct download failed",
      outputPaths: paths,
    });
  }
  return paths;
}

async function saveCourseFile(item, ancestors) {
  const file = getFileDetail(item);
  if (!file) return;
  const dir = dirForItem(ancestors, item.title, ancestors.length === 0);
  await downloadFile(
    {
      fileName: file.fileName || item.title,
      url: file.permanentUrl || file.viewerUrl,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    },
    dir,
    [...ancestors, item.title].join(" / ")
  );
}

async function saveBodyAttachments(item, ancestors, attachments = []) {
  if (isDocument(item) || getAssessmentDetail(item)) return;
  const html = item?.body?.displayText || item?.body?.rawText || "";
  if (attachments.length === 0) return;
  const dir = dirForItem(ancestors, item.title, true);
  writeText(path.join(dir, "body.html"), htmlPage(`${item.title} body`, html), {
    origin: "blackboard-content-export",
    role: "content-body-rendered",
    searchable: false,
    logicalItemType: "content",
    logicalItemId: item.id || null,
    logicalItemTitle: item.title,
  });
  await downloadAttachments(attachments, path.join(dir, "body_attachments"), `${item.title} body`);
}

async function saveDocument(item, ancestors, attachments = []) {
  if (!isDocument(item)) return;
  const html = item?.body?.displayText || item?.body?.rawText || "";
  const dir = dirForItem(ancestors, item.title, true);
  ensureDir(dir);
  const htmlPath = path.join(dir, "document.html");
  const textPath = path.join(dir, "document.txt");
  writeText(htmlPath, htmlPage(item.title, html, { contentId: item.id }), {
    origin: "blackboard-content-export",
    role: "document-rendered",
    searchable: false,
    logicalItemType: "content",
    logicalItemId: item.id || null,
    logicalItemTitle: item.title,
  });
  writeText(textPath, stripHtml(html), {
    origin: "derived-search-text",
    role: "document-search-text",
    primaryPath: archivePath(htmlPath),
    groupKey: archivePath(htmlPath),
    logicalItemType: "content",
    logicalItemId: item.id || null,
    logicalItemTitle: item.title,
  });
  await downloadAttachments(
    attachments,
    path.join(dir, "document_files"),
    `${item.title} document`
  );
}

async function saveExternalLink(item, ancestors) {
  const link = getExternalLinkDetail(item);
  if (!link?.url) return;
  const dir = dirForItem(ancestors, item.title, true);
  ensureDir(dir);
  const url = absUrl(link.url);
  const title = sanitizePart(item.title, "link");
  const shortcutPath = path.join(dir, `${title}.url`);
  writeText(shortcutPath, `[InternetShortcut]\nURL=${url}\n`, {
    origin: "blackboard-content-export",
    role: "external-link",
    hiddenByDefault: false,
    logicalItemType: "content",
    logicalItemId: item.id || null,
    logicalItemTitle: item.title,
  });
  writeText(
    path.join(dir, `${title}.html`),
    htmlPage(item.title, `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`, {
      contentId: item.id,
      type: "external link",
    }),
    {
      origin: "blackboard-content-export",
      role: "external-link-rendered",
      primaryPath: archivePath(shortcutPath),
      groupKey: archivePath(shortcutPath),
      searchable: false,
      logicalItemType: "content",
      logicalItemId: item.id || null,
      logicalItemTitle: item.title,
    }
  );
  manifest.downloads.push({
    label: [...ancestors, item.title].join(" / "),
    fileName: `${title}.url`,
    path: path.relative(OUT_ROOT, shortcutPath),
    size: fs.statSync(shortcutPath).size,
    sourceUrl: url,
    sha256: sha256File(shortcutPath),
    integrityVerified: true,
    linkOnly: true,
  });
  pendingExternalLinks.push({
    contentId: item.id || null,
    title: item.title,
    url,
    directory: dir,
  });
}

function summarizedLtiDetail(detail) {
  const column = detail?.gradingColumn || {};
  return {
    configuredUrl: detail?.url || null,
    placementHandle: detail?.placementHandle || null,
    itemOrigin: detail?.itemOrigin || null,
    launchLink: detail?.launchLink || null,
    deploymentApproved: detail?.isDeploymentApproved ?? null,
    providerAvailable: detail?.existsLTIProvider ?? null,
    domain: detail?.domainConfig
      ? {
          primaryDomain: detail.domainConfig.primaryDomain || null,
          status: detail.domainConfig.statusType || null,
          sendRole: detail.domainConfig.isSendRole ?? null,
          sendName: detail.domainConfig.isSendName ?? null,
          sendEmail: detail.domainConfig.isSendEmail ?? null,
        }
      : null,
    gradingColumn: column.id
      ? {
          id: column.id,
          title: column.effectiveColumnName || column.columnName || null,
          possiblePoints: roundNumber(column.possible),
          dueDate: column.dueDate || null,
          gradesReleased: column.gradesReleased ?? null,
        }
      : null,
  };
}

async function createLtiAssessment(item, ancestors, me, ltiRecord) {
  const detail = ltiDetail(item) || {};
  const column = detail.gradingColumn || {};
  if (!column.id) return null;
  const existing = manifest.assessments.find((assessment) => assessment.contentId === item.id);
  if (existing) return existing;

  let grade = null;
  try {
    grade = await getColumnGrade(column.id, me?.id);
  } catch (error) {
    manifest.errors.push({ label: item.title, error: `LTI grade lookup: ${error.message}` });
  }
  const gradeSummary = summarizeGrade(grade, column.possible);
  const dir = dirForItem(ancestors, item.title, true);
  const assessment = {
    title: item.title,
    contentHandler: item.contentHandler || null,
    contentId: item.id,
    columnId: column.id,
    dueDate: column.dueDate || null,
    possiblePoints: roundNumber(column.possible),
    multipleAttempts: finiteNumber(column.multipleAttempts),
    isGroup: item?.isGroupContent ?? detail.allowGroupLaunch ?? false,
    assignedGroups: [],
    directory: path.relative(OUT_ROOT, dir),
    grade: gradeSummary,
    attempts: [],
    lti: {
      provider: ltiRecord.provider,
      status: ltiRecord.status,
      resourceCount: 0,
      contentUserStatus: null,
    },
  };
  if (gradeSummary?.lastAttemptId) {
    assessment.attempts.push({
      id: gradeSummary.lastAttemptId,
      status: gradeSummary.lastAttemptStatus,
      attemptDate: gradeSummary.lastAttemptDate,
      groupAttemptId: null,
      groupName: null,
      groupAssociationId: null,
      submittedBy: null,
      grade: gradeSummary,
      receipt: null,
      submissionTotalSize: null,
      directory: assessment.directory,
      files: [],
      feedback: null,
      annotations: [],
      summaryOnly: true,
      source: "Blackboard gradebook and H5P attempt summary",
    });
  }
  manifest.assessments.push(assessment);
  return assessment;
}

function writeLtiMetadata(item, detail, record, assessment) {
  const metadataPath = path.join(OUT_ROOT, record.directory, "lti_metadata.json");
  const metadata = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    source: "Blackboard Learn content API and authenticated LTI launch",
    contentId: item.id || null,
    title: item.title || null,
    contentHandler: item.contentHandler || null,
    description: stripHtml(item?.body?.displayText || item?.body?.rawText || ""),
    provider: record.provider,
    providerHost: record.providerHost,
    status: record.status,
    complete: record.complete,
    launchUrl: record.launchUrl,
    targetUrl: record.targetUrl,
    detail: summarizedLtiDetail(detail),
    assessment: assessment
      ? {
          columnId: assessment.columnId,
          possiblePoints: assessment.possiblePoints,
          dueDate: assessment.dueDate,
          grade: assessment.grade,
          attemptCount: assessment.attempts.length,
        }
      : null,
    resources: record.resources,
    diagnostics: record.diagnostics,
    error: record.error || null,
  };
  writeText(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    origin: "fetcher-record",
    role: "lti-metadata",
    searchable: false,
    logicalItemType: "content",
    logicalItemId: item.id || null,
    logicalItemTitle: item.title,
  });
  record.metadataPath = archivePath(metadataPath);
}

async function saveLtiContent(item, ancestors, me) {
  if (!isLtiHandler(item?.contentHandler)) return;
  const detail = ltiDetail(item) || {};
  const dir = dirForItem(ancestors, item.title, true);
  ensureDir(dir);
  const launchUrl = buildLtiLaunchUrl({
    base: BASE,
    courseId: COURSE_ID,
    contentId: item.id,
    detail,
  });
  const record = {
    contentId: item.id || null,
    title: item.title || null,
    contentHandler: item.contentHandler || null,
    directory: path.relative(OUT_ROOT, dir),
    launchUrl,
    targetUrl: detail.url || null,
    provider: "unknown-lti",
    providerHost: null,
    status: "pending",
    complete: false,
    resources: [],
    diagnostics: [],
  };
  manifest.ltiResources.push(record);
  const assessment = await createLtiAssessment(item, ancestors, me, record);

  let result;
  try {
    result = await ltiContentGateway.collect({ detail, launchUrl });
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    manifest.warnings.push({
      label: item.title,
      warning: `LTI content launch failed: ${error.message}`,
    });
    writeLtiMetadata(item, detail, record, assessment);
    return;
  }

  record.provider = result.provider;
  record.providerHost = result.providerHost;
  record.targetUrl = result.targetUrl;
  record.diagnostics = result.diagnostics || [];
  if (result.status !== "ready") {
    record.status = result.status;
    manifest.warnings.push({
      label: item.title,
      warning: `No archive adapter is available for LTI provider ${result.providerHost || "unknown"}`,
    });
    if (assessment) assessment.lti = { ...assessment.lti, provider: record.provider, status: record.status };
    writeLtiMetadata(item, detail, record, assessment);
    return;
  }

  for (const resource of result.resources) {
    const resourceDir = result.resources.length === 1
      ? dir
      : path.join(dir, sanitizePart(resource.title || resource.contentId || "H5P content"));
    ensureDir(resourceDir);
    const resourceRecord = {
      contentId: resource.contentId,
      title: resource.title,
      library: resource.library,
      metadata: resource.metadata,
      displayOptions: resource.displayOptions,
      contentUserStatus: resource.contentUserStatus,
      canViewOwnReports: resource.canViewOwnReports,
      isScoringEnabled: resource.isScoringEnabled,
      embedUrl: resource.embedUrl,
      scripts: resource.scripts,
      styles: resource.styles,
      contentPath: null,
      questionsHtmlPath: null,
      questionsTextPath: null,
      packagePath: null,
      packagePlaceholder: false,
      complete: false,
    };

    if (resource.content) {
      const htmlPath = path.join(resourceDir, "h5p_questions.html");
      const textPath = path.join(resourceDir, "h5p_questions.txt");
      const contentPath = path.join(resourceDir, "h5p_content.json");
      const groupKey = archivePath(htmlPath);
      writeText(contentPath, `${JSON.stringify(resource.content, null, 2)}\n`, {
        origin: "blackboard-content-export",
        role: "h5p-content-data",
        hiddenByDefault: true,
        searchable: true,
        primaryPath: groupKey,
        groupKey,
        logicalItemType: "content",
        logicalItemId: item.id || null,
        logicalItemTitle: item.title,
      });
      writeText(htmlPath, renderH5pHtml({
        content: resource.content,
        library: resource.library,
        title: resource.title || item.title,
      }), {
        origin: "blackboard-content-export",
        role: "h5p-questions-rendered",
        hiddenByDefault: false,
        searchable: false,
        primaryPath: groupKey,
        groupKey,
        logicalItemType: "content",
        logicalItemId: item.id || null,
        logicalItemTitle: item.title,
      });
      writeText(textPath, renderH5pText({
        content: resource.content,
        library: resource.library,
        title: resource.title || item.title,
      }), {
        origin: "derived-search-text",
        role: "h5p-questions-search-text",
        hiddenByDefault: true,
        searchable: true,
        primaryPath: groupKey,
        groupKey,
        logicalItemType: "content",
        logicalItemId: item.id || null,
        logicalItemTitle: item.title,
      });
      resourceRecord.contentPath = archivePath(contentPath);
      resourceRecord.questionsHtmlPath = archivePath(htmlPath);
      resourceRecord.questionsTextPath = archivePath(textPath);
      if (assessment && !assessment.instructions) {
        assessment.instructions = {
          htmlPath: resourceRecord.questionsHtmlPath,
          textPath: resourceRecord.questionsTextPath,
          source: "H5P content",
        };
      }
    } else if (resource.contentError) {
      resourceRecord.contentError = resource.contentError;
      manifest.warnings.push({ label: item.title, warning: resource.contentError });
    }

    if (resource.package?.available) {
      const before = manifest.downloads.length;
      const packagePath = await downloadFile(
        {
          fileName: resource.package.fileName,
          url: resource.package.url,
          sourceUrl: resource.package.exportUrl,
          mimeType: resource.package.mimeType,
        },
        resourceDir,
        `${item.title}: H5P package`
      );
      if (packagePath) {
        resourceRecord.packagePath = archivePath(packagePath);
        const download = manifest.downloads.slice(before).find((entry) => entry.path === resourceRecord.packagePath);
        resourceRecord.packagePlaceholder = download?.placeholder === true;
        if (!resourceRecord.packagePlaceholder) {
          recordManifestArtifact(manifest, resourceRecord.packagePath, {
            origin: "external-resource",
            role: "h5p-package",
            hiddenByDefault: false,
            searchable: false,
            logicalItemType: "content",
            logicalItemId: item.id || null,
            logicalItemTitle: item.title,
          });
        }
      }
    } else {
      resourceRecord.packageError = resource.package?.reason || "H5P package export was unavailable";
      manifest.warnings.push({ label: item.title, warning: resourceRecord.packageError });
    }
    resourceRecord.complete = Boolean(resourceRecord.packagePath);
    record.resources.push(resourceRecord);
  }

  record.complete = record.resources.length > 0 && record.resources.every((resource) => resource.complete);
  record.status = record.complete ? "archived" : "partial";
  if (assessment) {
    assessment.lti = {
      provider: record.provider,
      status: record.status,
      resourceCount: record.resources.length,
      contentUserStatus: record.resources[0]?.contentUserStatus || null,
    };
  }
  writeLtiMetadata(item, detail, record, assessment);
}

function datePrefix(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "undated";
  return date.toISOString().slice(0, 10);
}

async function saveAnnouncements() {
  const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.announcements);
  ensureDir(dir);

  let announcements = [];
  try {
    announcements = await getAllPages(`/learn/api/v1/courses/${COURSE_ID}/announcements?sort=startDateRestriction%28desc%29`);
  } catch (error) {
    manifest.errors.push({ label: "announcements", error: error.message });
    return;
  }

  const index = [];
  for (const announcement of announcements) {
    const title = announcement.title || "Announcement";
    const postedAt = announcement.startDateRestriction || announcement.createdDate || "";
    const itemDir = path.join(dir, sanitizePart(`${datePrefix(postedAt)}_${title}`));
    const html = announcement?.body?.displayText || announcement?.body?.rawText || "";
    const record = {
      id: announcement.id || null,
      title,
      createdDate: announcement.createdDate || null,
      modifiedDate: announcement.modifiedDate || null,
      postedAt,
      read: announcement.readStatus?.isRead ?? null,
      directory: path.relative(OUT_ROOT, itemDir),
      files: [],
      attachments: [],
    };
    manifest.announcements.push(record);
    index.push(record);

    ensureDir(itemDir);
    const htmlPath = path.join(itemDir, "announcement.html");
    const textPath = path.join(itemDir, "announcement.txt");
    writeText(htmlPath, htmlPage(title, html, record), {
      origin: "blackboard-content-export",
      role: "announcement-rendered",
      searchable: false,
      logicalItemType: "announcement",
      logicalItemId: record.id,
      logicalItemTitle: title,
    });
    writeText(textPath, stripHtml(html), {
      origin: "derived-search-text",
      role: "announcement-search-text",
      primaryPath: archivePath(htmlPath),
      groupKey: archivePath(htmlPath),
      logicalItemType: "announcement",
      logicalItemId: record.id,
      logicalItemTitle: title,
    });
    const attachments = extractAttachments(
      html,
      `${title} announcement`,
      announcementUiContext(announcement)
    ).map(stabilizeAttachment);
    record.attachments = attachments.map(contentAttachmentRecord);
    const before = manifest.downloads.length;
    await downloadAttachments(
      attachments,
      path.join(itemDir, "files"),
      `${title} announcement`
    );
    const downloads = manifest.downloads.slice(before);
    record.files = downloads.map((download) => download.path);
    associateContentAttachmentDownloads(record, downloads);
  }

  writeText(
    path.join(dir, "README.md"),
    [
      `# ${currentCourseName()} Announcements`,
      "",
      `Generated: ${manifest.generatedAt}`,
      `Announcements discovered: ${announcements.length}`,
      "",
      ...index.map((a) => `- ${a.title} (${a.postedAt || "undated"}): ${a.directory}`),
      "",
    ].join("\n"),
    { origin: "fetcher-record", role: "archive-summary", searchable: false }
  );
}

function quizReviewEntry(item, assessment, column, grade, attempt, attemptRecord, attemptDir, attemptIndex) {
  if (!isReviewableQuizAssessment(item.contentHandler, assessment)) return null;
  const questionCount = finiteNumber(assessment?.questionCount);
  if (!new Set(["COMPLETED", "GRADED", "NEEDS_GRADING"]).has(String(attempt.status || "").toUpperCase())) {
    return null;
  }
  if (grade?.canStudentViewGradeResults === false) return null;

  const entry = {
    assessmentTitle: item.title,
    assessmentType: assessment?.subtype || assessment?.type || null,
    expectedQuestionCount: questionCount,
    contentId: item.id || null,
    columnId: column.id || null,
    gradeId: grade?.id || null,
    attemptId: attempt.id || null,
    attemptIndex,
    attemptDir,
    attemptRecord,
    reviewUrl: null,
    httpError: null,
    browserError: null,
    apiError: null,
  };
  attemptRecord.quizReviewExpected = true;
  try {
    entry.reviewUrl = buildLegacyReviewUrl({
      base: BASE,
      courseId: COURSE_ID,
      contentId: entry.contentId,
      gradeId: entry.gradeId,
      columnId: entry.columnId,
      attemptId: entry.attemptId,
    });
  } catch (error) {
    entry.httpError = error.message;
  }
  return entry;
}

function quizReviewFragments(review) {
  return [
    ...review.metadata.map((item) => item.html),
    ...review.questions.flatMap((question) => [
      question.prompt.html,
      ...question.answerSections.flatMap((section) => section.answers.map((answer) => answer.html)),
      ...question.detailSections.map((section) => section.html),
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

async function archiveQuizReviewHtml(entry, html, finalUrl, method) {
  const review = parseLegacyReviewHtml(html, finalUrl);
  review.generatedAt = manifest.generatedAt;
  review.discoveryMethod = method;
  review.identifiers = {
    courseId: COURSE_ID,
    contentId: entry.contentId,
    columnId: entry.columnId,
    gradeId: entry.gradeId,
    attemptId: entry.attemptId,
  };

  const attachments = extractAttachments(
    quizReviewFragments(review),
    `${entry.assessmentTitle} quiz review`,
    { type: "quizReview", id: entry.attemptId, uiUrls: [entry.reviewUrl] }
  );
  const beforeDownloads = manifest.downloads.length;
  await downloadAttachments(
    attachments,
    path.join(entry.attemptDir, "quiz_review_files"),
    `${entry.assessmentTitle} quiz review`
  );
  review.files = manifest.downloads.slice(beforeDownloads).map((download) => download.path);

  const jsonPath = path.join(entry.attemptDir, "quiz_review.json");
  const htmlPath = path.join(entry.attemptDir, "quiz_review.html");
  const rawHtmlPath = path.join(entry.attemptDir, "quiz_review.raw.html");
  const textPath = path.join(entry.attemptDir, "quiz_review.txt");
  const quizArtifact = {
    groupKey: archivePath(htmlPath),
    primaryPath: archivePath(htmlPath),
    logicalItemType: "assessment-attempt",
    logicalItemId: entry.attemptId,
    logicalItemTitle: entry.assessmentTitle,
  };
  writeText(jsonPath, `${JSON.stringify(review, null, 2)}\n`, {
    ...quizArtifact,
    origin: "blackboard-content-export",
    role: "quiz-review-data",
  });
  writeText(htmlPath, renderLegacyReviewHtml(review), {
    ...quizArtifact,
    origin: "blackboard-content-export",
    role: "quiz-review-rendered",
    searchable: false,
  });
  writeText(rawHtmlPath, html, {
    ...quizArtifact,
    origin: "blackboard-content-export",
    role: "quiz-review-raw",
    searchable: false,
  });
  writeText(textPath, renderLegacyReviewText(review), {
    ...quizArtifact,
    origin: "derived-search-text",
    role: "quiz-review-search-text",
  });
  const record = {
    source: "Blackboard Classic review.jsp",
    discoveryMethod: method,
    questionCount: review.questionCount,
    jsonPath: path.relative(OUT_ROOT, jsonPath),
    htmlPath: path.relative(OUT_ROOT, htmlPath),
    rawHtmlPath: path.relative(OUT_ROOT, rawHtmlPath),
    textPath: path.relative(OUT_ROOT, textPath),
    files: review.files,
  };
  entry.attemptRecord.quizReview = record;
  delete entry.attemptRecord.detailUnavailable;
  return record;
}

async function archiveQuizReviewWithHttp(entry) {
  if (!entry.reviewUrl) throw new Error(entry.httpError || "Classic quiz review URL could not be built");
  const response = await fetchWithRetry(
    entry.reviewUrl,
    {
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Cookie: cookieHeaderFor(entry.reviewUrl),
        "User-Agent": "Mozilla/5.0",
      },
    },
    `quiz review ${entry.attemptId}`
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Classic quiz review returned HTTP ${response.status} ${response.statusText}`);
  }
  if (isBlackboardAuthenticationRedirect(response.url, BASE)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Classic quiz review redirected to authentication");
  }
  const html = await response.text();
  return archiveQuizReviewHtml(entry, html, response.url, "authenticated Blackboard HTML");
}

function archiveQuizApiReview(entry, tool) {
  if (!Array.isArray(tool?.questionAttempts) || tool.questionAttempts.length === 0) return null;
  const payload = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    source: "Blackboard Learn attempt-detail API",
    identifiers: {
      courseId: COURSE_ID,
      contentId: entry.contentId,
      columnId: entry.columnId,
      gradeId: entry.gradeId,
      attemptId: entry.attemptId,
    },
    assessment: tool.assessment || null,
    questionAttempts: tool.questionAttempts,
  };
  const jsonPath = path.join(entry.attemptDir, "quiz_attempt_api.json");
  writeText(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, {
    origin: "blackboard-content-export",
    role: "quiz-attempt-data",
    logicalItemType: "assessment-attempt",
    logicalItemId: entry.attemptId,
    logicalItemTitle: entry.assessmentTitle,
  });
  const record = {
    source: payload.source,
    questionCount: payload.questionAttempts.length,
    jsonPath: path.relative(OUT_ROOT, jsonPath),
  };
  entry.attemptRecord.apiQuizReview = record;
  return record;
}

async function saveAssessment(item, ancestors, me, attachments = []) {
  const wrapper = getAssessmentDetail(item);
  if (!wrapper) return;

  const detail = item;
  const test = getAssessmentDetail(detail) || wrapper;
  const assessment = test.assessment || {};
  const column = test.gradingColumn || {};
  const dir = dirForItem(ancestors, item.title, true);
  const instructions = assessment.instructions || detail.body || {};
  const instructionsHtml = instructions.displayText || instructions.rawText || "";
  const record = {
    title: item.title,
    contentHandler: item.contentHandler || null,
    contentId: item.id,
    columnId: column.id || null,
    dueDate: column.dueDate || detail?.genericReadOnlyData?.dueDate || null,
    possiblePoints: roundNumber(column.possible),
    multipleAttempts: finiteNumber(column.multipleAttempts ?? test.deploymentSettings?.attemptCount),
    isGroup: detail?.isGroupContent ?? test.groupContent ?? false,
    assignedGroups: (detail?.assignedGroups || []).map((entry) => entry.groupTitle || entry.group?.title).filter(Boolean),
    directory: path.relative(OUT_ROOT, dir),
    grade: null,
    attempts: [],
  };
  manifest.assessments.push(record);

  ensureDir(dir);
  const instructionHtmlPath = path.join(dir, "instructions.html");
  const instructionTextPath = path.join(dir, "instructions.txt");
  record.instructions = {
    htmlPath: archivePath(instructionHtmlPath),
    textPath: archivePath(instructionTextPath),
  };
  writeText(instructionHtmlPath, htmlPage(`${item.title} - instructions`, instructionsHtml, record), {
    origin: "blackboard-content-export",
    role: "instructions-rendered",
    searchable: false,
    logicalItemType: "assessment",
    logicalItemId: item.id || column.id || null,
    logicalItemTitle: item.title,
  });
  writeText(instructionTextPath, stripHtml(instructionsHtml), {
    origin: "derived-search-text",
    role: "instructions-search-text",
    primaryPath: archivePath(instructionHtmlPath),
    groupKey: archivePath(instructionHtmlPath),
    logicalItemType: "assessment",
    logicalItemId: item.id || column.id || null,
    logicalItemTitle: item.title,
  });
  await downloadAttachments(
    attachments,
    path.join(dir, "instructions_files"),
    `${item.title} instructions`
  );

  if (!column.id || !me.id) return;

  let grade;
  try {
    grade = await getColumnGrade(column.id, me.id);
  } catch (error) {
    manifest.errors.push({ label: item.title, error: `grade lookup: ${error.message}` });
    return;
  }
  record.grade = summarizeGrade(grade, column.possible);
  if (!grade?.id) return;

  let attempts = [];
  try {
    attempts = await getAllPages(
      `/learn/api/v1/courses/${COURSE_ID}/gradebook/columns/${column.id}/grades/${grade.id}/attempts?fields=id,status,attemptDate,exempt,overrideStatus`
    );
  } catch (error) {
    manifest.errors.push({ label: item.title, error: `attempt list: ${error.message}` });
    return;
  }

  if (attempts.length === 0 && grade.lastAttempt?.id) attempts = [grade.lastAttempt];
  attempts.sort((left, right) => {
    const byDate = new Date(left.attemptDate || 0) - new Date(right.attemptDate || 0);
    return byDate || String(left.id || "").localeCompare(String(right.id || ""));
  });

  let idx = 0;
  for (const attempt of attempts) {
    idx += 1;
    const stamp = attempt.attemptDate ? attempt.attemptDate.replace(/[:.]/g, "-").replace("T", "_") : "no_date";
    const attemptDir = path.join(dir, "submissions", `Attempt_${String(idx).padStart(2, "0")}_${stamp}`);
    ensureDir(attemptDir);

    const attemptRecord = {
      id: attempt.id,
      status: attempt.status,
      attemptDate: attempt.attemptDate || null,
      groupAttemptId: null,
      groupName: null,
      groupAssociationId: null,
      submittedBy: null,
      grade: null,
      receipt: null,
      submissionTotalSize: null,
      directory: path.relative(OUT_ROOT, attemptDir),
      files: [],
      feedback: null,
      annotations: [],
    };
    record.attempts.push(attemptRecord);

    const reviewEntry = quizReviewEntry(item, assessment, column, grade, attempt, attemptRecord, attemptDir, idx);
    if (reviewEntry) {
      if (reviewEntry.reviewUrl) {
        try {
          await archiveQuizReviewWithHttp(reviewEntry);
        } catch (error) {
          reviewEntry.httpError = error.message;
          pendingQuizReviewFallbacks.push(reviewEntry);
        }
      } else {
        pendingQuizReviewFallbacks.push(reviewEntry);
      }
    }

    let attemptDetail;
    try {
      attemptDetail = await bbJson(`/learn/api/v1/courses/${COURSE_ID}/gradebook/attempts/${attempt.id}?columnId=${column.id}&expand=viewUrl%2CtoolAttemptDetail%2CfeedbackToUser`);
    } catch (error) {
      if (reviewEntry) {
        reviewEntry.apiError = error.message;
        attemptRecord.attemptDetailApiError = {
          reason: "Blackboard Learn rejected or failed to return this quiz attempt detail",
          error: error.message,
        };
        if (!attemptRecord.quizReview) {
          attemptRecord.detailUnavailable = {
            reason: "Quiz review fallbacks are pending",
            error: error.message,
          };
        }
        continue;
      }
      if (/Invalid question Type/i.test(error.message)) {
        attemptRecord.detailUnavailable = {
          reason: "Blackboard rejected this legacy quiz's question payload",
          error: error.message,
        };
        manifest.warnings.push({
          label: `${item.title} ${attempt.id}`,
          warning: "Attempt summary was archived, but Blackboard rejected the legacy quiz question payload",
        });
        continue;
      }
      manifest.errors.push({ label: `${item.title} ${attempt.id}`, error: `attempt detail: ${error.message}` });
      continue;
    }

    const tool =
      attemptDetail?.toolAttemptDetail?.["resource/x-bb-assessment"] ||
      attemptDetail?.toolAttemptDetail?.["resource/x-bb-assignment"] ||
      {};
    if (reviewEntry) archiveQuizApiReview(reviewEntry, tool);
    attemptRecord.groupAttemptId = attemptDetail.groupAttemptId || null;

    let groupAttemptDetail = null;
    if (attemptRecord.groupAttemptId) {
      try {
        groupAttemptDetail = await bbJson(
          `/learn/api/v1/courses/${COURSE_ID}/gradebook/groupAttempts/${attemptRecord.groupAttemptId}?expand=attempts,feedbackToUser,viewUrl`
        );
        attemptRecord.groupName = groupAttemptDetail.groupName || null;
        attemptRecord.groupAssociationId = groupAttemptDetail.groupAssociationId || null;
        attemptRecord.submittedBy = groupAttemptDetail.submittedBy || null;
      } catch (error) {
        manifest.errors.push({
          label: `${item.title} ${attemptRecord.groupAttemptId}`,
          error: `group attempt detail: ${error.message}`,
        });
      }
    }

    const submissionDetail = groupAttemptDetail || attemptDetail;
    const submission = submissionDetail.studentSubmission || attemptDetail.studentSubmission || tool.studentSubmission || {};
    const submissionHtml = submission.displayText || submission.rawText || "";
    const studentComments =
      submissionDetail.studentComments || attemptDetail.studentComments || tool.studentComments || {};
    const commentsHtml = studentComments.displayText || studentComments.rawText || "";
    const receipt =
      submissionDetail.receipt ||
      submissionDetail.attemptReceipt?.receiptId ||
      attemptDetail.receipt ||
      attemptDetail.attemptReceipt?.receiptId ||
      tool.receipt ||
      "";
    attemptRecord.grade = summarizeGrade(submissionDetail, column.possible);
    attemptRecord.receipt = receipt || null;
    attemptRecord.submissionTotalSize = finiteNumber(submissionDetail.attemptReceipt?.submissionTotalSize);
    const submissionHtmlPath = path.join(attemptDir, "submission.html");
    const submissionTextPath = path.join(attemptDir, "submission.txt");
    const submissionArtifact = {
      primaryPath: archivePath(submissionHtmlPath),
      groupKey: archivePath(submissionHtmlPath),
      logicalItemType: "assessment-attempt",
      logicalItemId: attempt.id,
      logicalItemTitle: item.title,
    };
    writeText(
      submissionHtmlPath,
      htmlPage(`${item.title} - submission ${idx}`, [submissionHtml, commentsHtml].filter(Boolean).join("\n<hr>\n"), {
        attemptId: attempt.id,
        groupAttemptId: attemptRecord.groupAttemptId || "",
        status: attempt.status || "",
        attemptDate: attempt.attemptDate || "",
        receipt,
      }),
      {
        ...submissionArtifact,
        origin: "blackboard-content-export",
        role: "submission-rendered",
        searchable: false,
      }
    );
    writeText(submissionTextPath, stripHtml([submissionHtml, commentsHtml].filter(Boolean).join("\n")), {
      ...submissionArtifact,
      origin: "derived-search-text",
      role: "submission-search-text",
    });

    for (const viewerFile of viewerSubmissionFiles(submissionDetail, attemptDetail, tool)) {
      pendingAnnotationChecks.push({
        assessmentTitle: item.title,
        attemptId: attempt.id,
        columnId: column.id,
        groupAttemptId: attemptRecord.groupAttemptId,
        fileName: viewerFile.fileName,
        mimeType: viewerFile.mimeType,
        viewUrl: viewerFile.viewUrl,
        attemptDir,
        attemptRecord,
      });
    }

    const submissionUiContext = assessmentUiContext(item, column.id);
    const directFiles = mergeAttachments(
      directSubmissionFiles(submissionDetail, `${item.title} submission ${idx}`, submissionUiContext),
      directSubmissionFiles(attemptDetail, `${item.title} submission ${idx}`, submissionUiContext),
      directSubmissionFiles(tool, `${item.title} submission ${idx}`, submissionUiContext)
    );
    const embeddedFiles = extractAttachments(
      submission.rawText || submission.displayText || "",
      `${item.title} submission ${idx}`,
      submissionUiContext
    );
    const submissionAttachments = mergeAttachments(directFiles, embeddedFiles);
    if (submissionAttachments.length) {
      writeText(path.join(attemptDir, "submitted_files.json"), JSON.stringify(submissionAttachments, null, 2), {
        origin: "fetcher-record",
        role: "submitted-files",
        searchable: false,
        logicalItemType: "assessment-attempt",
        logicalItemId: attempt.id,
        logicalItemTitle: item.title,
      });
    }
    const before = manifest.downloads.length;
    await downloadAttachments(submissionAttachments, path.join(attemptDir, "files"), `${item.title} submission ${idx}`);
    attemptRecord.files = manifest.downloads.slice(before).map((d) => d.path);
    if (
      item.contentHandler === "resource/x-bb-assignment" &&
      finiteNumber(attemptRecord.submissionTotalSize) > 0 &&
      attemptRecord.files.length === 0
    ) {
      pendingClassicAttemptFiles.push({
        assessmentTitle: item.title,
        columnId: column.id,
        gradeId: grade.id,
        attemptId: attempt.id,
        attemptIndex: idx,
        attemptDir,
        attemptRecord,
      });
    }

    const feedback = submissionDetail.feedbackToUser || attemptDetail.feedbackToUser || tool.feedbackToUser;
    const feedbackHtml = feedback?.displayText || feedback?.rawText || "";
    const feedbackAttachments = mergeAttachments(
      directSubmissionFiles(feedback, `${item.title} feedback ${idx}`),
      extractAttachments(feedbackHtml, `${item.title} feedback ${idx}`)
    );
    if (feedbackHtml || feedbackAttachments.length) {
      const feedbackHtmlPath = path.join(attemptDir, "feedback.html");
      const feedbackTextPath = path.join(attemptDir, "feedback.txt");
      const feedbackText = stripHtml(feedbackHtml);
      const feedbackArtifact = {
        primaryPath: archivePath(feedbackHtmlPath),
        groupKey: archivePath(feedbackHtmlPath),
        logicalItemType: "assessment-attempt-feedback",
        logicalItemId: attempt.id,
        logicalItemTitle: item.title,
      };
      writeText(feedbackHtmlPath, htmlPage(`${item.title} - feedback ${idx}`, feedbackHtml), {
        ...feedbackArtifact,
        origin: "blackboard-content-export",
        role: "feedback-rendered",
        searchable: false,
      });
      writeText(feedbackTextPath, feedbackText, {
        ...feedbackArtifact,
        origin: "derived-search-text",
        role: "feedback-search-text",
      });
      const feedbackRecord = {
        text: feedbackText,
        htmlPath: path.relative(OUT_ROOT, feedbackHtmlPath),
        textPath: path.relative(OUT_ROOT, feedbackTextPath),
        files: [],
      };
      attemptRecord.feedback = feedbackRecord;
      feedbackRecord.files = await downloadFeedbackAttachments(
        feedbackAttachments,
        path.join(attemptDir, "feedback_files"),
        `${item.title} feedback ${idx}`,
        {
          title: item.title,
          contentId: item.id,
          columnId: column.id,
          attemptNumber: idx,
        }
      );
    }
  }
}

function deriveGradebookStatus(item) {
  if (item.calculationType !== "NON_CALCULATED") return "CALCULATED";

  const attempts = item.attempts || [];
  const latestAttempt = attempts[attempts.length - 1];
  const score = item.grade?.score;
  const submissionStatus = item.grade?.submissionStatus;
  const hasScore = score !== null && score !== undefined;

  if (["DRAFT_SAVED_STUDENT", "DRAFT_SAVED", "IN_PROGRESS"].includes(submissionStatus) || latestAttempt?.status === "IN_PROGRESS") {
    return score !== null && score !== undefined ? "DRAFT_AFTER_GRADED_SUBMISSION" : "DRAFT_SAVED";
  }
  if (["SUBMITTED", "NEEDS_GRADING"].includes(submissionStatus)) return "SUBMITTED_NOT_GRADED";
  if (submissionStatus === "GRADED" && hasScore) return "GRADED";
  if (submissionStatus === "UNOPENED") {
    const due = item.dueDate ? new Date(item.dueDate).getTime() : null;
    if (due && due < Date.now()) return "OVERDUE_UNOPENED";
    return due ? "UPCOMING" : "NOT_GRADED";
  }
  if (
    (!submissionStatus && item.grade?.status === "NEEDS_GRADING") ||
    (attempts.some((attempt) => ["COMPLETED", "NEEDS_GRADING"].includes(attempt.status)) && score === null)
  ) {
    return "SUBMITTED_NOT_GRADED";
  }
  if (hasScore) return "GRADED";

  const due = item.dueDate ? new Date(item.dueDate).getTime() : null;
  if (due && due < Date.now()) return "OVERDUE_UNOPENED";
  if (due) return "UPCOMING";
  return "NOT_GRADED";
}

function summarizePoints(items, includeCalculated) {
  const included = items.filter((item) => {
    if (!includeCalculated && item.calculationType !== "NON_CALCULATED") return false;
    return item.grade?.score !== null && item.grade?.score !== undefined && item.grade?.pointsPossible;
  });
  const earned = included.reduce((sum, item) => sum + item.grade.score, 0);
  const possible = included.reduce((sum, item) => sum + item.grade.pointsPossible, 0);
  return {
    earned: roundNumber(earned),
    possible: roundNumber(possible),
    percentage: possible ? roundNumber((earned / possible) * 100, 2) : null,
    itemCount: included.length,
  };
}

async function saveGradebook(me) {
  let columns;
  try {
    columns = await getAllPages(`/learn/api/v1/courses/${COURSE_ID}/gradebook/columns`);
  } catch (error) {
    manifest.errors.push({ label: "gradebook", error: error.message });
    return;
  }

  const assessmentsByColumn = new Map(
    manifest.assessments.filter((assessment) => assessment.columnId).map((assessment) => [assessment.columnId, assessment])
  );
  const items = [];
  for (const column of columns.sort((a, b) => (a.position || 0) - (b.position || 0))) {
    if (column.deleted || column.visibleInBook === false) continue;
    let rawGrade = null;
    try {
      rawGrade = await getColumnGrade(column.id, me.id);
    } catch (error) {
      manifest.errors.push({ label: column.columnName || column.id, error: `grade lookup: ${error.message}` });
    }

    const assessment = assessmentsByColumn.get(column.id);
    const item = {
      columnId: column.id,
      contentId: column.contentId || null,
      title: column.columnName || column.effectiveColumnName || column.id,
      effectiveTitle: column.effectiveColumnName || column.columnName || column.id,
      category: column.gradebookCategory?.title || null,
      dueDate: column.dueDate || assessment?.dueDate || null,
      possiblePoints: roundNumber(column.possible),
      multipleAttempts: finiteNumber(column.multipleAttempts),
      calculationType: column.calculationType || "NON_CALCULATED",
      isGroup: column.groupContent ?? assessment?.isGroup ?? false,
      position: finiteNumber(column.position),
      directory: assessment?.directory || null,
      grade: summarizeGrade(rawGrade, column.possible),
      attempts: (assessment?.attempts || []).map((attempt) => ({
        id: attempt.id,
        groupAttemptId: attempt.groupAttemptId,
        status: attempt.status,
        attemptDate: attempt.attemptDate,
      })),
    };
    item.status = deriveGradebookStatus(item);
    items.push(item);
  }

  const performanceToDate = summarizePoints(items, false);
  const displayColumn =
    items.find(
      (item) =>
        /^overall grade$/i.test(item.title || item.effectiveTitle || "") &&
        item.grade?.score !== null &&
        item.grade?.score !== undefined
    ) ||
    items.find(
      (item) =>
        /^total$/i.test(item.title || item.effectiveTitle || "") &&
        item.grade?.score !== null &&
        item.grade?.score !== undefined
    );
  const blackboardDisplay = displayColumn
    ? {
        earned: displayColumn.grade.score,
        possible: displayColumn.grade.pointsPossible,
        percentage: displayColumn.grade.percentage,
        itemCount: 1,
        columnId: displayColumn.columnId,
        title: displayColumn.title,
      }
    : summarizePoints(items, true);

  manifest.gradebook = {
    summary: {
      blackboardDisplay,
      performanceToDate,
    },
    items,
  };
  writeText(path.join(OUT_ROOT, "gradebook.json"), JSON.stringify(manifest.gradebook, null, 2), {
    origin: "blackboard-content-export",
    role: "gradebook-data",
  });
}

async function archivePendingQuizReviewsWithUi() {
  if (pendingQuizReviewFallbacks.length === 0) return;
  const requests = pendingQuizReviewFallbacks.flatMap((entry, index) =>
    entry.attemptRecord.quizReview || !entry.reviewUrl
      ? []
      : [{ id: index, url: entry.reviewUrl }]
  );
  if (requests.length) {
    try {
      const results = await quizReviewBrowserGateway.fetchAll(requests);
      for (const result of results) {
        const entry = pendingQuizReviewFallbacks[result.id];
        if (result.error) {
          entry.browserError = result.error;
          continue;
        }
        try {
          await archiveQuizReviewHtml(
            entry,
            result.html,
            result.finalUrl,
            "authenticated Playwright fallback"
          );
        } catch (error) {
          entry.browserError = error.message;
        }
      }
    } catch (error) {
      for (const entry of pendingQuizReviewFallbacks) {
        if (!entry.attemptRecord.quizReview) entry.browserError ||= error.message;
      }
    }
  }

  for (const entry of pendingQuizReviewFallbacks) {
    entry.attemptRecord.quizReviewDiagnostics = {
      httpError: entry.httpError,
      browserError: entry.browserError,
      attemptDetailApiError: entry.apiError,
    };
    if (entry.attemptRecord.quizReview || entry.attemptRecord.apiQuizReview) {
      delete entry.attemptRecord.detailUnavailable;
    }
  }
}

function finalizeQuizReviews() {
  const records = [];
  const failed = [];
  for (const assessment of manifest.assessments) {
    for (const attempt of assessment.attempts) {
      if (!attempt.quizReviewExpected) continue;
      const record = {
        assessment: assessment.title,
        contentId: assessment.contentId,
        columnId: assessment.columnId,
        attemptId: attempt.id,
        classicReview: attempt.quizReview || null,
        learnApiReview: attempt.apiQuizReview || null,
      };
      records.push(record);
      if (record.classicReview || record.learnApiReview) continue;
      const failure = {
        assessment: assessment.title,
        attemptId: attempt.id,
        diagnostics: attempt.quizReviewDiagnostics || attempt.attemptDetailApiError || null,
      };
      failed.push(failure);
      attempt.detailUnavailable = {
        reason: "No student-visible quiz question payload could be archived",
        diagnostics: failure.diagnostics,
      };
    }
  }
  manifest.quizReviews = {
    expected: records.length,
    archived: records.length - failed.length,
    classicHttp: records.filter(
      (record) => record.classicReview?.discoveryMethod === "authenticated Blackboard HTML"
    ).length,
    classicBrowser: records.filter(
      (record) => record.classicReview?.discoveryMethod === "authenticated Playwright fallback"
    ).length,
    learnApiPayloads: records.filter((record) => record.learnApiReview).length,
    failed,
    records,
    complete: failed.length === 0,
  };
}

function fallbackFeedbackPath(entry, reservedPaths = null) {
  const preferred = preferredPath(entry.dir, entry.attachment.fileName);
  if (!fs.existsSync(preferred) && !reservedPaths?.has(preferred)) {
    reservedPaths?.add(preferred);
    return preferred;
  }
  const expected = finiteNumber(entry.attachment.fileSize);
  if (
    !reservedPaths?.has(preferred) &&
    expected &&
    fs.existsSync(preferred) &&
    fs.statSync(preferred).size === expected
  ) {
    reservedPaths?.add(preferred);
    return preferred;
  }
  const unique = uniquePath(entry.dir, entry.attachment.fileName, reservedPaths);
  reservedPaths?.add(unique);
  return unique;
}

async function downloadPendingFeedbackWithUi() {
  if (pendingFeedbackDownloads.length === 0) return;
  const reservedPaths = new Set();
  const requests = pendingFeedbackDownloads.map((entry, index) => ({
    id: index,
    url: buildStudentFeedbackUrl({
      base: BASE,
      courseId: COURSE_ID,
      columnId: entry.columnId,
      contentId: entry.contentId,
    }),
    attemptNumber: entry.attemptNumber,
    fileName: entry.attachment.fileName,
    destination: fallbackFeedbackPath(entry, reservedPaths),
  }));

  let results;
  try {
    results = await feedbackDownloadBrowserGateway.downloadAll(requests);
  } catch (error) {
    for (const entry of pendingFeedbackDownloads) {
      manifest.errors.push({
        label: entry.label,
        fileName: entry.attachment.fileName,
        url: entry.attachment.url,
        error: `${entry.directError}; UI fallback unavailable: ${error.message}`,
      });
    }
    return;
  }

  for (const result of results) {
    const entry = pendingFeedbackDownloads[result.id];
    const outPath = requests[result.id].destination;
    try {
      if (result.error) throw new Error(result.error);
      const size = fs.statSync(outPath).size;
      const expected = finiteNumber(entry.attachment.fileSize);
      if (expected && size !== expected) {
        throw new Error(`Downloaded ${size} bytes; Blackboard reported ${expected} bytes`);
      }

      const relativePath = path.relative(OUT_ROOT, outPath);
      const hash = sha256File(outPath);
      entry.outputPaths.push(relativePath);
      manifest.downloads.push({
        label: entry.label,
        fileName: path.basename(outPath),
        path: relativePath,
        size,
        expectedSize: expected,
        contentType: entry.attachment.mimeType || null,
        sourceUrl: result.downloadUrl,
        sha256: hash,
        integrityVerified: true,
        downloadMethod: "Blackboard UI fallback",
      });
      manifest.transfer.networkFiles += 1;
      manifest.transfer.networkBytes += size;
      emitTransfer("downloaded-ui", outPath, size, entry.label);
      console.log(`downloaded via UI ${relativePath} (${size} bytes)`);
    } catch (error) {
      manifest.errors.push({
        label: entry.label,
        fileName: entry.attachment.fileName,
        url: entry.attachment.url,
        error: `${entry.directError}; UI fallback failed: ${error.message}`,
      });
      console.error(`FAILED UI fallback ${entry.label}: ${error.message}`);
    }
  }
}

async function archiveClassicAttemptFilesWithUi() {
  if (pendingClassicAttemptFiles.length === 0) return;
  const requests = pendingClassicAttemptFiles.map((entry, index) => ({
    id: index,
    url: buildClassicSubmissionHistoryUrl({
      base: BASE,
      courseId: COURSE_ID,
      columnId: entry.columnId,
      attemptIndex: entry.attemptIndex,
      attemptId: entry.attemptId,
    }),
    attemptId: entry.attemptId,
  }));

  let results;
  try {
    results = await classicSubmissionBrowserGateway.discoverAll(requests, {
      blockHeavyResources: DOWNLOAD_MODE === "placeholder",
    });
  } catch (error) {
    manifest.errors.push({ label: "Classic submission file inventory", error: error.message });
    return;
  }

  for (const result of results) {
    const entry = pendingClassicAttemptFiles[result.id];
    if (result.error) {
      manifest.errors.push({
        label: `${entry.assessmentTitle} ${entry.attemptId}`,
        error: `Classic submission file inventory: ${result.error}`,
      });
      continue;
    }
    if (result.files.length === 0) continue;

    const attachments = result.files.map((file) => ({
      fileName: file.fileName,
      url: file.url,
      fileId: file.fileId,
      fileSize: result.files.length === 1 ? entry.attemptRecord.submissionTotalSize : null,
      mimeType: "",
      source: `${entry.assessmentTitle} Classic submission ${entry.attemptIndex}`,
    }));
    writeText(
      path.join(entry.attemptDir, "submitted_files.json"),
      `${JSON.stringify(attachments, null, 2)}\n`,
      {
        origin: "fetcher-record",
        role: "submitted-files",
        searchable: false,
        logicalItemType: "assessment-attempt",
        logicalItemId: entry.attemptId,
        logicalItemTitle: entry.assessmentTitle,
      }
    );
    for (const attachment of attachments) {
      const downloaded = await downloadFile(
        attachment,
        path.join(entry.attemptDir, "files"),
        `${entry.assessmentTitle} submission ${entry.attemptIndex}: ${attachment.fileName}`,
        { allowSizeMismatch: true }
      );
      if (downloaded) entry.attemptRecord.files.push(path.relative(OUT_ROOT, downloaded));
    }

    const annotationAttachments =
      DOWNLOAD_MODE === "placeholder"
        ? attachments.filter((attachment) => isAnnotatableSubmission(attachment.fileName))
        : result.annotateUrl && attachments.length === 1
          ? attachments
          : [];
    for (const attachment of annotationAttachments) {
      pendingAnnotationChecks.push({
        assessmentTitle: entry.assessmentTitle,
        attemptId: entry.attemptId,
        columnId: entry.columnId,
        groupAttemptId: null,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType || null,
        viewUrl: result.annotateUrl,
        classicHistoryUrl: requests[result.id].url,
        attemptDir: entry.attemptDir,
        attemptRecord: entry.attemptRecord,
      });
    }
  }
}

function formatHkt(value) {
  if (!value) return "No due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatPoints(value) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  return Number.isInteger(number) ? String(number) : String(roundNumber(number, 2));
}

function currentCourseName() {
  return manifest.course?.displayName || manifest.course?.name || COURSE_NAME_HINT || COURSE_ID;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function localLink(label, relativePath) {
  if (!relativePath) return label;
  return `[${label}](<${String(relativePath).replace(/\\/g, "/")}>)`;
}

function statusLabel(status) {
  return (
    {
      CALCULATED: "Calculated total",
      DRAFT_AFTER_GRADED_SUBMISSION: "Draft saved after an earlier graded submission",
      DRAFT_SAVED: "Draft saved",
      GRADED: "Graded",
      NOT_GRADED: "Not graded",
      OVERDUE_UNOPENED: "Overdue and unopened",
      SUBMITTED_NOT_GRADED: "Submitted, awaiting grade",
      UPCOMING: "Unopened",
    }[status] || status
  );
}

function saveCurrentStatus() {
  if (!manifest.gradebook) return;
  const items = manifest.gradebook.items;
  const assessmentsByColumn = new Map(
    manifest.assessments.filter((assessment) => assessment.columnId).map((assessment) => [assessment.columnId, assessment])
  );
  const graded = items.filter(
    (item) => item.calculationType === "NON_CALCULATED" && item.grade?.score !== null && item.grade?.score !== undefined
  );
  const pending = items
    .filter((item) => ["UPCOMING", "OVERDUE_UNOPENED"].includes(item.status) && item.dueDate && item.contentId)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const waiting = items.filter((item) => item.status === "SUBMITTED_NOT_GRADED");
  const attention = items.filter((item) => ["DRAFT_SAVED", "DRAFT_AFTER_GRADED_SUBMISSION"].includes(item.status));
  const performance = manifest.gradebook.summary.performanceToDate;
  const blackboard = manifest.gradebook.summary.blackboardDisplay;
  const submissionFileLines = [];
  for (const assessment of manifest.assessments) {
    for (let index = 0; index < assessment.attempts.length; index += 1) {
      const attempt = assessment.attempts[index];
      if (!attempt.files?.length) continue;
      const details = [attempt.groupName, attempt.attemptDate ? `${formatHkt(attempt.attemptDate)} HKT` : null]
        .filter(Boolean)
        .join(", ");
      const files = attempt.files.map((file) => localLink(path.basename(file), file));
      submissionFileLines.push(
        `- ${assessment.title}, attempt ${index + 1}${details ? ` (${details})` : ""}: ${files.join(", ")}.`
      );
    }
  }

  const lines = [
    `# ${currentCourseName()} Current Status`,
    "",
    `Refreshed from Blackboard: ${formatHkt(manifest.generatedAt)} HKT`,
    "",
    "## Current Grade",
    "",
    `Blackboard display: ${formatPoints(blackboard.earned)} / ${formatPoints(blackboard.possible)} (${formatPoints(
      blackboard.percentage
    )}%).`,
    `Performance to date excluding calculated columns: ${formatPoints(performance.earned)} / ${formatPoints(
      performance.possible
    )} (${formatPoints(performance.percentage)}%).`,
    "",
    "The Blackboard display includes calculated columns such as Total. The second figure uses only directly graded items.",
    "",
    "| Graded item | Score | Status |",
    "| --- | ---: | --- |",
    ...graded.map(
      (item) =>
        `| ${markdownCell(item.title)} | ${formatPoints(item.grade.score)} / ${formatPoints(item.grade.pointsPossible)} | ${markdownCell(
          statusLabel(item.status)
        )} |`
    ),
    "",
    "## Pending Hand-ins",
    "",
    ...(pending.length
      ? [
          "| Due (HKT) | Item | Points | Status | Local instructions |",
          "| --- | --- | ---: | --- | --- |",
          ...pending.map((item) => {
            const assessment = assessmentsByColumn.get(item.columnId);
            const instructionPath = assessment ? path.join(assessment.directory, "instructions.txt") : null;
            const ownership = item.isGroup ? "Team" : "Individual";
            return `| ${formatHkt(item.dueDate)} | ${markdownCell(item.title)} (${ownership}) | ${formatPoints(
              item.possiblePoints
            )} | ${markdownCell(statusLabel(item.status))} | ${localLink("instructions", instructionPath)} |`;
          }),
        ]
      : ["- None"]),
    "",
    "## Submitted, Awaiting Grades",
    "",
    ...(waiting.length
      ? waiting.map((item) => `- ${item.title}: submitted, not graded (${formatPoints(item.possiblePoints)} points).`)
      : ["- None"]),
    "",
    "## Items Requiring Attention",
    "",
    ...(attention.length
      ? attention.map((item) => {
          const score = item.grade?.score !== null && item.grade?.score !== undefined
            ? ` Current grade: ${formatPoints(item.grade.score)} / ${formatPoints(item.grade.pointsPossible)}.`
            : "";
          return `- ${item.title}: ${statusLabel(item.status)}.${score}`;
        })
      : ["- None"]),
    "",
    "## Submitted Files",
    "",
    ...(submissionFileLines.length ? submissionFileLines : ["- None"]),
    "",
    "## Assignment Feedback",
    "",
  ];

  const feedbackLines = [];
  for (const assessment of manifest.assessments) {
    for (let index = 0; index < assessment.attempts.length; index += 1) {
      const attempt = assessment.attempts[index];
      if (!attempt.feedback) continue;
      const text = attempt.feedback.text.replace(/\s+/g, " ").trim();
      const excerpt = text.length > 240 ? `${text.slice(0, 237)}...` : text;
      const files = attempt.feedback.files.map((file) => localLink(path.basename(file), file));
      feedbackLines.push(
        `- ${assessment.title}, attempt ${index + 1}: ${excerpt || "Feedback provided."}${
          files.length ? ` Files: ${files.join(", ")}.` : ""
        }`
      );
    }
  }
  lines.push(...(feedbackLines.length ? feedbackLines : ["- None"]), "", "## Latest Announcements", "");
  lines.push(
    ...manifest.announcements.slice(0, 3).map((announcement) => {
      const announcementPath = path.join(announcement.directory, "announcement.txt");
      return `- ${formatHkt(announcement.postedAt)}: ${localLink(announcement.title, announcementPath)}`;
    }),
    "",
    "## Fetch Coverage",
    "",
    `- Visible content items: ${manifest.coverage?.content.discovered || 0}.`,
    `- Course files covered: ${manifest.coverage?.courseFiles.covered || 0} / ${manifest.coverage?.courseFiles.expected || 0} (${manifest.coverage?.courseFiles.downloaded || 0} downloaded, ${manifest.coverage?.courseFiles.placeholders || 0} placeholders).`,
    `- Announcement attachments covered: ${manifest.coverage?.announcements?.covered || 0} / ${manifest.coverage?.announcements?.embeddedAttachmentExpected || 0} (${manifest.coverage?.announcements?.downloaded || 0} downloaded, ${manifest.coverage?.announcements?.placeholders || 0} placeholders).`,
    `- Assessments: ${manifest.coverage?.assessments.processed || 0} / ${manifest.coverage?.assessments.expected || 0}.`,
    `- Completed quiz reviews: ${manifest.quizReviews?.archived ?? 0} / ${manifest.quizReviews?.expected ?? 0}.`,
    `- Calendar: ${manifest.calendar?.count ?? 0}; discussions: ${manifest.discussions?.count ?? 0}; messages: ${manifest.messages?.count ?? 0}.`,
    `- Accessible groups: ${manifest.groups?.accessibleGroupCount ?? 0}; achievements: ${manifest.achievements?.count ?? 0}.`,
    `- Annotate files checked: ${manifest.annotations?.archived ?? 0} archived and ${manifest.annotations?.placeholders ?? 0} placeholders / ${manifest.annotations?.expected ?? 0}; external links: ${manifest.externalLinks?.archived ?? 0} snapshots and ${manifest.externalLinks?.placeholders ?? 0} placeholders / ${manifest.externalLinks?.expected ?? 0}.`,
    `- Audit: ${manifest.coverage?.complete ? "complete within the defined archive scope" : "incomplete"}; ${manifest.warnings.length} warning(s), ${manifest.errors.length} error(s).`,
    "",
    `Structured gradebook data: ${localLink("gradebook.json", "gradebook.json")}`,
    ""
  );
  writeText(path.join(OUT_ROOT, "CURRENT_STATUS.md"), lines.join("\n"), {
    origin: "fetcher-record",
    role: "status-summary",
    searchable: false,
  });
}

function auditCoverage() {
  const handlerCounts = {};
  for (const item of manifest.contents) {
    const handler = item.handler || "unknown";
    handlerCounts[handler] = (handlerCounts[handler] || 0) + 1;
  }

  const contentIds = new Set();
  const duplicateContentIds = [];
  for (const item of manifest.contents) {
    if (!item.id) continue;
    if (contentIds.has(item.id)) duplicateContentIds.push(item.id);
    contentIds.add(item.id);
  }

  const unknownHandlers = manifest.contents.filter((item) => !item.knownHandler);
  const courseFileItems = manifest.contents.filter((item) => item.handler === "resource/x-bb-file");
  const missingCourseFiles = courseFileItems.filter((item) => item.files.length === 0);
  const downloadsByPath = new Map(manifest.downloads.filter((item) => item.path).map((item) => [item.path, item]));
  const placeholderCourseFiles = courseFileItems.filter((item) =>
    item.files.some((file) => downloadsByPath.get(file)?.placeholder === true)
  );
  const contentAttachmentItems = manifest.contents.flatMap((content) =>
    (content.attachments || []).map((attachment) => ({ attachment, content }))
  );
  const coveredContentAttachments = contentAttachmentItems.filter(
    ({ attachment }) => attachment.covered === true
  );
  const missingContentAttachments = contentAttachmentItems.filter(
    ({ attachment }) => attachment.covered !== true
  );
  const placeholderContentAttachments = coveredContentAttachments.filter(
    ({ attachment }) => attachment.placeholder === true
  );
  const attachmentDiscoveryFailures = manifest.contents.filter(
    (item) => item.attachmentDiscovery?.attempted && item.attachmentDiscovery?.complete !== true
  );
  const announcementAttachmentItems = manifest.announcements.flatMap((announcement) =>
    (announcement.attachments || []).map((attachment) => ({ announcement, attachment }))
  );
  const coveredAnnouncementAttachments = announcementAttachmentItems.filter(
    ({ attachment }) => attachment.covered === true
  );
  const missingAnnouncementAttachments = announcementAttachmentItems.filter(
    ({ attachment }) => attachment.covered !== true
  );
  const placeholderAnnouncementAttachments = coveredAnnouncementAttachments.filter(
    ({ attachment }) => attachment.placeholder === true
  );
  const ltiItems = manifest.contents.filter((item) => isLtiHandler(item.handler));
  const ltiByContentId = new Map(
    manifest.ltiResources.map((item) => [item.contentId, item])
  );
  const incompleteLti = ltiItems.filter((item) => ltiByContentId.get(item.id)?.complete !== true);
  const assessmentItems = manifest.contents.filter((item) =>
    new Set(["resource/x-bb-asmt-test-link", "resource/x-bb-assignment"]).has(item.handler) ||
    isLtiHandler(item.handler)
  );
  const assessmentContentIds = new Set(manifest.assessments.map((item) => item.contentId));
  const missingAssessments = assessmentItems.filter((item) => !assessmentContentIds.has(item.id));

  const missingDownloadPaths = [];
  const sizeMismatches = [];
  const hashMismatches = [];
  let auditHashReads = 0;
  for (const download of manifest.downloads) {
    const localPath = path.resolve(OUT_ROOT, download.path || "");
    const rootPrefix = `${path.resolve(OUT_ROOT)}${path.sep}`;
    if (!download.path || (localPath !== path.resolve(OUT_ROOT) && !localPath.startsWith(rootPrefix)) || !fs.existsSync(localPath)) {
      missingDownloadPaths.push(download.path || download.fileName || download.label);
      continue;
    }

    const size = fs.statSync(localPath).size;
    if (finiteNumber(download.size) !== null && size !== finiteNumber(download.size)) {
      sizeMismatches.push({ path: download.path, expected: finiteNumber(download.size), actual: size });
    }
    if (finiteNumber(download.expectedSize) !== null && size !== finiteNumber(download.expectedSize)) {
      sizeMismatches.push({ path: download.path, expected: finiteNumber(download.expectedSize), actual: size });
    }

    if (!download.integrityVerified || !download.sha256) {
      const hash = sha256File(localPath);
      auditHashReads += 1;
      if (download.sha256 && download.sha256 !== hash) hashMismatches.push(download.path);
      download.sha256 = hash;
      download.integrityVerified = true;
    }
  }

  const assessmentByColumn = new Map(
    manifest.assessments.filter((item) => item.columnId).map((item) => [item.columnId, item])
  );
  const submissionWithoutAttempt = [];
  const submissionPayloadMissing = [];
  const advertisedFeedbackMissing = [];
  const embeddedRubricsNotArchived = [];
  for (const item of manifest.gradebook?.items || []) {
    const assessment = assessmentByColumn.get(item.columnId);
    if (!assessment) continue;
    if (["SUBMITTED", "DRAFT_SAVED_STUDENT", "DRAFT_SAVED"].includes(item.grade?.submissionStatus) && assessment.attempts.length === 0) {
      submissionWithoutAttempt.push({
        title: item.title,
        columnId: item.columnId,
        submissionStatus: item.grade.submissionStatus,
      });
    }
    if (item.grade?.hasAttemptOrGradeFeedback === true && !assessment.attempts.some((attempt) => attempt.feedback)) {
      advertisedFeedbackMissing.push({ title: item.title, columnId: item.columnId });
    }
    if (item.grade?.hasRubricAssociations === true) {
      embeddedRubricsNotArchived.push({ title: item.title, columnId: item.columnId });
    }
  }
  for (const assessment of manifest.assessments) {
    for (const attempt of assessment.attempts || []) {
      if (finiteNumber(attempt.submissionTotalSize) > 0 && !(attempt.files || []).length) {
        submissionPayloadMissing.push({
          title: assessment.title,
          attemptId: attempt.id,
          reportedBytes: finiteNumber(attempt.submissionTotalSize),
        });
      }
    }
  }

  const gradebookOnlyContent = (manifest.gradebook?.items || [])
    .filter((item) => item.contentId && !contentIds.has(item.contentId))
    .map((item) => ({ title: item.title, contentId: item.contentId, columnId: item.columnId }));
  const previousContentIds = new Set((previousManifest?.contents || []).map((item) => item.id).filter(Boolean));
  const noLongerVisible = [...previousContentIds].filter((id) => !contentIds.has(id));
  const failedQuizReviews = manifest.quizReviews?.failed || [];

  const coverageFailures = [
    ...duplicateContentIds.map((id) => `Duplicate content ID ${id}`),
    ...missingCourseFiles.map((item) => `Course file was not downloaded: ${item.path}`),
    ...attachmentDiscoveryFailures.map(
      (item) => `Content attachment discovery failed: ${item.path}`
    ),
    ...missingContentAttachments.map(
      ({ attachment, content }) =>
        `Content attachment was not archived: ${content.path} / ${attachment.fileName}`
    ),
    ...missingAnnouncementAttachments.map(
      ({ announcement, attachment }) =>
        `Announcement attachment was not archived: ${announcement.title} / ${attachment.fileName}`
    ),
    ...missingAssessments.map((item) => `Assessment was not processed: ${item.path}`),
    ...incompleteLti.map((item) => {
      const lti = ltiByContentId.get(item.id);
      return `LTI content was not fully archived: ${item.path} (${lti?.status || "not processed"})`;
    }),
    ...missingDownloadPaths.map((item) => `Manifest download is missing on disk: ${item}`),
    ...sizeMismatches.map((item) => `File size mismatch: ${item.path} (${item.actual} vs ${item.expected})`),
    ...hashMismatches.map((item) => `File hash mismatch: ${item}`),
    ...submissionWithoutAttempt.map(
      (item) => `Blackboard says ${item.submissionStatus}, but no attempt was returned: ${item.title}`
    ),
    ...submissionPayloadMissing.map(
      (item) => `Attempt ${item.attemptId} reports ${item.reportedBytes} submitted bytes, but no file was archived: ${item.title}`
    ),
    ...advertisedFeedbackMissing.map((item) => `Blackboard reports feedback that was not archived: ${item.title}`),
    ...failedQuizReviews.map(
      (item) => `Completed quiz review was not archived: ${item.assessment} (${item.attemptId})`
    ),
    ...(manifest.extraArchive?.complete === true ? [] : ["One or more additional Blackboard archive areas are incomplete"]),
  ];
  for (const failure of coverageFailures) manifest.errors.push({ label: "coverage audit", error: failure });
  for (const rubric of embeddedRubricsNotArchived) {
    manifest.warnings.push({
      label: rubric.title,
      warning: "An embedded Blackboard rubric exists but is not yet archived by this script",
    });
  }

  manifest.coverage = {
    scope: COVERAGE_SCOPE,
    exclusions: COVERAGE_EXCLUSIONS,
    complete:
      coverageFailures.length === 0 &&
      unknownHandlers.length === 0 &&
      embeddedRubricsNotArchived.length === 0 &&
      gradebookOverviewLoaded &&
      manifest.extraArchive?.complete === true &&
      manifest.errors.length === 0,
    content: {
      discovered: manifest.contents.length,
      knownHandlers: manifest.contents.length - unknownHandlers.length,
      unknownHandlers: unknownHandlers.map((item) => ({ id: item.id, title: item.title, handler: item.handler })),
      byHandler: handlerCounts,
      noLongerVisible,
    },
    courseFiles: {
      expected: courseFileItems.length + contentAttachmentItems.length,
      covered:
        courseFileItems.length -
        missingCourseFiles.length +
        coveredContentAttachments.length,
      downloaded:
        courseFileItems.length -
        missingCourseFiles.length -
        placeholderCourseFiles.length +
        coveredContentAttachments.length -
        placeholderContentAttachments.length,
      placeholders:
        placeholderCourseFiles.length + placeholderContentAttachments.length,
      standaloneExpected: courseFileItems.length,
      embeddedAttachmentExpected: contentAttachmentItems.length,
      attachmentDiscoveryFailures: attachmentDiscoveryFailures.map((item) => ({
        id: item.id,
        path: item.path,
        error: item.attachmentDiscovery.error || null,
      })),
    },
    announcements: {
      discovered: manifest.announcements.length,
      embeddedAttachmentExpected: announcementAttachmentItems.length,
      covered: coveredAnnouncementAttachments.length,
      downloaded:
        coveredAnnouncementAttachments.length - placeholderAnnouncementAttachments.length,
      placeholders: placeholderAnnouncementAttachments.length,
      missing: missingAnnouncementAttachments.map(({ announcement, attachment }) => ({
        announcementId: announcement.id,
        title: announcement.title,
        fileName: attachment.fileName,
      })),
    },
    lti: {
      expected: ltiItems.length,
      archived: ltiItems.length - incompleteLti.length,
      failed: incompleteLti.map((item) => {
        const lti = ltiByContentId.get(item.id);
        return {
          contentId: item.id,
          title: item.title,
          provider: lti?.provider || null,
          providerHost: lti?.providerHost || null,
          status: lti?.status || "not-processed",
          error: lti?.error || null,
        };
      }),
      records: manifest.ltiResources.map((item) => ({
        contentId: item.contentId,
        title: item.title,
        provider: item.provider,
        providerHost: item.providerHost,
        status: item.status,
        complete: item.complete,
        resourceCount: item.resources.length,
      })),
    },
    assessments: {
      expected: assessmentItems.length,
      processed: manifest.assessments.length,
      submittedOrDraftWithoutAttempt: submissionWithoutAttempt,
      submittedPayloadMissing: submissionPayloadMissing,
      advertisedFeedbackMissing,
      embeddedRubricsNotArchived,
    },
    gradebook: {
      items: manifest.gradebook?.items.length || 0,
      overviewItems: gradebookOverviewCount,
      contentNotVisibleInCourseTree: gradebookOnlyContent,
    },
    quizReviews: manifest.quizReviews,
    downloads: {
      records: manifest.downloads.length,
      placeholders: manifest.downloads.filter((item) => item.placeholder === true).length,
      unresolved: manifest.downloads.filter((item) => item.unresolved === true).length,
      auditHashReads,
      missingPaths: missingDownloadPaths,
      sizeMismatches,
      hashMismatches,
    },
    additionalAreas: manifest.extraArchive,
  };
}

async function processItem(item, ancestors, me) {
  const apiAttachmentPromise = discoverContentApiAttachments(item);
  let detail = item;
  let detailLoaded = true;
  const compactExpand = "assignedGroups,selfEnrollmentGroups.group,gradebookCategory";
  const handlerSkipsAlignments =
    item.contentHandler === "resource/x-bb-module-page" ||
    isLtiHandler(item.contentHandler);
  const primaryExpand = handlerSkipsAlignments ? compactExpand : `${compactExpand},alignedGoals`;
  try {
    detail = await bbJson(`/learn/api/v1/courses/${COURSE_ID}/contents/${item.id}?expand=${primaryExpand}&includeInActivityTracking=false`);
  } catch (error) {
    if (!handlerSkipsAlignments && /alignment service/i.test(error.message)) {
      try {
        detail = await bbJson(`/learn/api/v1/courses/${COURSE_ID}/contents/${item.id}?expand=${compactExpand}&includeInActivityTracking=false`);
      } catch (fallbackError) {
        detailLoaded = false;
        manifest.errors.push({
          label: item.title || item.id,
          error: `content detail fallback: ${fallbackError.message}`,
        });
      }
    } else {
      detailLoaded = false;
      manifest.errors.push({ label: item.title || item.id, error: `content detail: ${error.message}` });
    }
  }

  const title = detail.title || item.title || item.id;
  emitProgress("item", { phase: "content", label: [...ancestors, title].join(" / ") });
  const handler = detail.contentHandler || item.contentHandler || null;
  const attachmentDiscovery = await apiAttachmentPromise;
  if (!attachmentDiscovery.complete) {
    manifest.errors.push({
      label: [...ancestors, title].join(" / "),
      error: `content attachment list: ${attachmentDiscovery.error}`,
    });
  }
  const inlineAttachments = inlineContentAttachments(detail);
  const contentAttachments = mergeAttachments(
    inlineAttachments,
    attachmentDiscovery.attachments
  ).map(stabilizeAttachment);
  const record = {
    id: detail.id || item.id || null,
    parentId: detail.parentId || item.parentId || null,
    title,
    path: [...ancestors, title].join(" / "),
    handler,
    position: finiteNumber(detail.position ?? item.position),
    visibility: detail.visibility || item.visibility || null,
    state: detail.state || item.state || null,
    modifiedDate: detail.modifiedDate || item.modifiedDate || null,
    detailLoaded,
    knownHandler: isKnownHandler(handler),
    container: isContainer(detail),
    directory: path.relative(
      OUT_ROOT,
      handler === "resource/x-bb-file"
        ? dirForItem(ancestors, title, ancestors.length === 0)
        : dirForItem(ancestors, title, true)
    ),
    files: [],
    attachmentDiscovery: {
      attempted: attachmentDiscovery.attempted,
      complete: attachmentDiscovery.complete,
      supported: attachmentDiscovery.supported,
      endpoint: attachmentDiscovery.endpoint,
      apiCount: attachmentDiscovery.attachments.length,
      inlineCount: inlineAttachments.length,
      total: contentAttachments.length,
      ...(attachmentDiscovery.error ? { error: attachmentDiscovery.error } : {}),
    },
    attachments: contentAttachments.map(contentAttachmentRecord),
  };
  manifest.contents.push(record);
  if (record.container) ensureDir(path.join(OUT_ROOT, record.directory));
  if (!record.knownHandler) {
    manifest.warnings.push({
      label: record.path,
      warning: `Unknown content handler ${handler || "(missing)"}; probed for child content`,
    });
  }

  const beforeDownloads = manifest.downloads.length;
  await saveCourseFile(detail, ancestors);
  await saveDocument(detail, ancestors, contentAttachments);
  await saveExternalLink(detail, ancestors);
  await saveLtiContent(detail, ancestors, me);
  await saveBodyAttachments(detail, ancestors, contentAttachments);
  await saveAssessment(detail, ancestors, me, contentAttachments);
  const itemDownloads = manifest.downloads.slice(beforeDownloads);
  record.files = itemDownloads.map((download) => download.path);
  associateContentAttachmentDownloads(record, itemDownloads);

  let children = null;
  if (record.container || !record.knownHandler) {
    try {
      children = await getAllPages(`/learn/api/v1/courses/${COURSE_ID}/contents/${detail.id}/children?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory&includeInActivityTracking=true`);
    } catch (error) {
      if (record.container || !/400|404/.test(error.message)) {
        manifest.errors.push({ label: title, error: `child list: ${error.message}` });
      }
      children = [];
    }
  }
  if (children?.length && !record.container) {
    record.container = true;
    ensureDir(path.join(OUT_ROOT, record.directory));
  }
  for (const child of children || []) {
    await processItem(child, ancestors.concat(title), me);
  }
}

async function main() {
  emitProgress("start", { courseId: COURSE_ID, downloadMode: DOWNLOAD_MODE });
  ensureDir(OUT_ROOT);
  ensureDir(path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.courseContents));
  let me = null;
  await runPhase("bootstrap", async () => {
    const course = await bbJson(`/learn/api/v1/courses/${COURSE_ID}`);
    manifest.course = {
      id: course.id || COURSE_ID,
      courseId: course.courseId || course.displayId || null,
      displayName: course.displayName || course.name || COURSE_NAME_HINT || COURSE_ID,
      name: course.name || course.displayName || COURSE_NAME_HINT || COURSE_ID,
      ultraStatus: course.ultraStatus || null,
      isAvailable: course.isAvailable ?? null,
      externalAccessUrl: course.externalAccessUrl || null,
      term: course.term
        ? {
            id: course.term.id || null,
            name: course.term.name || COURSE_TERM_HINT || null,
            startDate: course.term.startDate || null,
            endDate: course.term.endDate || null,
          }
        : COURSE_TERM_HINT
          ? { id: null, name: COURSE_TERM_HINT, startDate: null, endDate: null }
          : null,
    };
    me = await bbJson("/learn/api/v1/users/me");
    try {
      gradebookOverviewCount = await primeGradeCache(me.id);
      gradebookOverviewLoaded = true;
    } catch (error) {
      manifest.warnings.push({
        label: "gradebook overview",
        warning: `Falling back to per-column grades: ${error.message}`,
      });
    }
  });

  await runPhase("announcements", () => saveAnnouncements());
  await runPhase("content", async () => {
    const rootChildren = await getAllPages(
      `/learn/api/v1/courses/${COURSE_ID}/contents/ROOT/children?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory&includeInActivityTracking=true`
    );
    for (const item of rootChildren) await processItem(item, [], me);
  });
  await runPhase("quizReviewFallbacks", async () => {
    await archivePendingQuizReviewsWithUi();
    finalizeQuizReviews();
  });
  await runPhase("gradebook", () => saveGradebook(me));
  await runPhase("classicSubmissions", () => archiveClassicAttemptFilesWithUi());
  await runPhase("feedbackDownloads", () => downloadPendingFeedbackWithUi());
  await runPhase("additionalAreas", () =>
    archiveBlackboardExtras({
      COURSE_ID,
      BASE,
      OUT_ROOT,
      manifest,
      bbJson,
      getAllPages,
      externalLinks: pendingExternalLinks,
      annotationChecks: pendingAnnotationChecks,
      downloadMode: DOWNLOAD_MODE,
      uiDataGateway: blackboardExtrasBrowserGateway,
    })
  );
  await runPhase("coverageAudit", async () => auditCoverage());
  await runPhase("status", async () => saveCurrentStatus());
  manifest.timings.totalMs = Math.round(performance.now() - fetchStartedAt);

  recordManifestArtifact(manifest, archivePath(MANIFEST_FILE), {
    origin: "fetcher-record",
    role: "manifest",
    searchable: false,
  });
  recordManifestArtifact(manifest, "README.md", {
    origin: "fetcher-record",
    role: "archive-summary",
    searchable: false,
  });
  writeText(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  fs.rmSync(path.join(OUT_ROOT, "manifest.failed.json"), { force: true });
  const managedFileCount = new Set(manifest.downloads.map((download) => download.path).filter(Boolean)).size;
  const summary = [
    `# Blackboard Fetch: ${currentCourseName()}`,
    "",
    `Generated: ${manifest.generatedAt}`,
    `Course ID: ${COURSE_ID}`,
    `Course view: ${manifest.course?.ultraStatus || "unknown"}`,
    `Term: ${manifest.course?.term?.name || COURSE_TERM_HINT || "unknown"}`,
    `Download mode: ${DOWNLOAD_MODE}`,
    `Attachment concurrency: ${ATTACHMENT_CONCURRENCY}`,
    `Total fetch time: ${(manifest.timings.totalMs / 1000).toFixed(2)} seconds`,
    `Network downloads: ${manifest.transfer.networkFiles} file(s), ${manifest.transfer.networkBytes} bytes`,
    `Validated cache reuse: ${manifest.transfer.reusedFiles} file(s), ${manifest.transfer.reusedBytes} bytes`,
    `Download records: ${manifest.downloads.length}`,
    `Binary placeholders: ${manifest.downloads.filter((item) => item.placeholder).length}`,
    `Unresolved attachments: ${manifest.downloads.filter((item) => item.unresolved).length}`,
    `Managed files referenced by this fetch: ${managedFileCount}`,
    `Visible content items discovered: ${manifest.coverage?.content.discovered || 0}`,
    `Course files covered: ${manifest.coverage?.courseFiles.covered || 0} / ${manifest.coverage?.courseFiles.expected || 0} (${manifest.coverage?.courseFiles.downloaded || 0} downloaded, ${manifest.coverage?.courseFiles.placeholders || 0} placeholders)`,
    `LTI resources archived: ${manifest.coverage?.lti?.archived || 0} / ${manifest.coverage?.lti?.expected || 0}`,
    `Announcements discovered: ${manifest.announcements.length}`,
    `Assessments discovered: ${manifest.assessments.length}`,
    `Completed quiz reviews archived: ${manifest.quizReviews?.archived ?? 0} / ${manifest.quizReviews?.expected ?? 0}`,
    `Gradebook items discovered: ${manifest.gradebook?.items.length || 0}`,
    `Calendar items discovered: ${manifest.calendar?.count ?? 0}`,
    `Discussions discovered: ${manifest.discussions?.count ?? 0}`,
    `Message conversations discovered: ${manifest.messages?.count ?? 0}`,
    `Accessible groups discovered: ${manifest.groups?.accessibleGroupCount ?? 0}`,
    `Achievements discovered: ${manifest.achievements?.count ?? 0}`,
    `Annotate files archived: ${manifest.annotations?.archived ?? 0} / ${manifest.annotations?.expected ?? 0}; placeholders: ${manifest.annotations?.placeholders ?? 0}`,
    `External links covered: ${manifest.externalLinks?.archived ?? 0} snapshots and ${manifest.externalLinks?.placeholders ?? 0} placeholders / ${manifest.externalLinks?.expected ?? 0}`,
    `Coverage audit: ${manifest.coverage?.complete ? "complete within the defined archive scope" : "incomplete"}`,
    `Warnings: ${manifest.warnings.length}`,
    `Errors: ${manifest.errors.length}`,
    "",
    "Current grade and deadline snapshot: [CURRENT_STATUS.md](CURRENT_STATUS.md)",
    "Structured gradebook data: [gradebook.json](gradebook.json)",
    "",
    "## Performance",
    "",
    "| Phase | Seconds |",
    "| --- | ---: |",
    ...Object.entries(manifest.timings.phases).map(
      ([phase, milliseconds]) => `| ${phase} | ${(milliseconds / 1000).toFixed(2)} |`
    ),
    "",
    `Coverage audit file hashes read: ${manifest.coverage?.downloads.auditHashReads ?? 0}`,
    "",
    "## Additional Archives",
    "",
    `- Calendar: [${ARCHIVE_DIRECTORIES.calendar}](${ARCHIVE_DIRECTORIES.calendar}/README.md)`,
    `- Discussions: [${ARCHIVE_DIRECTORIES.discussions}](${ARCHIVE_DIRECTORIES.discussions}/README.md)`,
    `- Messages: [${ARCHIVE_DIRECTORIES.messages}](${ARCHIVE_DIRECTORIES.messages}/README.md)`,
    `- Groups: [${ARCHIVE_DIRECTORIES.groups}](${ARCHIVE_DIRECTORIES.groups}/README.md)`,
    `- Achievements: [${ARCHIVE_DIRECTORIES.achievements}](${ARCHIVE_DIRECTORIES.achievements}/README.md)`,
    "- Blackboard Annotate records are stored beside each submitted file under its attempt directory.",
    "- External snapshots are stored beside their `.url` files.",
    "",
    "## Coverage Scope",
    "",
    ...COVERAGE_SCOPE.map((item) => `- ${item}`),
    "",
    "## Not Archived",
    "",
    ...COVERAGE_EXCLUSIONS.map((item) => `- ${item}`),
    "",
    "## Announcements",
    "",
    ...manifest.announcements.map((a) => `- ${a.title}: ${a.postedAt || "undated"}, ${a.directory}`),
    "",
    "## Assessments",
    "",
    ...manifest.assessments.map((assessment) => {
      const score = assessment.grade?.score;
      const grade = score !== null && score !== undefined
        ? `, ${formatPoints(score)}/${formatPoints(assessment.grade.pointsPossible)}`
        : "";
      const due = assessment.dueDate ? `, due ${formatHkt(assessment.dueDate)} HKT` : "";
      return `- ${assessment.title}: ${assessment.attempts.length} attempt(s)${grade}${due}, ${assessment.directory}`;
    }),
    "",
    "## Errors",
    "",
    ...(manifest.errors.length ? manifest.errors.map((e) => `- ${e.label || e.fileName || "item"}: ${e.error}`) : ["- None"]),
    "",
    "## Warnings",
    "",
    ...(manifest.warnings.length
      ? manifest.warnings.map((item) => `- ${item.label || "item"}: ${item.warning}`)
      : ["- None"]),
    "",
  ].join("\n");
  writeText(path.join(OUT_ROOT, "README.md"), summary);
  console.log(
    `DONE ${manifest.contents.length} contents, ${manifest.downloads.length} download records, ${manifest.assessments.length} assessments, ${manifest.warnings.length} warnings, ${manifest.errors.length} errors`
  );
  emitProgress("done", {
    summary: `${manifest.contents.length} content items, ${manifest.downloads.length} files, ${manifest.assessments.length} assessments`,
    coverageComplete: manifest.coverage?.complete === true,
    warnings: manifest.warnings.length,
    errors: manifest.errors.length,
  });
  if (manifest.errors.length || !manifest.coverage?.complete) process.exitCode = 2;
}

main().catch((error) => {
  emitProgress("fatal", { message: error.message });
  console.error(error);
  manifest.errors.push({ label: "fatal", error: error.message });
  manifest.timings.totalMs = Math.round(performance.now() - fetchStartedAt);
  try {
    ensureDir(OUT_ROOT);
    const failureManifestFile = fs.existsSync(MANIFEST_FILE)
      ? path.join(OUT_ROOT, "manifest.failed.json")
      : MANIFEST_FILE;
    recordManifestArtifact(manifest, archivePath(failureManifestFile), {
      origin: "fetcher-record",
      role: "manifest",
      searchable: false,
    });
    writeText(failureManifestFile, JSON.stringify(manifest, null, 2));
    if (failureManifestFile !== MANIFEST_FILE) {
      console.error(`Previous manifest retained; failed attempt written to ${failureManifestFile}`);
    }
  } catch {}
  process.exit(1);
});
