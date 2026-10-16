const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../dashboard/client/src/lib/history-diff.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleExports = {};
vm.runInNewContext(code, { exports: moduleExports });
const { buildRecoveryDiff, formatComparisonText } = moduleExports;

test("recovery differences describe current-to-saved changes and preserve aligned context", () => {
  const result = buildRecoveryDiff("title\nnew grade\ncontext\nextra\nfooter", "title\nold grade\ncontext\nfooter");
  assert.deepEqual(Array.from(result.rows, (row) => [row.kind, row.text, row.currentLine, row.savedLine]), [
    ["same", "title", 1, 1], ["removed", "new grade", 2, null], ["added", "old grade", null, 2],
    ["same", "context", 3, 3], ["removed", "extra", 4, null], ["same", "footer", 5, 4],
  ]);
});

test("missing or empty files show additions/removals, with normalized line endings", () => {
  assert.ok(buildRecoveryDiff("", "saved\ntext").rows.every((row) => row.kind === "added"));
  assert.ok(buildRecoveryDiff("current", "").rows.every((row) => row.kind === "removed"));
  assert.ok(buildRecoveryDiff("a\r\nb", "a\nb").rows.every((row) => row.kind === "same"));
  assert.equal(buildRecoveryDiff("", "").rows.length, 0);
});

test("diff bounds long files and falls back to honest changed blocks for large edits", () => {
  const left = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join("\n");
  const right = Array.from({ length: 1000 }, (_, i) => `saved ${i}`).join("\n");
  const result = buildRecoveryDiff(left, right);
  assert.equal(result.truncated, true);
  assert.equal(result.simplified, true);
  assert.ok(result.rows.length <= 1200);
  assert.equal(buildRecoveryDiff("x".repeat(100001), "").truncated, true);
});

test("JSON formatting improves field comparisons without interpreting markup or changing invalid text", () => {
  assert.equal(formatComparisonText("grades.json", '{"score":80}'), '{\n  "score": 80\n}');
  assert.equal(formatComparisonText("grades.json", '<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(formatComparisonText("notes.txt", '{"score":80}'), '{"score":80}');
});

test("JSON formatting preserves large integers and numeric spellings in the recovery diff", () => {
  const current = formatComparisonText("record.json", '{"id":9007199254740992,"zero":-0,"amount":1.00,"large":1e400}');
  const saved = formatComparisonText("record.json", '{"id":9007199254740993,"zero":0,"amount":1e0,"large":1e+400}');
  assert.match(current, /9007199254740992/);
  assert.match(saved, /9007199254740993/);
  assert.match(current, /"zero": -0/);
  assert.match(current, /"amount": 1\.00/);
  assert.match(current, /"large": 1e400/);
  const changes = buildRecoveryDiff(current, saved).rows.filter((row) => row.kind !== "same");
  assert.equal(changes.filter((row) => row.kind === "removed").length, 4);
  assert.equal(changes.filter((row) => row.kind === "added").length, 4);
  assert.ok(changes.some((row) => row.kind === "added" && row.text.includes("9007199254740993")));
});

test("JSON formatting preserves duplicate fields and their original order", () => {
  const current = formatComparisonText("record.json", '{"score":1,"score":2,"2":"first","1":"second"}');
  const saved = formatComparisonText("record.json", '{"score":2,"2":"first","1":"second"}');
  assert.equal(current, '{\n  "score": 1,\n  "score": 2,\n  "2": "first",\n  "1": "second"\n}');
  const removed = buildRecoveryDiff(current, saved).rows.filter((row) => row.kind === "removed");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].text, '  "score": 1,');
});

test("JSON formatting retains escaped strings, literal punctuation, and empty containers", () => {
  const original = String.raw`{"text":"quote: \" comma: , brace: } slash: \\ newline: \n unicode: \u0041","arr":["",{},[]]}`;
  const formatted = formatComparisonText("record.json", original);
  assert.equal(formatted, String.raw`{
  "text": "quote: \" comma: , brace: } slash: \\ newline: \n unicode: \u0041",
  "arr": [
    "",
    {},
    []
  ]
}`);
  assert.deepEqual(JSON.parse(formatted), JSON.parse(original));
  for (const scalar of ["true", "false", "null", "-0", "1.00e+100", String.raw`"\ud800"`]) {
    assert.equal(formatComparisonText("scalar.json", ` \n${scalar}\t `), scalar);
  }
});

test("JSON formatting stays bounded and preserves raw input when spacing would exceed the limit", () => {
  const largeInput = JSON.stringify({ text: "x".repeat(100001) });
  assert.equal(formatComparisonText("large.json", largeInput), largeInput);
  const manyItems = `[${Array(20_000).fill("0").join(",")}]`;
  assert.equal(formatComparisonText("many.json", manyItems), manyItems);
  const deeplyNested = `${"[".repeat(10_000)}0${"]".repeat(10_000)}`;
  assert.equal(formatComparisonText("nested.json", deeplyNested), deeplyNested);
  assert.ok(buildRecoveryDiff("", formatComparisonText("large.json", largeInput)).truncated);
});
