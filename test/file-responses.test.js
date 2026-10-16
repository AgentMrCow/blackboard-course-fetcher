const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { PassThrough, Readable } = require("stream");
const test = require("node:test");
const { serveArchiveFile, serveStaticFile } = require("../src/adapters/http/file-responses");
const { mimeType } = require("../src/domain/archive/archive-metadata");

async function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-file-response-"));
  const failures = [];
  const server = http.createServer((request, response) => {
    const file = path.join(root, new URL(request.url, "http://localhost").pathname.slice(1));
    serveArchiveFile({ request, response, file, mimeType }).catch((error) => {
      failures.push(error);
      if (!response.headersSent) { response.writeHead(error.statusCode || 500); response.end(error.message); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, failures, url: `http://127.0.0.1:${server.address().port}` };
}

test("all archived document responses sandbox active SVG and XML while preserving MIME and byte ranges", async (context) => {
  const { root, url } = await fixture(context);
  for (const name of ["active.svg", "active.xml", "page.html", "photo.png", "document.pdf"]) {
    fs.writeFileSync(path.join(root, name), "0123456789");
    const response = await fetch(`${url}/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mimeType(name));
    assert.match(response.headers.get("content-security-policy"), /^sandbox;/);
    assert.doesNotMatch(response.headers.get("content-security-policy"), /allow-scripts|allow-same-origin/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "0123456789");
  }
  const range = await fetch(`${url}/active.svg`, { headers: { Range: "bytes=2-5" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
  assert.match(range.headers.get("content-security-policy"), /^sandbox;/);
  assert.equal(await range.text(), "2345");
  const head = await fetch(`${url}/active.svg`, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${url}/active.svg`, { headers: { Range: "bytes=99-" } })).status, 416);
});

test("missing and unreadable opens reject before headers without exposing paths", async (context) => {
  const { url, failures } = await fixture(context);
  const missing = await fetch(`${url}/missing.txt`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Archive file not found");
  assert.equal(failures.length, 1);
  context.mock.method(fs.promises, "open", async () => { throw Object.assign(new Error("private path"), { code: "EACCES" }); });
  for (const serve of [serveArchiveFile, serveStaticFile]) {
    await assert.rejects(() => serve({ request: { headers: {}, method: "GET" }, response: {}, file: "private", mimeType }),
      (error) => error.statusCode === 403 && error.message === "File cannot be read");
  }
});

test("stream read failures close only the affected response and release the descriptor", async (context) => {
  let closes = 0;
  context.mock.method(fs.promises, "open", async () => ({
    stat: async () => ({ isFile: () => true, size: 20 }),
    createReadStream: () => new Readable({ read() { this.destroy(Object.assign(new Error("read failed"), { code: "EIO" })); } }),
    close: async () => { closes += 1; },
  }));
  for (const serve of [serveArchiveFile, serveStaticFile]) {
    const response = new PassThrough();
    response.writeHead = () => {};
    response.resume();
    await serve({ request: { headers: {}, method: "GET" }, response, file: "fake.txt", mimeType });
    assert.equal(response.destroyed, true);
  }
  assert.equal(closes, 2);
});

test("client disconnects destroy the source and release the descriptor", async (context) => {
  let closed = false;
  const source = new PassThrough();
  context.mock.method(fs.promises, "open", async () => ({
    stat: async () => ({ isFile: () => true, size: 100 }),
    createReadStream: () => source,
    close: async () => { closed = true; },
  }));
  const response = new PassThrough();
  response.writeHead = () => {};
  const serving = serveArchiveFile({ request: { headers: {}, method: "GET" }, response, file: "fake.txt", mimeType });
  setImmediate(() => response.destroy());
  await serving;
  assert.equal(source.destroyed, true);
  assert.equal(closed, true);
});

test("an archive changed between resolution and opening sends no bytes", async (context) => {
  const { root } = await fixture(context);
  const file = path.join(root, "notes.txt");
  fs.writeFileSync(file, "private");
  let headersSent = false;
  const response = new PassThrough();
  response.writeHead = () => { headersSent = true; };
  await assert.rejects(() => serveArchiveFile({ request: { headers: {}, method: "GET" }, response, file, mimeType,
    validateFile: () => {
      fs.renameSync(file, path.join(root, "original.txt"));
      fs.writeFileSync(file, "replacement");
      return file;
    },
  }), (error) => error.statusCode === 409);
  assert.equal(headersSent, false);
  response.destroy();
});
