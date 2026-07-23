const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  streamResponseToTempFile,
} = require("../src/adapters/filesystem/blackboard-download-stream");

test("streams a response while recording its size, prefix, and SHA-256", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bb-stream-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const chunks = [Buffer.alloc(180, "a"), Buffer.alloc(260, "b"), Buffer.from("tail")];
  const payload = Buffer.concat(chunks);
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const result = await streamResponseToTempFile(new Response(body), directory, "large.bin");

  assert.equal(result.size, payload.length);
  assert.deepEqual(result.head, payload.subarray(0, 300));
  assert.equal(result.sha256, crypto.createHash("sha256").update(payload).digest("hex"));
  assert.deepEqual(fs.readFileSync(result.temporaryPath), payload);
  assert.match(path.basename(result.temporaryPath), /^\.large\.bin\.part-/);
});

test("removes the partial file when the response stream fails", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bb-stream-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("partial"));
      controller.error(new Error("connection reset"));
    },
  });

  await assert.rejects(
    streamResponseToTempFile(new Response(body), directory, "broken.bin"),
    /connection reset/
  );
  assert.deepEqual(fs.readdirSync(directory), []);
});
