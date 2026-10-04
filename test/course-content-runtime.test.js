const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createArchiveLayout, sanitizePart } = require("../src/adapters/filesystem/blackboard-archive-layout");
const { isLtiHandler, ltiDetail, requiresAssessmentArchive } = require("../src/domain/course-fetch/blackboard-lti-policy");
const { finiteNumber } = require("../src/domain/course-fetch/course-file-policy");

// Execute the production content traversal/export functions without starting
// the CLI, reading a real session, or contacting Blackboard/browser gateways.
const runtime = fs.readFileSync(path.join(__dirname, "../src/composition/course-fetch-runtime.js"), "utf8");
function functionSource(start, end) {
  const offset = runtime.indexOf(start);
  assert.ok(offset >= 0);
  const boundary = runtime.indexOf(end, offset + start.length);
  assert.ok(boundary > offset);
  return runtime.slice(offset, boundary);
}

function harness(context, items, children = {}, previousContents = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackboard-content-runtime-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveLayout = createArchiveLayout(root, { previousContents });
  const manifest = { contents: [], downloads: [], warnings: [], errors: [] };
  const byId = new Map(items.map((item) => [item.id, item]));
  const sandbox = {
    fs, path, finiteNumber, sanitizePart, archiveLayout, manifest,
    OUT_ROOT: root, COURSE_ID: "_course_1", pendingExternalLinks: [],
    dirForItem: archiveLayout.directoryForItem,
    isLtiHandler, ltiDetail,
    isContainer: (item) => item.contentHandler === "resource/x-bb-folder",
    isDocument: (item) => item.contentHandler === "resource/x-bb-document",
    isKnownHandler: () => true,
    getExternalLinkDetail: (item) => item.contentDetail?.["resource/x-bb-externallink"],
    getAssessmentDetail: () => null,
    emitProgress: () => {},
    inlineContentAttachments: () => [],
    mergeAttachments: (left, right) => [...left, ...right],
    stabilizeAttachment: (item) => item,
    contentAttachmentRecord: (item) => item,
    associateContentAttachmentDownloads: () => {},
    discoverContentApiAttachments: async () => ({ complete: true, attachments: [] }),
    bbJson: async (url) => {
      const id = /\/contents\/([^/?]+)/.exec(url)?.[1];
      assert.ok(byId.has(id), `Unexpected synthetic detail request: ${url}`);
      return byId.get(id);
    },
    getAllPages: async (url) => {
      const id = /\/contents\/([^/?]+)\/children/.exec(url)?.[1];
      assert.ok(id, `Unexpected synthetic child request: ${url}`);
      return children[id] || [];
    },
    ensureDir: (directory) => fs.mkdirSync(directory, { recursive: true }),
    writeText: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    archivePath: (file) => path.relative(root, file),
    sha256File: (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    htmlPage: (_title, body) => body,
    stripHtml: (html) => html.replace(/<[^>]+>/g, ""),
    escapeHtml: (html) => html,
    absUrl: (url) => new URL(url, "https://blackboard.example.edu").href,
    downloadAttachments: async (attachments) => assert.equal(attachments.length, 0),
    saveCourseFile: async () => {},
    saveBodyAttachments: async () => {},
    saveAssessment: async () => {},
    saveLtiContent: async () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext([
    functionSource("async function saveDocument(", "async function saveExternalLink("),
    functionSource("async function saveExternalLink(", "function summarizedLtiDetail("),
    functionSource("async function processItem(", "async function main("),
  ].join("\n"), sandbox);
  return { root, manifest, processItem: sandbox.processItem };
}

test("production traversal keeps duplicate-title documents and links in their allocated folders", async (context) => {
  const documents = ["a", "b"].map((id) => ({
    id, title: "Notes", contentHandler: "resource/x-bb-document", body: { displayText: `<p>body-${id}</p>` },
  }));
  const links = ["a", "b"].map((id) => ({
    id: `link-${id}`, title: id === "a" ? "Practice Test" : "Practice test",
    contentHandler: "resource/x-bb-externallink",
    contentDetail: { "resource/x-bb-externallink": { url: `https://${id}.example.edu/test` } },
  }));
  const { root, manifest, processItem } = harness(context, [...documents, ...links]);
  for (const item of [...documents, ...links]) await processItem(item, [], { id: "_student_1" });
  const directories = manifest.contents.map((item) => item.directory.normalize("NFKC").toLowerCase());
  assert.equal(new Set(directories).size, 4);
  for (const item of documents) {
    const record = manifest.contents.find((record) => record.id === item.id);
    assert.equal(fs.readFileSync(path.join(root, record.directory, "document.html"), "utf8"), item.body.displayText);
    assert.equal(fs.readFileSync(path.join(root, record.directory, "document.txt"), "utf8"), `body-${item.id}`);
  }
  for (const item of links) {
    const download = manifest.downloads.find((download) => download.sourceUrl === item.contentDetail[item.contentHandler].url);
    const record = manifest.contents.find((record) => record.id === item.id);
    assert.equal(path.dirname(download.path), record.directory);
    assert.match(fs.readFileSync(path.join(root, download.path), "utf8"), new RegExp(`https://${item.id.slice(-1)}\\.example\\.edu/test`));
  }
  assert.equal(manifest.errors.length, 0);
});

test("production traversal propagates parent IDs even when Blackboard summaries omit them", async (context) => {
  const folders = ["a", "b"].map((id) => ({ id, title: "Week", contentHandler: "resource/x-bb-folder" }));
  const documents = ["a", "b"].map((id) => ({
    id: `${id}-doc`, title: "Notes", contentHandler: "resource/x-bb-document", body: { displayText: id },
  }));
  const { root, manifest, processItem } = harness(context, [...folders, ...documents], { a: [documents[0]], b: [documents[1]] });
  for (const folder of folders) await processItem(folder, [], { id: "_student_1" });
  for (const folder of folders) {
    const parent = manifest.contents.find((item) => item.id === folder.id);
    const child = manifest.contents.find((item) => item.id === `${folder.id}-doc`);
    assert.equal(child.parentId, folder.id);
    assert.equal(path.dirname(child.directory), parent.directory);
    assert.equal(fs.readFileSync(path.join(root, child.directory, "document.txt"), "utf8"), folder.id);
  }
});

test("production records retain grading-column evidence for LTI assessment auditing", async (context) => {
  const items = [null, "_grade_1"].map((columnId, index) => ({
    id: `lti-${index}`, title: `Tool ${index}`, contentHandler: "resource/x-bb-blti-link",
    contentDetail: { "resource/x-bb-blti-link": {
      url: "https://tools.example.edu/launch",
      ...(columnId ? { gradingColumn: { id: columnId } } : {}),
    } },
  }));
  const { manifest, processItem } = harness(context, items);
  for (const item of items) await processItem(item, [], { id: "_student_1" });
  assert.equal(manifest.contents[0].gradingColumnId, null);
  assert.equal(manifest.contents[1].gradingColumnId, "_grade_1");
  assert.equal(requiresAssessmentArchive(manifest.contents[0]), false);
  assert.equal(requiresAssessmentArchive(manifest.contents[1]), true);
});
