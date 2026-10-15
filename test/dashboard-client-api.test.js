const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../dashboard/client/src/lib/api.ts"), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Error, AbortController, Headers, FormData, Blob, URLSearchParams, ArrayBuffer,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      const request = { ...deferred(), url, options };
      requests.push(request);
      return request.promise;
    },
  });
  return { ...module.exports, requests, timers };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("API encodes JSON while preserving Headers instances and clears its deadline", async () => {
  const { api, requests, timers } = harness();
  const result = api("/api/settings", { method: "POST", body: { concurrency: 2 }, headers: new Headers({ "X-Test": "yes" }) });
  assert.equal(requests[0].options.headers.get("X-Test"), "yes");
  assert.equal(requests[0].options.headers.get("Content-Type"), "application/json");
  assert.equal(requests[0].options.body, '{"concurrency":2}');
  assert.equal([...timers.values()][0].delay, 30_000);
  requests[0].resolve(jsonResponse({ saved: true }));
  assert.equal((await result).saved, true);
  assert.equal(timers.size, 0);
});

test("API preserves string and multipart request bodies", async () => {
  for (const body of ["plain request", new FormData()]) {
    const { api, requests } = harness();
    const result = api("/api/test", { method: "POST", body });
    assert.equal(requests[0].options.body, body);
    assert.equal(requests[0].options.headers.has("Content-Type"), false);
    requests[0].resolve(new Response(null, { status: 204 }));
    assert.equal(await result, null);
  }
});

for (const phase of ["headers", "body"]) {
  test(`API deadline covers stalled response ${phase} without retrying a mutation`, async () => {
    const { api, requests, timers } = harness();
    const result = api("/api/fetch", { method: "POST", timeoutMs: 100 });
    if (phase === "body") {
      requests[0].resolve({ ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) });
      await Promise.resolve();
    }
    [...timers.values()][0].callback();
    await assert.rejects(result, /timed out.*may still be running.*check its status/);
    assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(requests.length, 1);
    assert.equal(timers.size, 0);
  });
}

test("caller cancellation aborts its request and removes the timeout", async () => {
  const { api, requests, timers } = harness();
  const controller = new AbortController();
  const result = api("/api/courses", { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(timers.size, 0);
});

test("an already cancelled request never sends a network request", async () => {
  const { api, requests } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api("/api/courses", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(requests.length, 0);
});

test("API explains network failure and never retries a mutation", async () => {
  const { api, requests } = harness();
  const result = api("/api/fetch", { method: "POST" });
  requests[0].reject(new TypeError("Failed to fetch"));
  await assert.rejects(result, /local dashboard server.*may still be running/);
  assert.equal(requests.length, 1);
});

test("API reports an interrupted response body and clears its deadline", async () => {
  const { api, requests, timers } = harness();
  const result = api("/api/courses");
  requests[0].resolve({ text: async () => { throw new TypeError("Connection reset"); } });
  await assert.rejects(result, /response was interrupted/);
  assert.equal(timers.size, 0);
});

test("invalid request serialization does not leave an abort timer or send a request", async () => {
  const { api, requests, timers } = harness();
  const body = {};
  body.self = body;
  await assert.rejects(api("/api/test", { method: "POST", body }), /circular/i);
  assert.equal(requests.length, 0);
  assert.equal(timers.size, 0);
});

test("API reports structured errors and hides HTML error pages", async () => {
  for (const [response, expected] of [
    [jsonResponse({ error: "A batch is already running." }, 409), /A batch is already running/],
    [new Response("<html>Internal trace with private fields</html>", { status: 502, headers: { "content-type": "text/html" } }), /^Dashboard request failed with HTTP 502\./],
    [new Response("{broken", { status: 500, headers: { "content-type": "application/json" } }), /HTTP 500/],
  ]) {
    const { api, requests } = harness();
    const result = api("/api/test");
    requests[0].resolve(response);
    await assert.rejects(result, (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private fields|<html>|\{broken/);
      return true;
    });
  }
});

test("API reports malformed JSON while text previews preserve the original file", async () => {
  const { api, requestText, requests } = harness();
  const result = api("/api/test");
  requests[0].resolve(new Response("{broken", { headers: { "content-type": "application/json" } }));
  await assert.rejects(result, /invalid JSON response/);
  const preview = requestText("/api/files/backup.json");
  requests[1].resolve(new Response("{broken", { headers: { "content-type": "application/json" } }));
  assert.equal(await preview, "{broken");
});

test("API rejects successful HTML and plaintext responses without exposing their contents", async () => {
  for (const contentType of ["text/html", "text/plain"]) {
    const { api, requestText, requests, timers } = harness();
    const body = contentType === "text/html" ? "<html>Unexpected login page</html>" : "Unexpected server response";
    const result = api("/api/bootstrap");
    requests[0].resolve(new Response(body, { headers: { "content-type": contentType } }));
    await assert.rejects(result, (error) => {
      assert.match(error.message, /unexpected response instead of JSON.*local dashboard server/i);
      assert.equal(error.message.includes(body), false);
      return true;
    });
    assert.equal(timers.size, 0);
    const preview = requestText("/api/files/example.txt");
    requests[1].resolve(new Response(body, { headers: { "content-type": contentType } }));
    assert.equal(await preview, body);
  }
});
