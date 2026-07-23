import type { ArchiveFile, Course, FileScope, JsonRecord } from "./types";

export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let index = -1;
  do {
    amount /= 1024;
    index += 1;
  } while (amount >= 1024 && index < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}

export function formatDuration(value: unknown, compact = false): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Unknown";
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1000))}${compact ? "s" : " sec"}`;
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}${compact ? "m" : ` min${minutes === 1 ? "" : "s"}`}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}${compact ? "h" : ` hr${hours === 1 ? "" : "s"}`}${remainder ? ` ${remainder}${compact ? "m" : " min"}` : ""}`;
}

export function formatDate(value: unknown, options: { year?: boolean; time?: boolean } = {}): string {
  if (!value) return "Not set";
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-HK", {
    day: "numeric",
    month: "short",
    year: options.year === false ? undefined : "numeric",
    hour: options.time ? "2-digit" : undefined,
    minute: options.time ? "2-digit" : undefined,
  }).format(date);
}

export function relativeTime(value: unknown): string {
  if (!value) return "Never";
  const delta = new Date(String(value)).valueOf() - Date.now();
  const absolute = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60_000) return formatter.format(Math.round(delta / 1000), "second");
  if (absolute < 3_600_000) return formatter.format(Math.round(delta / 60_000), "minute");
  if (absolute < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
  if (absolute < 2_592_000_000) return formatter.format(Math.round(delta / 86_400_000), "day");
  return formatDate(value);
}

export function titleCase(value: unknown): string {
  return String(value || "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function initials(value: unknown, maximum = 2): string {
  return String(value || "?")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maximum)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
}

export function colorFor(value: unknown): string {
  const colors = ["green", "blue", "amber", "red", "violet"];
  const hash = [...String(value || "")].reduce((total, character) => total + character.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

export function statusInfo(value: unknown): { className: string; label: string } {
  const raw = String(value || "unknown").toLowerCase();
  if (["complete", "completed", "graded", "submitted", "completed_with_issues"].includes(raw)) {
    return { className: raw === "completed_with_issues" ? "warning" : "success", label: raw === "completed_with_issues" ? "Issues" : titleCase(raw) };
  }
  if (["running", "queued", "starting", "saving", "pausing"].includes(raw)) return { className: "info", label: titleCase(raw) };
  if (["incomplete", "paused", "waiting", "needs_grading", "in_progress", "draft_saved_student", "draft_after_graded_submission"].includes(raw)) return { className: "warning", label: titleCase(raw) };
  if (["failed", "error", "cancelled", "unavailable", "interrupted"].includes(raw)) return { className: "error", label: titleCase(raw) };
  return { className: "neutral", label: titleCase(raw) || "Unknown" };
}

export function fileIconName(preview: string): string {
  return ({
    archive: "file-archive",
    audio: "file-audio",
    download: "file",
    html: "file-code",
    image: "file-image",
    json: "braces",
    link: "external-link",
    office: "file-spreadsheet",
    pdf: "file-text",
    placeholder: "file-question",
    text: "file-type",
    unresolved: "file-warning",
    video: "file-video",
  } as Record<string, string>)[preview] || "file";
}

export function artifactOriginLabel(origin: string): string {
  return ({
    "blackboard-original": "Blackboard file",
    "blackboard-content-export": "Blackboard export",
    "derived-search-text": "Search text",
    "external-resource": "External resource",
    "fetcher-record": "Archive record",
    "local-file": "Local file",
  } as Record<string, string>)[origin] || "Local file";
}

export function fileMatchesScope(file: ArchiveFile, scope: FileScope): boolean {
  if (scope === "all") return true;
  if (scope === "records") return file.origin === "fetcher-record";
  if (scope === "exports") {
    return ["blackboard-content-export", "external-resource"].includes(file.origin)
      && file.path === file.primaryPath;
  }
  return file.hiddenByDefault !== true;
}

export function fileEndpoint(courseId: string, filePath: string, download = false): string {
  return `/api/courses/${encodeURIComponent(courseId)}/file?path=${encodeURIComponent(filePath)}${download ? "&download=1" : ""}`;
}

export function courseGradeSummary(detail: JsonRecord): JsonRecord | null {
  return detail.gradebook?.summary?.blackboardDisplay || detail.gradebook?.summary?.performanceToDate || null;
}

export function assessmentStatus(assessment: JsonRecord): string {
  return assessment.status || assessment.grade?.submissionStatus || assessment.grade?.status || assessment.latestAttempt?.status || "not_started";
}

export function dateKey(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function courseFileByPath(files: ArchiveFile[], filePath: string): ArchiveFile {
  return files.find((file) => file.path === filePath) || {
    path: filePath,
    name: filePath.split("/").at(-1) || filePath,
    preview: "download",
    size: null,
    category: "Course records",
    origin: "local-file",
    role: "local-file",
    hiddenByDefault: false,
    searchable: true,
    primaryPath: filePath,
    groupKey: filePath,
  };
}

export function contentIcon(handler: unknown, container: unknown): string {
  if (container) return "folder";
  if (/file/.test(String(handler || ""))) return "file";
  if (/asmt|assignment/.test(String(handler || ""))) return "clipboard-check";
  if (/externallink/.test(String(handler || ""))) return "external-link";
  if (/document/.test(String(handler || ""))) return "file-text";
  if (/video/.test(String(handler || ""))) return "file-video";
  return "file-question";
}

export function courseLabel(course: Course): string {
  return course.code || course.name;
}
