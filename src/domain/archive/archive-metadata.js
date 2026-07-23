const TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".htm",
  ".ics",
  ".ini",
  ".js",
  ".json",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".sql",
  ".txt",
  ".url",
  ".v",
  ".vhd",
  ".vhdl",
  ".xdc",
  ".xml",
  ".yaml",
  ".yml",
]);

const MIME_TYPES = new Map([
  [".avi", "video/x-msvideo"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".h5p", "application/zip"],
  [".htm", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".ics", "text/calendar; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".md", "text/markdown; charset=utf-8"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".vtt", "text/vtt; charset=utf-8"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
]);

const CATEGORY_LABELS = {
  "00_Course_Outline": "Course outline",
  "01_Course_Contents": "Course content",
  "02_Announcements": "Announcements",
  "03_Calendar": "Calendar",
  "04_Discussions": "Discussions",
  "05_Messages": "Messages",
  "06_Groups": "Groups",
  "07_Achievements": "Achievements",
  "08_Library": "Library",
};

function normalizeArchivePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function archiveBasename(value) {
  return normalizeArchivePath(value).split("/").at(-1) || "";
}

function fileExtension(value) {
  const name = archiveBasename(value);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

function mimeType(file) {
  return MIME_TYPES.get(fileExtension(file)) || "application/octet-stream";
}

function previewKind(file) {
  const normalized = normalizeArchivePath(file).toLowerCase();
  const extension = fileExtension(normalized);
  if (normalized.endsWith(".placeholder.json")) return "placeholder";
  if (normalized.endsWith(".unresolved.json")) return "unresolved";
  if (extension === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(extension)) return "image";
  if ([".mp4", ".webm", ".mov", ".avi"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(extension)) return "audio";
  if ([".html", ".htm"].includes(extension)) return "html";
  if (extension === ".url") return "link";
  if (TEXT_EXTENSIONS.has(extension)) return extension === ".json" ? "json" : "text";
  if ([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].includes(extension)) return "office";
  if ([".h5p", ".zip", ".rar", ".7z", ".tar", ".gz"].includes(extension)) return "archive";
  return "download";
}

function fileCategory(relativePath) {
  const top = normalizeArchivePath(relativePath).split("/")[0];
  return CATEGORY_LABELS[top] || "Course records";
}

function compactCourseName(course) {
  const externalId = String(course.externalId || course.courseId || course.id || "").replace(/-ULTRA$/i, "");
  const match = externalId.match(/(?:\d{4}[A-Z]\d?-)?([A-Z]{3,5}\d{4}[A-Z0-9-]*)/i);
  return match?.[1] || externalId || course.id;
}

function displayTerm(course) {
  return course.term?.name || course.term?.sourceName || "No term";
}

module.exports = {
  CATEGORY_LABELS,
  MIME_TYPES,
  TEXT_EXTENSIONS,
  archiveBasename,
  compactCourseName,
  displayTerm,
  fileCategory,
  fileExtension,
  mimeType,
  normalizeArchivePath,
  previewKind,
};
