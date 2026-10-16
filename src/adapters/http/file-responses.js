const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { httpError } = require("../../shared/http-error");
const { parseByteRange } = require("./responses");

async function openFile(file, missingMessage) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw httpError(404, missingMessage);
    return { handle, stat };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.statusCode) throw error;
    if (["ENOENT", "ENOTDIR"].includes(error.code)) throw httpError(404, missingMessage);
    if (["EACCES", "EPERM"].includes(error.code)) throw httpError(403, "File cannot be read");
    throw httpError(500, "File could not be opened");
  }
}

async function streamFile(handle, response, options = {}) {
  // pipeline attaches error handlers to both ends and destroys the source on a
  // client disconnect. A failed stream ends only its own response, not the server.
  try {
    if (!response.destroyed) await pipeline(handle.createReadStream({ ...options, autoClose: false }), response);
  } catch {
    if (!response.destroyed) response.destroy();
  }
}

async function serveArchiveFile({ request, response, file, download, mimeType, validateFile }) {
  const { handle, stat } = await openFile(file, "Archive file not found");
  try {
    if (response.destroyed) return;
    if (validateFile) {
      // Re-resolve containment after opening, then verify the descriptor still
      // represents that safe path before any bytes or headers are sent.
      const validated = await validateFile();
      let current;
      try { current = await fs.promises.stat(validated); }
      catch { throw httpError(409, "Archive file changed while it was being opened. Try again."); }
      if (validated !== file || current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile()) {
        throw httpError(409, "Archive file changed while it was being opened. Try again.");
      }
    }
    const headers = {
      "Content-Type": mimeType(file),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      // Every archived document is untrusted, including SVG, XML and less common
      // active formats. Sandboxing the response also protects direct navigation.
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';",
    };
    const range = parseByteRange(request.headers.range, stat.size);
    if (range && !range.valid) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    if (range) {
      const { start, end } = range;
      response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` });
      if (request.method === "HEAD") return response.end();
      await streamFile(handle, response, { start, end });
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (request.method === "HEAD") return response.end();
    await streamFile(handle, response);
  } finally { await handle.close().catch(() => {}); }
}

async function serveStaticFile({ response, file, cache = false, mimeType }) {
  const { handle, stat } = await openFile(file, "Page not found");
  try {
    if (response.destroyed) return;
    response.writeHead(200, {
      "Content-Type": mimeType(file),
      "Content-Length": stat.size,
      "Cache-Control": cache ? "public, max-age=86400" : "no-cache",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    await streamFile(handle, response);
  } finally { await handle.close().catch(() => {}); }
}

module.exports = { serveArchiveFile, serveStaticFile };
