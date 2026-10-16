export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
  currentLine: number | null;
  savedLine: number | null;
}

// Limits protect the browser from large or highly fragmented archived text.
const MAX_LINES = 600;
const MAX_CHARACTERS = 100_000;
const MAX_CELLS = 180_000;

function lines(value: string): { values: string[]; truncated: boolean } {
  const bounded = value.slice(0, MAX_CHARACTERS).replace(/\r\n?/g, "\n");
  const values = bounded ? bounded.split("\n") : [];
  return { values: values.slice(0, MAX_LINES), truncated: value.length > MAX_CHARACTERS || values.length > MAX_LINES };
}

export function formatComparisonText(filePath: string, value: string): string {
  if (!filePath.toLowerCase().endsWith(".json") || value.length > MAX_CHARACTERS) return value;
  // Validate syntax, but never serialize the parsed value: that would round
  // large numbers, discard duplicate keys, and rewrite escaped strings.
  try { JSON.parse(value); } catch { return value; }
  const tokens = value.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || [];
  const chunks: string[] = [];
  let length = 0;
  let depth = 0;
  const append = (text: string) => {
    if (length + text.length > MAX_CHARACTERS) return false;
    chunks.push(text);
    length += text.length;
    return true;
  };
  const newline = () => {
    const indentation = depth * 2;
    if (length + indentation + 1 > MAX_CHARACTERS) return false;
    return append(`\n${" ".repeat(indentation)}`);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "{" || token === "[") {
      if (!append(token)) return value;
      depth += 1;
      if (tokens[index + 1] !== (token === "{" ? "}" : "]") && !newline()) return value;
    } else if (token === "}" || token === "]") {
      depth -= 1;
      if (tokens[index - 1] !== (token === "}" ? "{" : "[") && !newline()) return value;
      if (!append(token)) return value;
    } else if (token === ",") {
      if (!append(token) || !newline()) return value;
    } else if (!append(token === ":" ? ": " : token)) return value;
  }
  return chunks.join("");
}

// Direction is current -> saved, so '+' means a line recovered from the backup.
export function buildRecoveryDiff(current: string, saved: string) {
  const left = lines(current);
  const right = lines(saved);
  const a = left.values;
  const b = right.values;
  const rows: DiffLine[] = [];
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) {
    rows.push({ kind: "same", text: a[first], currentLine: first + 1, savedLine: first + 1 });
    first += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > first && endB > first && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const width = endB - first + 1;
  const height = endA - first + 1;
  const simplified = width * height > MAX_CELLS;
  if (simplified) {
    for (let i = first; i < endA; i += 1) rows.push({ kind: "removed", text: a[i], currentLine: i + 1, savedLine: null });
    for (let j = first; j < endB; j += 1) rows.push({ kind: "added", text: b[j], currentLine: null, savedLine: j + 1 });
  } else {
    const lengths = new Uint16Array(width * height);
    for (let i = height - 2; i >= 0; i -= 1) {
      for (let j = width - 2; j >= 0; j -= 1) {
        lengths[i * width + j] = a[first + i] === b[first + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = first;
    let j = first;
    while (i < endA || j < endB) {
      if (i < endA && j < endB && a[i] === b[j]) {
        rows.push({ kind: "same", text: a[i], currentLine: ++i, savedLine: ++j });
      } else if (i < endA && (j === endB || lengths[(i - first + 1) * width + j - first] >= lengths[(i - first) * width + j - first + 1])) {
        rows.push({ kind: "removed", text: a[i], currentLine: ++i, savedLine: null });
      } else {
        rows.push({ kind: "added", text: b[j], currentLine: null, savedLine: ++j });
      }
    }
  }
  for (let i = endA, j = endB; i < a.length && j < b.length; i += 1, j += 1) {
    rows.push({ kind: "same", text: a[i], currentLine: i + 1, savedLine: j + 1 });
  }
  return { rows, truncated: left.truncated || right.truncated, simplified };
}
