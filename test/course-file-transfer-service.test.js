const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { CourseFileTransferService } = require("../src/application/course-fetch/course-file-transfer-service");
const { createCourseFileStore } = require("../src/adapters/filesystem/course-file-store");
const {
  filenameFromContentDisposition,
  isOpaqueBlackboardFilename,
} = require("../src/domain/course-fetch/blackboard-attachment-policy");
const {
  streamResponseToTempFile,
} = require("../src/adapters/filesystem/blackboard-download-stream");

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "course-file-transfer-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function manifest() {
  return {
    generatedAt: "2026-07-23T10:00:00.000Z",
    downloads: [],
    errors: [],
    warnings: [],
    transfer: {
      networkFiles: 0,
      networkBytes: 0,
      reusedFiles: 0,
      reusedBytes: 0,
      placeholderFiles: 0,
      unresolvedFiles: 0,
    },
  };
}

function service(context, options = {}) {
  const outputRoot = options.outputRoot || temporaryDirectory(context);
  const fileStore = createCourseFileStore({ cwd: outputRoot, outputRoot });
  const events = [];
  const info = [];
  const errors = [];
  const value = new CourseFileTransferService({
    client: options.client || {
      cookieHeaderFor: () => "session=expected",
      request: async () => { throw new Error("unexpected network request"); },
    },
    downloadMode: options.downloadMode || "full",
    emitTransfer: (...event) => events.push(event),
    fileStore,
    filenameFromContentDisposition,
    filenameFromUrl: (url) => path.basename(new URL(url).pathname),
    isOpaqueFilename: isOpaqueBlackboardFilename,
    logError: (message) => errors.push(message),
    logInfo: (message) => info.push(message),
    manifest: options.manifest || manifest(),
    previousDownloadsBySource: options.previousDownloadsBySource || new Map(),
    resolveUrl: (url) => new URL(url, "https://blackboard.example.edu").toString(),
    reuseValidatedCache: options.reuseValidatedCache || false,
    streamResponse: streamResponseToTempFile,
  });
  return { errors, events, fileStore, info, outputRoot, service: value };
}

test("placeholder transfer writes one file and records duplicate references", async (context) => {
  const state = manifest();
  const runtime = service(context, { downloadMode: "placeholder", manifest: state });
  const directory = path.join(runtime.outputRoot, "files");
  const file = runtime.service.prepare({
    fileName: "lecture.pdf",
    fileSize: "100",
    mimeType: "application/pdf",
    url: "/files/lecture.pdf?token=raw-token-value",
  });

  const first = await runtime.service.transfer(file, directory, "Lecture");
  const second = await runtime.service.transfer(
    runtime.service.prepare({ ...file }),
    directory,
    "Lecture duplicate"
  );

  assert.equal(first, second);
  assert.equal(state.transfer.placeholderFiles, 1);
  assert.equal(state.downloads.length, 2);
  assert.equal(state.downloads[0].placeholder, true);
  assert.equal(state.downloads[0].remoteSize, 100);
  assert.equal(state.downloads[1].duplicateReference, true);
  assert.equal(state.downloads[1].label, "Lecture duplicate");
  assert.equal(runtime.events.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(first, "utf8")), {
    schemaVersion: 1,
    placeholder: true,
    reason: "binary body omitted in placeholder test mode",
    label: "Lecture",
    originalFileName: "lecture.pdf",
    mimeType: "application/pdf",
    remoteSize: 100,
    sourceUrl: "https://blackboard.example.edu/files/lecture.pdf?token=raw-token-value",
    generatedAt: state.generatedAt,
  });
});

test("network transfer streams content and replaces an opaque Blackboard filename", async (context) => {
  const state = manifest();
  const requests = [];
  const runtime = service(context, {
    client: {
      cookieHeaderFor: () => "session=expected",
      request: async (url, options, label) => {
        requests.push({ label, options, url });
        const response = new Response("report body", {
          headers: {
            "content-disposition": "attachment; filename*=UTF-8''report.txt",
            "content-type": "text/plain",
            etag: '"etag-one"',
            "last-modified": "Thu, 23 Jul 2026 10:00:00 GMT",
          },
        });
        Object.defineProperty(response, "url", {
          value: "https://files.example.edu/report.txt?X-Amz-Signature=raw-signature",
        });
        return response;
      },
    },
    manifest: state,
  });
  const prepared = runtime.service.prepare({
    fileName: "xid-123_1",
    fileSize: 11,
    mimeType: "application/octet-stream",
    url: "/files/xid-123_1",
  });

  const result = await runtime.service.transfer(prepared, path.join(runtime.outputRoot, "files"), "Report");

  assert.equal(path.basename(result), "report.txt");
  assert.equal(fs.readFileSync(result, "utf8"), "report body");
  assert.equal(prepared.fileName, "report.txt");
  assert.equal(requests[0].options.headers.Cookie, "session=expected");
  assert.equal(requests[0].label, "file xid-123_1");
  assert.equal(state.transfer.networkFiles, 1);
  assert.equal(state.transfer.networkBytes, 11);
  assert.equal(state.downloads[0].etag, '"etag-one"');
  assert.equal(
    state.downloads[0].finalUrl,
    "https://files.example.edu/report.txt?X-Amz-Signature=raw-signature"
  );
  assert.equal(state.downloads[0].sha256, crypto.createHash("sha256").update("report body").digest("hex"));
  assert.deepEqual(runtime.events[0].slice(0, 2), ["downloaded", result]);
});

test("transfer keeps a stable source URL when the request URL is temporary", (context) => {
  const runtime = service(context);
  const prepared = runtime.service.prepare({
    fileName: "quiz.h5p",
    sourceUrl: "https://provider.example.edu/exports/quiz.h5p",
    url: "https://storage.example.edu/quiz.h5p?signature=temporary",
  });

  assert.equal(prepared.url, "https://storage.example.edu/quiz.h5p?signature=temporary");
  assert.equal(prepared.sourceUrl, "https://provider.example.edu/exports/quiz.h5p");
});

test("validated local cache reuse avoids a network request", async (context) => {
  const state = manifest();
  const outputRoot = temporaryDirectory(context);
  const directory = path.join(outputRoot, "files");
  fs.mkdirSync(directory);
  const existing = path.join(directory, "cached.txt");
  fs.writeFileSync(existing, "cached body");
  const sourceUrl = "https://blackboard.example.edu/files/cached.txt";
  const previous = {
    sourceUrl,
    path: path.join("files", "cached.txt"),
    sha256: crypto.createHash("sha256").update("cached body").digest("hex"),
    contentType: "text/plain",
    etag: '"old-etag"',
  };
  const runtime = service(context, {
    manifest: state,
    outputRoot,
    previousDownloadsBySource: new Map([[sourceUrl, previous]]),
    reuseValidatedCache: true,
  });

  const result = await runtime.service.transfer(
    runtime.service.prepare({ fileName: "cached.txt", fileSize: 11, url: sourceUrl }),
    directory,
    "Cached"
  );

  assert.equal(result, existing);
  assert.equal(state.transfer.reusedFiles, 1);
  assert.equal(state.transfer.reusedBytes, 11);
  assert.equal(state.downloads[0].cacheValidation, "local SHA-256");
  assert.deepEqual(runtime.events[0].slice(0, 2), ["reused", existing]);
});

test("full transfers download real bodies instead of reusing marker or link records", async (context) => {
  const cases = [
    { name: "placeholder flag", filename: "lecture.pdf", fields: { placeholder: true } },
    { name: "unresolved flag", filename: "lecture.pdf", fields: { unresolved: true } },
    { name: "link-only flag", filename: "lecture.url", fields: { linkOnly: true } },
    { name: "legacy placeholder path", filename: "lecture.pdf.placeholder.json", fields: {} },
    { name: "legacy unresolved version", filename: "lecture.pdf.unresolved (2).json", fields: {} },
    {
      name: "legacy placeholder filename",
      filename: "cached.json",
      fields: { fileName: "lecture.pdf.placeholder (legacy 2).json" },
    },
  ];
  for (const entry of cases) {
    for (const allowSizeMismatch of [false, true]) {
      await context.test(`${entry.name}, ${allowSizeMismatch ? "attachment" : "strict course file"}`, async (child) => {
        const state = manifest();
        const outputRoot = temporaryDirectory(child);
        const directory = path.join(outputRoot, "files");
        fs.mkdirSync(directory);
        const existing = path.join(directory, entry.filename);
        const markerBody = '{"placeholder":true,"reason":"body omitted"}';
        fs.writeFileSync(existing, markerBody);
        const sourceUrl = "https://blackboard.example.edu/files/lecture.pdf";
        const previous = {
          sourceUrl,
          path: path.join("files", entry.filename),
          sha256: crypto.createHash("sha256").update(markerBody).digest("hex"),
          etag: '"marker-etag"',
          lastModified: "Wed, 22 Jul 2026 10:00:00 GMT",
          ...entry.fields,
        };
        const body = "%PDF-1.7\nactual lecture body";
        const requests = [];
        const runtime = service(child, {
          client: {
            cookieHeaderFor: () => "session=expected",
            request: async (url, options) => {
              requests.push(options);
              if (options.headers["If-None-Match"] || options.headers["If-Modified-Since"]) {
                return new Response(null, { status: 304 });
              }
              return new Response(body, { headers: { "content-type": "application/pdf" } });
            },
          },
          manifest: state,
          outputRoot,
          previousDownloadsBySource: new Map([[sourceUrl, previous]]),
          reuseValidatedCache: true,
        });

        const result = await runtime.service.transfer(
          runtime.service.prepare({
            fileName: "lecture.pdf",
            fileSize: Buffer.byteLength(body) + (allowSizeMismatch ? 100 : 0),
            url: sourceUrl,
          }),
          directory,
          "Lecture",
          { allowSizeMismatch }
        );

        assert.equal(requests.length, 1);
        assert.equal(requests[0].headers["If-None-Match"], undefined);
        assert.equal(requests[0].headers["If-Modified-Since"], undefined);
        assert.notEqual(result, existing);
        assert.equal(fs.readFileSync(result, "utf8"), body);
        assert.equal(fs.readFileSync(existing, "utf8"), markerBody);
        assert.equal(state.transfer.networkFiles, 1);
        assert.equal(state.transfer.reusedFiles, 0);
        assert.equal(state.downloads[0].sizeMismatchAccepted, allowSizeMismatch);
        assert.equal(state.downloads[0].cacheValidated, undefined);
        assert.deepEqual(runtime.events[0].slice(0, 2), ["downloaded", result]);
      });
    }
  }
});

test("marker cache validators are ignored when local cache reuse is disabled", async (context) => {
  const state = manifest();
  const outputRoot = temporaryDirectory(context);
  const directory = path.join(outputRoot, "files");
  fs.mkdirSync(directory);
  const existing = path.join(directory, "lecture.pdf.placeholder (2).json");
  fs.writeFileSync(existing, '{"placeholder":true}');
  const sourceUrl = "https://blackboard.example.edu/files/lecture.pdf";
  const previous = {
    sourceUrl,
    path: path.relative(outputRoot, existing),
    etag: '"marker-etag"',
    lastModified: "Wed, 22 Jul 2026 10:00:00 GMT",
  };
  let headers;
  const body = "%PDF-1.7\nactual body";
  const runtime = service(context, {
    client: {
      cookieHeaderFor: () => "",
      request: async (url, options) => {
        headers = options.headers;
        return new Response(
          headers["If-None-Match"] ? null : body,
          headers["If-None-Match"] ? { status: 304 } : { headers: { "content-type": "application/pdf" } }
        );
      },
    },
    manifest: state,
    outputRoot,
    previousDownloadsBySource: new Map([[sourceUrl, previous]]),
  });

  const result = await runtime.service.transfer(
    runtime.service.prepare({ fileName: "lecture.pdf", url: sourceUrl }),
    directory,
    "Lecture",
    { allowSizeMismatch: true }
  );

  assert.equal(headers["If-None-Match"], undefined);
  assert.equal(headers["If-Modified-Since"], undefined);
  assert.equal(fs.readFileSync(result, "utf8"), body);
  assert.equal(state.transfer.reusedFiles, 0);
});

test("genuine cached binary files retain local reuse", async (context) => {
  const state = manifest();
  const outputRoot = temporaryDirectory(context);
  const directory = path.join(outputRoot, "files");
  fs.mkdirSync(directory);
  const existing = path.join(directory, "lecture.pdf");
  const body = "%PDF-1.7\nlecture body";
  fs.writeFileSync(existing, body);
  const sourceUrl = "https://blackboard.example.edu/files/lecture.pdf";
  const runtime = service(context, {
    manifest: state,
    outputRoot,
    previousDownloadsBySource: new Map([[sourceUrl, {
      path: "files/lecture.pdf",
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      contentType: "application/pdf",
    }]]),
    reuseValidatedCache: true,
  });

  const result = await runtime.service.transfer(
    runtime.service.prepare({ fileName: "lecture.pdf", fileSize: Buffer.byteLength(body), url: sourceUrl }),
    directory,
    "Lecture"
  );

  assert.equal(result, existing);
  assert.equal(state.transfer.reusedFiles, 1);
  assert.equal(state.transfer.networkFiles, 0);
  assert.equal(state.downloads[0].contentType, "application/pdf");
});

test("conditional request reuses an integrity-checked 304 response", async (context) => {
  const state = manifest();
  const outputRoot = temporaryDirectory(context);
  const directory = path.join(outputRoot, "files");
  fs.mkdirSync(directory);
  const existing = path.join(directory, "cached.txt");
  fs.writeFileSync(existing, "cached body");
  const sourceUrl = "https://blackboard.example.edu/files/cached.txt";
  const previous = {
    sourceUrl,
    path: path.join("files", "cached.txt"),
    sha256: crypto.createHash("sha256").update("cached body").digest("hex"),
    etag: '"old-etag"',
    lastModified: "Wed, 22 Jul 2026 10:00:00 GMT",
  };
  let headers;
  const runtime = service(context, {
    client: {
      cookieHeaderFor: () => "session=expected",
      request: async (url, options) => {
        headers = options.headers;
        return new Response(null, { status: 304 });
      },
    },
    manifest: state,
    outputRoot,
    previousDownloadsBySource: new Map([[sourceUrl, previous]]),
  });

  const result = await runtime.service.transfer(
    runtime.service.prepare({ fileName: "cached.txt", fileSize: 11, url: sourceUrl }),
    directory,
    "Cached"
  );

  assert.equal(result, existing);
  assert.equal(headers["If-None-Match"], '"old-etag"');
  assert.equal(headers["If-Modified-Since"], previous.lastModified);
  assert.equal(state.downloads[0].cacheValidated, true);
  assert.equal(state.transfer.reusedFiles, 1);
  assert.deepEqual(runtime.events[0].slice(0, 2), ["cached", existing]);
});

test("identical network content reuses the existing version", async (context) => {
  const state = manifest();
  const outputRoot = temporaryDirectory(context);
  const directory = path.join(outputRoot, "files");
  fs.mkdirSync(directory);
  const existing = path.join(directory, "report.txt");
  fs.writeFileSync(existing, "same content");
  const runtime = service(context, {
    client: {
      cookieHeaderFor: () => "",
      request: async () => new Response("same content", { headers: { "content-type": "text/plain" } }),
    },
    manifest: state,
    outputRoot,
  });

  const result = await runtime.service.transfer(
    runtime.service.prepare({ fileName: "report.txt", fileSize: 12, url: "/files/report.txt" }),
    directory,
    "Report"
  );

  assert.equal(result, existing);
  assert.deepEqual(fs.readdirSync(directory), ["report.txt"]);
  assert.equal(state.transfer.networkFiles, 1);
  assert.equal(state.downloads[0].contentValidated, true);
  assert.deepEqual(runtime.events[0].slice(0, 2), ["identical", existing]);
});

test("transfer accepts configured size mismatches and rejects disguised HTML", async (context) => {
  const acceptedManifest = manifest();
  const accepted = service(context, {
    client: {
      cookieHeaderFor: () => "",
      request: async () => new Response("short", { headers: { "content-type": "text/plain" } }),
    },
    manifest: acceptedManifest,
  });
  await accepted.service.transfer(
    accepted.service.prepare({ fileName: "report.txt", fileSize: 100, url: "/files/report.txt" }),
    path.join(accepted.outputRoot, "files"),
    "Report",
    { allowSizeMismatch: true }
  );
  assert.equal(acceptedManifest.warnings.length, 1);
  assert.equal(acceptedManifest.downloads[0].sizeMismatchAccepted, true);

  const rejectedManifest = manifest();
  const rejected = service(context, {
    client: {
      cookieHeaderFor: () => "",
      request: async () => new Response("<!doctype html><title>Login</title>", {
        headers: { "content-type": "text/html" },
      }),
    },
    manifest: rejectedManifest,
  });
  const rejectedDirectory = path.join(rejected.outputRoot, "files");
  await assert.rejects(
    () => rejected.service.transfer(
      rejected.service.prepare({ fileName: "report.pdf", url: "/files/report.pdf" }),
      rejectedDirectory,
      "Report"
    ),
    /Expected a file but received HTML \(text\/html\)/
  );
  assert.deepEqual(fs.readdirSync(rejectedDirectory), []);
  assert.equal(rejectedManifest.transfer.networkFiles, 1);
});

test("unresolved and failed transfers retain diagnostics without exposing orchestration", (context) => {
  const state = manifest();
  const runtime = service(context, { manifest: state });
  const prepared = runtime.service.prepare({ fileName: "missing.pdf", url: "/files/missing.pdf" });
  const output = runtime.service.writeUnresolved(
    prepared,
    path.join(runtime.outputRoot, "files"),
    "Missing",
    new Error("HTTP 404 Not Found"),
    ["outline: no exact resource match"]
  );

  assert.equal(fs.existsSync(output), true);
  assert.equal(state.transfer.unresolvedFiles, 1);
  assert.equal(state.downloads[0].unresolved, true);
  assert.match(state.errors[0].error, /authenticated UI resolution did not produce a working Blackboard URL/);
  assert.deepEqual(runtime.events[0].slice(0, 2), ["unresolved", output]);
  assert.match(runtime.errors[0], /^UNRESOLVED Missing:/);

  runtime.service.recordFailure(prepared, "Deferred", new Error("network failed"), { deferred: true });
  assert.match(runtime.errors[1], /^DEFERRED Deferred:/);
});
