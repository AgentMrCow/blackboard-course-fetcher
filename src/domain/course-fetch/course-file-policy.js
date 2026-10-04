const DEFAULT_PLACEHOLDER_REASON = "binary body omitted in placeholder test mode";

const TEXT_EXTENSIONS = new Set([
  ".asm",
  ".c",
  ".cc",
  ".cfg",
  ".cmake",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".dart",
  ".fs",
  ".fsx",
  ".go",
  ".gradle",
  ".groovy",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ics",
  ".ini",
  ".ipynb",
  ".java",
  ".js",
  ".json",
  ".kt",
  ".kts",
  ".log",
  ".lua",
  ".m",
  ".md",
  ".mem",
  ".php",
  ".pl",
  ".py",
  ".qsf",
  ".r",
  ".rb",
  ".rst",
  ".rs",
  ".s",
  ".sh",
  ".sdc",
  ".sv",
  ".svh",
  ".sql",
  ".sol",
  ".srt",
  ".swift",
  ".tcl",
  ".tex",
  ".toml",
  ".ts",
  ".tsv",
  ".txt",
  ".ucf",
  ".v",
  ".vb",
  ".vhd",
  ".vhdl",
  ".vh",
  ".vtt",
  ".xdc",
  ".xml",
  ".yaml",
  ".yml",
]);
const TEXT_BASENAMES = new Set(["cmakelists.txt", "dockerfile", "gemfile", "makefile", "rakefile"]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fileNameParts(value) {
  const baseName = String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  const dot = baseName.lastIndexOf(".");
  return {
    baseName,
    extension: dot > 0 ? baseName.slice(dot) : "",
  };
}

function isTextLikeFile(file) {
  const mimeType = String(file?.mimeType || file?.contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (mimeType.startsWith("text/")) return true;
  if (/^(?:application\/(?:json|ld\+json|xml|xhtml\+xml|javascript|x-javascript))$/.test(mimeType)) {
    return true;
  }
  const { baseName, extension } = fileNameParts(file?.fileName || file?.name || "");
  return TEXT_EXTENSIONS.has(extension) || TEXT_BASENAMES.has(baseName);
}

function needsPlaceholder(downloadMode, file) {
  return downloadMode === "placeholder" && !isTextLikeFile(file);
}

function isFileDownloadMarker(record) {
  // Earlier manifests can omit these flags after mistakenly reusing a marker.
  return [record?.path, record?.fileName].some((value) =>
    /\.(?:placeholder|unresolved)(?: \((?:legacy )?\d+\))*\.json$/i.test(
      fileNameParts(value).baseName
    )
  );
}

function isReusableFileDownload(record) {
  return Boolean(record) && record.placeholder !== true && record.unresolved !== true &&
    record.linkOnly !== true && !isFileDownloadMarker(record);
}

function evaluateReportedSize({ actualSize, allowMismatch, file, fileName, label }) {
  const reportedSize = finiteNumber(file.fileSize);
  if (reportedSize === null || reportedSize === actualSize) {
    return {
      fields: { expectedSize: reportedSize, reportedSize, sizeMismatchAccepted: false },
      warning: null,
    };
  }
  if (!allowMismatch) {
    throw new Error(`Downloaded ${actualSize} bytes; Blackboard reported ${reportedSize} bytes`);
  }
  return {
    fields: { expectedSize: null, reportedSize, sizeMismatchAccepted: true },
    warning: {
      label,
      warning:
        `${fileName}: downloaded ${actualSize} bytes, while Blackboard metadata reports ` +
        `${reportedSize}; valid attachment response retained`,
    },
  };
}

function resolutionFields(file) {
  return file.resolutionMethod ? { resolutionMethod: file.resolutionMethod } : {};
}

module.exports = {
  DEFAULT_PLACEHOLDER_REASON,
  evaluateReportedSize,
  finiteNumber,
  isFileDownloadMarker,
  isReusableFileDownload,
  isTextLikeFile,
  needsPlaceholder,
  resolutionFields,
};
