const fs = require("fs");
const path = require("path");
const { parseByteRange } = require("./responses");

function serveArchiveFile({ request, response, file, download, mimeType }) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw Object.assign(new Error("Archive file not found"), { statusCode: 404 });
  }
  const stat = fs.statSync(file);
  const headers = {
    "Content-Type": mimeType(file),
    "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
  };
  if ([".html", ".htm"].includes(path.extname(file).toLowerCase())) {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; media-src 'self' data:; connect-src 'none'; frame-src 'none';";
  }
  const range = parseByteRange(request.headers.range, stat.size);
  if (range) {
    if (!range.valid) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    const { start, end } = range;
    response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` });
    if (request.method === "HEAD") return response.end();
    fs.createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (request.method === "HEAD") return response.end();
  fs.createReadStream(file).pipe(response);
}

function serveStaticFile({ response, file, cache = false, mimeType }) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw Object.assign(new Error("Page not found"), { statusCode: 404 });
  }
  const stat = fs.statSync(file);
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
  fs.createReadStream(file).pipe(response);
}

module.exports = { serveArchiveFile, serveStaticFile };
