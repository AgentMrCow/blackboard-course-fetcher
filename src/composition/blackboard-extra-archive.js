const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ARCHIVE_DIRECTORIES } = require("../adapters/filesystem/blackboard-archive-layout");
const { recordManifestArtifact } = require("../domain/archive/archive-artifact");

const GROUP_PROFILE_CONCURRENCY = 6;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safePart(value, fallback = "item") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || fallback).slice(0, 150);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value) {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function formatHkt(value) {
  if (!value) return "";
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

const TEXT_EXTERNAL_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".htm",
  ".html",
  ".ics",
  ".js",
  ".json",
  ".md",
  ".srt",
  ".tsv",
  ".txt",
  ".vtt",
  ".xml",
  ".yaml",
  ".yml",
]);

function isTextLikeExternal(urlValue, contentType = "") {
  const mimeType = String(contentType).split(";", 1)[0].trim().toLowerCase();
  if (mimeType.startsWith("text/")) return true;
  if (/^application\/(?:json|ld\+json|xml|xhtml\+xml|javascript)$/.test(mimeType)) return true;
  try {
    return TEXT_EXTERNAL_EXTENSIONS.has(path.extname(new URL(urlValue).pathname).toLowerCase());
  } catch {
    return false;
  }
}

function addError(manifest, label, error) {
  manifest.errors.push({ label, error: String(error?.message ?? error ?? "") });
}

function addWarning(manifest, label, warning) {
  manifest.warnings.push({ label, warning: String(warning ?? "") });
}

function relative(outRoot, file) {
  return path.relative(outRoot, file);
}

function recordArtifact(context, file, metadata) {
  return recordManifestArtifact(context.manifest, relative(context.OUT_ROOT, file), metadata);
}

function writeArtifactText(context, file, text, metadata) {
  writeText(file, text);
  recordArtifact(context, file, metadata);
}

function writeArtifactJson(context, file, value, metadata) {
  writeJson(file, value);
  recordArtifact(context, file, metadata);
}

function isoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function icsDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

async function archiveCalendar(context, course) {
  const { COURSE_ID, OUT_ROOT, manifest, getAllPages } = context;
  const dueDates = (manifest.gradebook?.items || [])
    .map((item) => isoDate(item.dueDate))
    .filter(Boolean)
    .map((value) => new Date(value).getTime());
  const now = new Date(manifest.generatedAt).getTime();
  const earliest = dueDates.length ? Math.min(...dueDates) : now;
  const latest = dueDates.length ? Math.max(...dueDates) : now;
  const since = new Date(earliest - 30 * 86400000).toISOString();
  const termEnd = new Date(course?.term?.endDate || 0).getTime();
  const until = new Date(Math.max(latest + 30 * 86400000, Number.isFinite(termEnd) ? termEnd + 86400000 : 0)).toISOString();
  const query = `since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
  const items = await getAllPages(
    `/learn/api/v1/courses/${COURSE_ID}/calendars/calendarItems?${query}&limit=100&offset=0`
  );
  items.sort((left, right) => new Date(left.startDate || 0) - new Date(right.startDate || 0));

  const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.calendar);
  ensureDir(dir);
  const jsonPath = path.join(dir, "calendar.json");
  writeArtifactJson(context, jsonPath, { generatedAt: manifest.generatedAt, dateRange: { since, until }, count: items.length, items }, {
    origin: "blackboard-content-export",
    role: "calendar-data",
  });

  const courseLabel = course?.displayName || course?.name || COURSE_ID;
  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${icsEscape(courseLabel)} Blackboard Archive//EN`,
    "CALSCALE:GREGORIAN",
  ];
  for (const item of items) {
    const start = icsDate(item.startDate);
    if (!start) continue;
    const end = icsDate(item.endDate || item.startDate) || start;
    const uidSource = `${item.itemSourceId || ""}|${item.title || ""}|${item.startDate || ""}`;
    icsLines.push(
      "BEGIN:VEVENT",
      `UID:${crypto.createHash("sha1").update(uidSource).digest("hex")}@blackboard-course-fetcher`,
      `DTSTAMP:${icsDate(manifest.generatedAt)}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${icsEscape(item.title)}`,
      ...(item.location ? [`LOCATION:${icsEscape(item.location)}`] : []),
      ...(item.description ? [`DESCRIPTION:${icsEscape(stripHtml(item.description))}`] : []),
      "END:VEVENT"
    );
  }
  icsLines.push("END:VCALENDAR", "");
  const icsPath = path.join(dir, `${safePart(course?.courseId || COURSE_ID, "Blackboard_Calendar")}.ics`);
  writeArtifactText(context, icsPath, icsLines.join("\r\n"), {
    origin: "blackboard-content-export",
    role: "calendar-export",
    hiddenByDefault: false,
  });

  writeArtifactText(
    context,
    path.join(dir, "README.md"),
    [
      `# ${courseLabel} Calendar`,
      "",
      `Archived items: ${items.length}`,
      `Range: ${formatHkt(since)} HKT to ${formatHkt(until)} HKT`,
      "",
      "| Start (HKT) | Event | Source |",
      "| --- | --- | --- |",
      ...items.map(
        (item) =>
          `| ${formatHkt(item.startDate)} | ${markdownCell(item.title)} | ${markdownCell(item.itemSourceType || "course event")} |`
      ),
      "",
    ].join("\n"),
    { origin: "fetcher-record", role: "archive-summary", searchable: false }
  );

  manifest.calendar = {
    count: items.length,
    dateRange: { since, until },
    directory: relative(OUT_ROOT, dir),
    jsonPath: relative(OUT_ROOT, jsonPath),
    icsPath: relative(OUT_ROOT, icsPath),
  };
  return { complete: true, count: items.length };
}

async function archiveDiscussions(context) {
  const { COURSE_ID, OUT_ROOT, manifest, getAllPages, bbJson } = context;
  if (context.course?.ultraStatus === "CLASSIC") {
    const boards = await getAllPages(`/learn/api/v1/courses/${COURSE_ID}/discussionboards?limit=100&offset=0`);
    const unread = await optionalJson(bbJson, `/learn/api/v1/courses/${COURSE_ID}/discussionboards/count`);
    const records = [];
    for (const board of boards) {
      const detail = await optionalJson(bbJson, `/learn/api/v1/courses/${COURSE_ID}/discussionboards/${board.id}`);
      records.push({ summary: board, detail, detailRestricted: !detail });
    }
    const restrictedDetailCount = records.filter((item) => item.detailRestricted).length;
    const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.discussions);
    ensureDir(dir);
    const jsonPath = path.join(dir, "discussions.json");
    writeArtifactJson(context, jsonPath, {
      generatedAt: manifest.generatedAt,
      courseView: "CLASSIC",
      count: boards.length,
      unreadCount: unread?.unreadCount ?? null,
      restrictedDetailCount,
      boards: records,
    }, { origin: "blackboard-content-export", role: "discussions-data" });
    writeArtifactText(
      context,
      path.join(dir, "README.md"),
      [
        `# ${context.course?.displayName || COURSE_ID} Discussions`,
        "",
        `Classic discussion boards visible in inventory: ${boards.length}`,
        `Unread: ${unread?.unreadCount ?? "unknown"}`,
        `Board details restricted by Blackboard: ${restrictedDetailCount}`,
        "",
        ...(boards.length ? boards.map((item) => `- ${item.title || item.id}`) : ["- None"]),
        "",
      ].join("\n"),
      { origin: "fetcher-record", role: "archive-summary", searchable: false }
    );
    manifest.discussions = {
      count: boards.length,
      unread: unread?.unreadCount ?? null,
      restrictedDetailCount,
      directory: relative(OUT_ROOT, dir),
      jsonPath: relative(OUT_ROOT, jsonPath),
      complete: true,
      courseView: "CLASSIC",
    };
    return { complete: true, count: boards.length, restrictedDetailCount };
  }

  const items = await getAllPages(
    `/learn/api/v1/courses/${COURSE_ID}/contents/INTERACTIVE/children?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,userMessageState,gradebookCategory&includeInActivityTracking=true&limit=10&offset=0`
  );
  const details = [];
  const forums = [];
  const seenMessageIds = new Set();
  let totalMessages = 0;
  let messagesWithAttachments = 0;

  async function archiveMessageTree(messagesPath, message) {
    const messageId = message?.id;
    if (!messageId || seenMessageIds.has(messageId)) {
      return { ...message, replies: [], duplicateReference: !!messageId };
    }
    seenMessageIds.add(messageId);
    totalMessages += 1;
    if (message?.messageStatus?.hasAttachment) messagesWithAttachments += 1;

    let replies = [];
    if ((message?.messageStatus?.numberOfChildren || 0) > 0) {
      const children = await getAllPages(`${messagesPath}/${messageId}/replies?limit=100&offset=0`);
      replies = await Promise.all(children.map((child) => archiveMessageTree(messagesPath, child)));
    }
    return { ...message, replies };
  }

  for (const item of items) {
    try {
      const detail = await bbJson(`/learn/api/v1/courses/${COURSE_ID}/contents/${item.id}?expand=assignedGroups,gradebookCategory`);
      details.push(detail);
      const forumLink = detail?.contentDetail?.["resource/x-bb-forumlink"];
      if (!forumLink?.conferenceId || !forumLink?.id) continue;

      const forumPath = `/learn/api/v1/courses/${COURSE_ID}/discussionboards/${forumLink.conferenceId}/forums/${forumLink.id}`;
      const forumDetail = await bbJson(forumPath);
      const messagesPath = `${forumPath}/messages`;
      const rootMessages = await getAllPages(`${messagesPath}?limit=100&offset=0`);
      const messages = [];
      for (const message of rootMessages) messages.push(await archiveMessageTree(messagesPath, message));
      forums.push({
        contentId: detail.id || item.id,
        boardId: forumLink.conferenceId,
        forumId: forumLink.id,
        title: forumDetail.title || detail.title || item.title,
        detail: forumDetail,
        messages,
      });
    } catch (error) {
      addError(manifest, `discussion ${item.title || item.id}`, error);
    }
  }

  const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.discussions);
  ensureDir(dir);
  const jsonPath = path.join(dir, "discussions.json");
  writeArtifactJson(context, jsonPath, {
    generatedAt: manifest.generatedAt,
    count: items.length,
    forumCount: forums.length,
    messageCount: totalMessages,
    messagesWithAttachments,
    items: details,
    forums,
  }, { origin: "blackboard-content-export", role: "discussions-data" });
  writeArtifactText(
    context,
    path.join(dir, "README.md"),
    [
      `# ${context.course?.displayName || COURSE_ID} Discussions`,
      "",
      `Discussion topics visible to this student: ${items.length}`,
      `Forums archived with message trees: ${forums.length}`,
      `Messages and replies archived: ${totalMessages}`,
      "",
      ...(items.length ? items.map((item) => `- ${item.title || item.id}`) : ["- None"]),
      "",
    ].join("\n"),
    { origin: "fetcher-record", role: "archive-summary", searchable: false }
  );

  let complete = details.length === items.length && forums.length === details.filter((item) => item.contentHandler === "resource/x-bb-forumlink").length;
  if (messagesWithAttachments > 0) {
    complete = false;
    addWarning(
      manifest,
      "discussions",
      `${messagesWithAttachments} discussion messages advertise attachments; their attachment payloads are not yet archived`
    );
  }
  manifest.discussions = {
    count: items.length,
    forumCount: forums.length,
    messageCount: totalMessages,
    messagesWithAttachments,
    directory: relative(OUT_ROOT, dir),
    jsonPath: relative(OUT_ROOT, jsonPath),
    complete,
  };
  return { complete, count: items.length, forumCount: forums.length, messageCount: totalMessages, messagesWithAttachments };
}

async function optionalJson(bbJson, apiPath) {
  try {
    return await bbJson(apiPath);
  } catch (error) {
    if (/400|403|404/.test(error.message)) return null;
    throw error;
  }
}

async function archiveMessages(context) {
  const { COURSE_ID, OUT_ROOT, manifest, getAllPages, bbJson } = context;
  const conversations = await getAllPages(`/learn/api/v1/courses/${COURSE_ID}/conversations?limit=100&offset=0`);
  const records = [];
  let complete = true;
  for (const conversation of conversations) {
    const id = conversation.id;
    const detail = id ? await optionalJson(bbJson, `/learn/api/v1/courses/${COURSE_ID}/conversations/${id}`) : null;
    let messages = null;
    if (id) {
      try {
        messages = await getAllPages(
          `/learn/api/v1/courses/${COURSE_ID}/conversations/${id}/messages?limit=100&offset=0`
        );
      } catch (error) {
        if (!/400|403|404/.test(error.message)) throw error;
      }
    }
    records.push({ summary: conversation, detail, messages });
    if (!detail && !messages) complete = false;
  }

  const counts = await bbJson(`/learn/api/v1/courses/${COURSE_ID}/conversations/counts`);
  if (conversations.length && !complete) {
    addWarning(
      manifest,
      "messages",
      "Conversation summaries were archived, but one or more message-detail endpoints were unavailable"
    );
  }

  const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.messages);
  ensureDir(dir);
  const jsonPath = path.join(dir, "messages.json");
  writeArtifactJson(context, jsonPath, { generatedAt: manifest.generatedAt, counts, conversations: records }, {
    origin: "blackboard-content-export",
    role: "messages-data",
  });
  writeArtifactText(
    context,
    path.join(dir, "README.md"),
    [
      `# ${context.course?.displayName || COURSE_ID} Messages`,
      "",
      `Conversations: ${counts.totalCount ?? conversations.length}`,
      `Unread: ${counts.unreadCount ?? 0}`,
      "",
      ...(conversations.length
        ? conversations.map((item) => `- ${item.subject || item.title || item.id}`)
        : ["- None"]),
      "",
    ].join("\n"),
    { origin: "fetcher-record", role: "archive-summary", searchable: false }
  );
  manifest.messages = {
    count: counts.totalCount ?? conversations.length,
    unread: counts.unreadCount ?? null,
    directory: relative(OUT_ROOT, dir),
    jsonPath: relative(OUT_ROOT, jsonPath),
    complete,
  };
  return { complete, count: manifest.messages.count };
}

async function archiveGroups(context) {
  const { COURSE_ID, OUT_ROOT, manifest, getAllPages, bbJson } = context;
  const groupSets = await getAllPages(
    `/learn/api/v1/courses/${COURSE_ID}/groupsets?expand=studentCount,groupCount,permissions,signUpSheet,hasAssociatedContent&sort=title(asc),id(desc)&limit=1000&offset=0`
  );
  const groups = await getAllPages(
    `/learn/api/v1/courses/${COURSE_ID}/groups?limit=1000&offset=0&expand=studentCount,memberships,permissions,signUpSheet,hasSubmittedGroupAttempt,hasGrades&membershipAvailable=true`
  );

  const profileCache = new Map();
  const userIds = [
    ...new Set(
      groups
        .flatMap((group) => group.memberships || [])
        .map((membership) => membership.userId)
        .filter(Boolean)
    ),
  ];
  let nextUserIndex = 0;
  async function profileWorker() {
    while (nextUserIndex < userIds.length) {
      const index = nextUserIndex;
      nextUserIndex += 1;
      const userId = userIds[index];
      const profile = await bbJson(
        `/learn/api/v1/courses/${COURSE_ID}/users/${userId}?expand=courseRole,user`
      );
      profileCache.set(userId, profile);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(GROUP_PROFILE_CONCURRENCY, userIds.length) }, () => profileWorker())
  );

  const normalizedGroups = [];
  for (const group of groups) {
    const members = [];
    for (const membership of group.memberships || []) {
      const profile = profileCache.get(membership.userId) || {};
      const user = profile.user || {};
      members.push({
        userId: membership.userId,
        membershipId: membership.membershipId || profile.id || null,
        givenName: user.givenName || null,
        familyName: user.familyName || null,
        displayName: [user.givenName, user.familyName].filter(Boolean).join(" ") || membership.userId,
        courseRole: profile.courseRole?.identifier || profile.role || null,
      });
    }
    members.sort((left, right) => left.displayName.localeCompare(right.displayName));
    normalizedGroups.push({
      id: group.id,
      title: group.title,
      groupSetId: group.groupSetId || null,
      studentCount: group.studentCount ?? members.length,
      hasSubmittedGroupAttempt: group.hasSubmittedGroupAttempt ?? null,
      hasGrades: group.hasGrades ?? null,
      members,
    });
  }

  const totalGroups = groupSets.reduce((sum, item) => sum + (Number(item.groupCount) || 0), 0);
  const restrictedGroupCount = Math.max(totalGroups - groups.length, 0);
  const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.groups);
  ensureDir(dir);
  const jsonPath = path.join(dir, "groups.json");
  writeArtifactJson(context, jsonPath, {
    generatedAt: manifest.generatedAt,
    groupSets,
    accessibleGroups: normalizedGroups,
    totalGroups,
    restrictedGroupCount,
  }, { origin: "blackboard-content-export", role: "groups-data" });

  const lines = [
    `# ${context.course?.displayName || COURSE_ID} Groups`,
    "",
    `Accessible groups: ${groups.length} / ${totalGroups}`,
    `Other group rosters restricted by Blackboard: ${restrictedGroupCount}`,
    "",
  ];
  for (const group of normalizedGroups) {
    lines.push(`## ${group.title}`, "", ...group.members.map((member) => `- ${member.displayName}`), "");
  }
  writeArtifactText(context, path.join(dir, "README.md"), lines.join("\n"), {
    origin: "fetcher-record",
    role: "archive-summary",
    searchable: false,
  });
  manifest.groups = {
    groupSetCount: groupSets.length,
    accessibleGroupCount: groups.length,
    totalGroupCount: totalGroups,
    restrictedGroupCount,
    memberCount: normalizedGroups.reduce((sum, group) => sum + group.members.length, 0),
    profileConcurrency: GROUP_PROFILE_CONCURRENCY,
    directory: relative(OUT_ROOT, dir),
    jsonPath: relative(OUT_ROOT, jsonPath),
    complete: true,
  };
  return { complete: true, count: groups.length, restrictedGroupCount };
}

async function fetchExternal(url, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
        headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,application/json,text/plain,*/*" },
      });
      if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && attempt < maxAttempts) {
        await response.body?.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError || new Error(`Unable to fetch ${url}`);
}

function recordExternalDownload(context, file, buffer, metadata) {
  const { OUT_ROOT, manifest } = context;
  const relativePath = relative(OUT_ROOT, file);
  manifest.downloads.push({
    label: metadata.label,
    fileName: path.basename(file),
    path: relativePath,
    size: buffer.length,
    expectedSize: null,
    contentType: metadata.contentType || null,
    sourceUrl: metadata.sourceUrl,
    sha256: sha256(buffer),
    integrityVerified: true,
    externalSnapshot: true,
    ...(metadata.placeholder
      ? {
          placeholder: true,
          placeholderReason: metadata.placeholderReason || "binary body omitted in placeholder test mode",
          remoteSize: metadata.remoteSize ?? null,
        }
      : {}),
  });
  if (metadata.placeholder) {
    if (manifest.transfer) manifest.transfer.placeholderFiles += 1;
  } else if (manifest.transfer) {
    manifest.transfer.networkFiles += 1;
    manifest.transfer.networkBytes += buffer.length;
  }
  recordManifestArtifact(manifest, relativePath, metadata.placeholder
    ? {
        origin: "fetcher-record",
        role: "placeholder",
        hiddenByDefault: false,
        searchable: false,
      }
    : {
        origin: "external-resource",
        role: metadata.artifactRole || "external-resource",
        hiddenByDefault: metadata.hiddenByDefault ?? false,
      });
}

function writeExternalPlaceholder(context, directory, fileName, metadata) {
  const outPath = path.join(directory, `${safePart(fileName)}.placeholder.json`);
  const body = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        placeholder: true,
        reason: metadata.reason || "binary body omitted in placeholder test mode",
        title: metadata.title || null,
        originalFileName: fileName,
        sourceUrl: metadata.sourceUrl,
        finalUrl: metadata.finalUrl || metadata.sourceUrl,
        contentType: metadata.contentType || null,
        remoteSize: metadata.remoteSize ?? null,
        generatedAt: context.manifest.generatedAt,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  ensureDir(directory);
  fs.writeFileSync(outPath, body);
  recordExternalDownload(context, outPath, body, {
    label: metadata.label || `${metadata.title || fileName} placeholder`,
    sourceUrl: metadata.sourceUrl,
    contentType: "application/json",
    placeholder: true,
    placeholderReason: metadata.reason,
    remoteSize: metadata.remoteSize,
  });
  return outPath;
}

function extractJsonArrayAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function archiveExternalLinks(context) {
  const { OUT_ROOT, manifest, externalLinks, downloadMode } = context;
  const records = [];
  const seen = new Set();
  for (const link of externalLinks) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    try {
      const response = await fetchExternal(link.url);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const record = {
          title: link.title,
          sourceUrl: link.url,
          finalUrl: response.url,
          status: response.status,
          contentType: response.headers.get("content-type") || null,
          unavailable: true,
          linkOnly: true,
          error: `HTTP ${response.status} ${response.statusText}`,
          dynamicAssetsMirrored: false,
          mediaStreamDownloaded: false,
        };
        const metadataPath = path.join(link.directory, "external_metadata.json");
        writeArtifactJson(context, metadataPath, { fetchedAt: manifest.generatedAt, ...record }, {
          origin: "fetcher-record",
          role: "external-metadata",
          searchable: false,
        });
        record.metadataPath = relative(OUT_ROOT, metadataPath);
        records.push(record);
        addWarning(manifest, `external link ${link.title}`, `${record.error}; Blackboard shortcut retained`);
        continue;
      }
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      if (downloadMode === "placeholder" && !isTextLikeExternal(response.url, contentType)) {
        const remoteSize = Number(response.headers.get("content-length")) || null;
        await response.body?.cancel().catch(() => {});
        const placeholderPath = writeExternalPlaceholder(context, link.directory, "external_binary", {
          title: link.title,
          label: `${link.title} external resource`,
          sourceUrl: link.url,
          finalUrl: response.url,
          contentType,
          remoteSize,
        });
        const record = {
          title: link.title,
          sourceUrl: link.url,
          finalUrl: response.url,
          status: response.status,
          contentType,
          remoteSize,
          placeholder: true,
          placeholderPath: relative(OUT_ROOT, placeholderPath),
          dynamicAssetsMirrored: false,
          mediaStreamDownloaded: false,
        };
        const metadataPath = path.join(link.directory, "external_metadata.json");
        writeArtifactJson(context, metadataPath, { fetchedAt: manifest.generatedAt, ...record }, {
          origin: "fetcher-record",
          role: "external-metadata",
          searchable: false,
        });
        record.metadataPath = relative(OUT_ROOT, metadataPath);
        records.push(record);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 20 * 1024 * 1024) throw new Error(`Snapshot exceeds 20 MiB (${buffer.length} bytes)`);
      const extension = /html/i.test(contentType) ? ".html" : /json/i.test(contentType) ? ".json" : ".bin";
      const snapshotPath = path.join(link.directory, `external_snapshot${extension}`);
      ensureDir(link.directory);
      fs.writeFileSync(snapshotPath, buffer);
      recordExternalDownload(context, snapshotPath, buffer, {
        label: `${link.title} external snapshot`,
        sourceUrl: response.url,
        contentType,
        artifactRole: "external-snapshot",
        hiddenByDefault: true,
      });

      const record = {
        title: link.title,
        sourceUrl: link.url,
        finalUrl: response.url,
        status: response.status,
        contentType,
        size: buffer.length,
        sha256: sha256(buffer),
        snapshotPath: relative(OUT_ROOT, snapshotPath),
        dynamicAssetsMirrored: false,
        mediaStreamDownloaded: false,
      };

      if (/youtu(?:\.be|be\.com)/i.test(link.url)) {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(link.url)}&format=json`;
        const oembedResponse = await fetchExternal(oembedUrl);
        if (oembedResponse.ok) {
          const oembed = await oembedResponse.json();
          const oembedPath = path.join(link.directory, "youtube_oembed.json");
          writeArtifactJson(context, oembedPath, oembed, {
            origin: "blackboard-content-export",
            role: "external-oembed-data",
          });
          record.oembedPath = relative(OUT_ROOT, oembedPath);
          if (oembed.thumbnail_url) {
            if (downloadMode === "placeholder") {
              const thumbnailPath = writeExternalPlaceholder(context, link.directory, "youtube_thumbnail.jpg", {
                title: `${link.title} thumbnail`,
                label: `${link.title} thumbnail`,
                sourceUrl: oembed.thumbnail_url,
                contentType: "image/jpeg",
              });
              record.thumbnailPlaceholderPath = relative(OUT_ROOT, thumbnailPath);
            } else {
              const thumbnailResponse = await fetchExternal(oembed.thumbnail_url);
              if (thumbnailResponse.ok) {
                const thumbnail = Buffer.from(await thumbnailResponse.arrayBuffer());
                const thumbnailPath = path.join(link.directory, "youtube_thumbnail.jpg");
                fs.writeFileSync(thumbnailPath, thumbnail);
                recordExternalDownload(context, thumbnailPath, thumbnail, {
                  label: `${link.title} thumbnail`,
                  sourceUrl: thumbnailResponse.url,
                  contentType: thumbnailResponse.headers.get("content-type") || "image/jpeg",
                  artifactRole: "external-media",
                });
                record.thumbnailPath = relative(OUT_ROOT, thumbnailPath);
              }
            }
          }
        }

        const captionTracks = extractJsonArrayAfter(buffer.toString("utf8"), '"captionTracks":') || [];
        const captionTrack =
          captionTracks.find((item) => /^en(?:-|$)/i.test(item.languageCode || "")) || captionTracks[0];
        record.captionTracks = captionTracks.map((item) => ({
          languageCode: item.languageCode || null,
          name: item.name?.simpleText || item.name?.runs?.map((run) => run.text).join("") || null,
          kind: item.kind || null,
        }));
        if (captionTrack?.baseUrl) {
          const captionUrl = new URL(captionTrack.baseUrl);
          captionUrl.searchParams.set("fmt", "vtt");
          const captionResponse = await fetchExternal(captionUrl.toString());
          if (captionResponse.ok) {
            const captions = Buffer.from(await captionResponse.arrayBuffer());
            if (captions.length) {
              const language = safePart(captionTrack.languageCode || "captions");
              const captionPath = path.join(link.directory, `youtube_captions_${language}.vtt`);
              fs.writeFileSync(captionPath, captions);
              recordExternalDownload(context, captionPath, captions, {
                label: `${link.title} captions (${language})`,
                sourceUrl: `${link.url}#captions-${language}`,
                contentType: captionResponse.headers.get("content-type") || "text/vtt",
                artifactRole: "external-media",
              });
              record.captionPath = relative(OUT_ROOT, captionPath);
            }
          }
        }
      }

      const metadataPath = path.join(link.directory, "external_metadata.json");
      writeArtifactJson(context, metadataPath, { fetchedAt: manifest.generatedAt, ...record }, {
        origin: "fetcher-record",
        role: "external-metadata",
        searchable: false,
      });
      record.metadataPath = relative(OUT_ROOT, metadataPath);
      records.push(record);
    } catch (error) {
      const record = {
        title: link.title,
        sourceUrl: link.url,
        unavailable: true,
        linkOnly: true,
        error: error.message,
        dynamicAssetsMirrored: false,
        mediaStreamDownloaded: false,
      };
      const metadataPath = path.join(link.directory, "external_metadata.json");
      writeArtifactJson(context, metadataPath, { fetchedAt: manifest.generatedAt, ...record }, {
        origin: "fetcher-record",
        role: "external-metadata",
        searchable: false,
      });
      record.metadataPath = relative(OUT_ROOT, metadataPath);
      records.push(record);
      addWarning(manifest, `external link ${link.title}`, `${record.error}; Blackboard shortcut retained`);
    }
  }
  manifest.externalLinks = {
    expected: seen.size,
    archived: records.filter((item) => item.snapshotPath).length,
    placeholders: records.filter((item) => item.placeholderPath).length,
    linkOnly: records.filter((item) => item.linkOnly && item.metadataPath).length,
    records,
    complete: records.every((item) => item.snapshotPath || item.placeholderPath || (item.linkOnly && item.metadataPath)),
  };
  return { complete: manifest.externalLinks.complete, count: records.length };
}

function countChanges(sync) {
  const changes = sync?.changes || {};
  let count = 0;
  for (const value of Object.values(changes)) {
    if (Array.isArray(value)) count += value.length;
    else if (value && typeof value === "object") count += Object.keys(value).length;
  }
  return count;
}

function classifyChanges(sync) {
  const records = [];
  for (const action of ["created", "updated", "deleted"]) {
    const value = sync?.changes?.[action];
    if (Array.isArray(value)) records.push(...value.map((item) => ({ action, item })));
    else if (value && typeof value === "object") {
      records.push(...Object.values(value).map((item) => ({ action, item })));
    }
  }
  const visible = records.filter(({ item }) => item?.content && item.permissions?.view !== false);
  const embeddedLinks = visible.filter(({ item }) => item.content?.type === "pspdfkit/link");
  const comments = visible.filter(({ item }) => /comment|note/i.test(item.content?.type || ""));
  return {
    rawRecordCount: records.length,
    visibleMarkupCount: visible.length - embeddedLinks.length,
    embeddedLinkCount: embeddedLinks.length,
    commentCount: comments.length,
    restrictedRecordCount: records.filter(({ item }) => !item?.content || item.permissions?.view === false).length,
  };
}

function viewerEntries(...details) {
  const entries = [];
  for (const detail of details.filter(Boolean)) {
    if (Array.isArray(detail.studentSubmissionFiles)) entries.push(...detail.studentSubmissionFiles);
    const assessment = detail.toolAttemptDetail?.["resource/x-bb-assessment"];
    if (Array.isArray(assessment?.studentSubmissionFiles)) entries.push(...assessment.studentSubmissionFiles);
  }
  return entries.filter((entry) => entry?.viewUrl);
}

async function refreshApiAnnotationViewUrl(context, check) {
  const { COURSE_ID, bbJson } = context;
  const attemptDetail = await bbJson(
    `/learn/api/v1/courses/${COURSE_ID}/gradebook/attempts/${check.attemptId}?columnId=${check.columnId}&expand=viewUrl%2CtoolAttemptDetail%2CfeedbackToUser`
  );
  let groupAttemptDetail = null;
  if (check.groupAttemptId) {
    groupAttemptDetail = await bbJson(
      `/learn/api/v1/courses/${COURSE_ID}/gradebook/groupAttempts/${check.groupAttemptId}?expand=attempts,feedbackToUser,viewUrl`
    );
  }

  const entries = viewerEntries(groupAttemptDetail, attemptDetail);
  const exact = entries.find((entry) => {
    const file = entry.file || {};
    return (file.fileName || entry.name || entry.linkName || entry.fileName) === check.fileName;
  });
  const selected = exact || (entries.length === 1 ? entries[0] : null);
  if (!selected?.viewUrl) throw new Error("Blackboard did not return a fresh Annotate viewer URL");
  return selected.viewUrl;
}

function archiveAnnotationCapture(context, check, capture) {
  const { OUT_ROOT, manifest } = context;
  const documentMetadata = capture.documentMetadata;
  const syncData = capture.syncData;
  if (!syncData) throw new Error("Annotate sync returned no data");

  const dir = path.join(check.attemptDir, "annotations");
  ensureDir(dir);
  const outPath = path.join(dir, `${safePart(check.fileName)}.annotations.json`);
  const archived = {
    checkedAt: manifest.generatedAt,
    assessment: check.assessmentTitle,
    attemptId: check.attemptId,
    fileName: check.fileName,
    document: documentMetadata?.data || documentMetadata || null,
    documentResponse: documentMetadata || null,
    sync: syncData,
  };
  writeArtifactJson(context, outPath, archived, {
    origin: "blackboard-content-export",
    role: "annotation-data",
    logicalItemType: "assessment-attempt",
    logicalItemId: check.attemptId,
    logicalItemTitle: check.assessmentTitle,
  });
  const record = {
    fileName: check.fileName,
    path: relative(OUT_ROOT, outPath),
    recordRevision: syncData.record_rev ?? null,
    changeCount: countChanges(syncData),
    ...classifyChanges(syncData),
  };
  check.attemptRecord.annotations.push(record);
  return record;
}

function archiveAnnotationPlaceholders(context) {
  const { OUT_ROOT, manifest, annotationChecks } = context;
  const records = [];
  for (const check of annotationChecks) {
    const dir = path.join(check.attemptDir, "annotations");
    ensureDir(dir);
    const outPath = path.join(dir, `${safePart(check.fileName)}.annotations.placeholder.json`);
    writeArtifactJson(context, outPath, {
      schemaVersion: 1,
      placeholder: true,
      reason: "Annotate viewer load omitted in placeholder test mode",
      generatedAt: manifest.generatedAt,
      assessment: check.assessmentTitle,
      attemptId: check.attemptId,
      fileName: check.fileName,
      mimeType: check.mimeType || null,
    }, {
      origin: "fetcher-record",
      role: "placeholder",
      hiddenByDefault: false,
      searchable: false,
      logicalItemType: "assessment-attempt",
      logicalItemId: check.attemptId,
      logicalItemTitle: check.assessmentTitle,
    });
    const record = {
      fileName: check.fileName,
      path: relative(OUT_ROOT, outPath),
      placeholder: true,
      mimeType: check.mimeType || null,
    };
    check.attemptRecord.annotations.push(record);
    records.push(record);
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  manifest.annotations = {
    expected: annotationChecks.length,
    archived: 0,
    placeholders: records.length,
    failed: [],
    withRawChanges: 0,
    withVisibleMarkup: 0,
    records,
    complete: true,
    mode: "placeholder",
  };
  return { complete: true, count: records.length, placeholders: records.length };
}

function archiveAchievementsCapture(context, capture) {
  const { COURSE_ID, OUT_ROOT, manifest } = context;
  const list = capture.list || {};
  const unread = capture.unread ?? null;
  const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.achievements);
  ensureDir(dir);
  const jsonPath = path.join(dir, "achievements.json");
  writeArtifactJson(context, jsonPath, {
    generatedAt: manifest.generatedAt,
    ...list,
    unreadAchievementIds: unread?.unreadAchievementIds || [],
    apiResponses: { achievements: list, unread },
  }, { origin: "blackboard-content-export", role: "achievements-data" });
  const count = Array.isArray(list.results) ? list.results.length : 0;
  writeArtifactText(
    context,
    path.join(dir, "README.md"),
    [
      `# ${context.course?.displayName || COURSE_ID} Achievements`,
      "",
      `Achievements visible to this student: ${count}`,
      "",
      ...(count ? list.results.map((item) => `- ${item.title || item.name || item.id}`) : ["- None"]),
      "",
    ].join("\n"),
    { origin: "fetcher-record", role: "archive-summary", searchable: false }
  );
  manifest.achievements = {
    count,
    unread: unread?.unreadAchievementIds?.length || 0,
    directory: relative(OUT_ROOT, dir),
    jsonPath: relative(OUT_ROOT, jsonPath),
    complete: true,
  };
  return { complete: true, count };
}

function archiveClassicAchievements(context) {
  const { COURSE_ID, OUT_ROOT, manifest } = context;
  const dir = path.join(OUT_ROOT, ARCHIVE_DIRECTORIES.achievements);
  ensureDir(dir);
  const jsonPath = path.join(dir, "achievements.json");
  const reason = "The Foundations achievements service does not expose this Classic course view";
  writeArtifactJson(context, jsonPath, {
    generatedAt: manifest.generatedAt,
    courseView: "CLASSIC",
    applicable: false,
    reason,
    results: [],
  }, { origin: "blackboard-content-export", role: "achievements-data" });
  writeArtifactText(
    context,
    path.join(dir, "README.md"),
    [`# ${context.course?.displayName || COURSE_ID} Achievements`, "", "Not available for this Classic course view.", ""].join(
      "\n"
    ),
    { origin: "fetcher-record", role: "archive-summary", searchable: false }
  );
  manifest.achievements = {
    count: 0,
    unread: 0,
    applicable: false,
    reason,
    directory: relative(OUT_ROOT, dir),
    jsonPath: relative(OUT_ROOT, jsonPath),
    complete: true,
  };
  return { complete: true, count: 0, applicable: false };
}

async function archiveUiData(context) {
  const { manifest, annotationChecks, uiDataGateway } = context;
  const results = { achievements: null, annotations: null };
  const classic = context.course?.ultraStatus === "CLASSIC";
  if (classic && context.downloadMode === "placeholder") {
    results.achievements = archiveClassicAchievements(context);
    results.annotations = archiveAnnotationPlaceholders(context);
    return results;
  }

  const annotationRequests =
    context.downloadMode === "placeholder"
      ? []
      : annotationChecks.map((check, index) => ({
          id: index,
          classicHistoryUrl: check.classicHistoryUrl || null,
        }));
  const needsGateway = !classic || annotationRequests.length > 0;
  if (needsGateway && typeof uiDataGateway?.collect !== "function") {
    throw new Error("Blackboard Extras requires a UI data gateway");
  }
  const captures = needsGateway
    ? await uiDataGateway.collect({
        achievementsUrl: classic
          ? null
          : `${context.BASE}/ultra/courses/${encodeURIComponent(context.COURSE_ID)}/achievements`,
        annotationRequests,
        refreshAnnotationViewUrl: (request) =>
          refreshApiAnnotationViewUrl(context, annotationChecks[request.id]),
        onAnnotationCapture: (request, capture) =>
          archiveAnnotationCapture(context, annotationChecks[request.id], capture),
      })
    : { achievements: null, annotations: [] };

  if (classic) {
    results.achievements = archiveClassicAchievements(context);
  } else if (captures.achievements?.value) {
    results.achievements = archiveAchievementsCapture(context, captures.achievements.value);
  } else {
    addError(
      manifest,
      "achievements",
      new Error(captures.achievements?.error || "Achievements browser capture returned no result")
    );
    results.achievements = { complete: false, count: null };
  }

  if (context.downloadMode === "placeholder") {
    results.annotations = archiveAnnotationPlaceholders(context);
    return results;
  }

  const captureById = new Map(captures.annotations.map((capture) => [capture.id, capture]));
  const archived = [];
  const failed = [];
  for (let index = 0; index < annotationChecks.length; index += 1) {
    const check = annotationChecks[index];
    const capture = captureById.get(index);
    if (capture && Object.hasOwn(capture, "value")) {
      archived.push(capture.value);
      continue;
    }
    const failure = {
      assessment: check.assessmentTitle,
      attemptId: check.attemptId,
      fileName: check.fileName,
      firstError: capture?.firstError || "Annotation capture returned no result",
      retryError: capture?.retryError || "Annotation capture returned no result",
    };
    failed.push(failure);
    addError(
      manifest,
      `Blackboard Annotate ${check.assessmentTitle} / ${check.fileName}`,
      new Error(failure.retryError)
    );
  }
  archived.sort((left, right) => left.path.localeCompare(right.path));
  manifest.annotations = {
    expected: annotationChecks.length,
    archived: archived.length,
    placeholders: 0,
    failed,
    withRawChanges: archived.filter((item) => item.changeCount > 0).length,
    withVisibleMarkup: archived.filter((item) => item.visibleMarkupCount > 0).length,
    records: archived,
    complete: failed.length === 0,
  };
  results.annotations = { complete: failed.length === 0, count: archived.length };
  return results;
}

async function archiveBlackboardExtras(context) {
  const { manifest, bbJson } = context;
  const startedAt = Date.now();
  const areaResults = {};
  const timings = {};
  const metadataStartedAt = Date.now();
  const course = await bbJson(`/learn/api/v1/courses/${context.COURSE_ID}`);
  timings.courseMetadata = Date.now() - metadataStartedAt;
  context.course = course;

  for (const [name, operation] of [
    ["calendar", () => archiveCalendar(context, course)],
    ["discussions", () => archiveDiscussions(context)],
    ["messages", () => archiveMessages(context)],
    ["groups", () => archiveGroups(context)],
    ["externalLinks", () => archiveExternalLinks(context)],
  ]) {
    const areaStartedAt = Date.now();
    try {
      areaResults[name] = await operation();
    } catch (error) {
      addError(manifest, name, error);
      areaResults[name] = { complete: false, count: null };
    } finally {
      timings[name] = Date.now() - areaStartedAt;
    }
  }

  const uiStartedAt = Date.now();
  try {
    Object.assign(areaResults, await archiveUiData(context));
  } catch (error) {
    addError(manifest, "UI-only archive", error);
    areaResults.achievements ||= { complete: false, count: null };
    areaResults.annotations ||= { complete: false, count: null };
  } finally {
    timings.uiData = Date.now() - uiStartedAt;
  }

  manifest.extraArchive = {
    complete: Object.values(areaResults).every((result) => result?.complete === true),
    areas: areaResults,
    timings,
    totalMs: Date.now() - startedAt,
  };
  return manifest.extraArchive;
}

module.exports = { archiveBlackboardExtras, archiveUiData };
