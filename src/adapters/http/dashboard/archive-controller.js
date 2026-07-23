const { mimeType } = require("../../../domain/archive/archive-metadata");
const { serveArchiveFile } = require("../file-responses");
const { sendJson } = require("../responses");

class ArchiveHttpController {
  constructor({ serveFile = serveArchiveFile, workspace }) {
    if (!workspace) throw new TypeError("ArchiveHttpController requires a workspace");
    this.serveFile = serveFile;
    this.workspace = workspace;
  }

  async handle({ pathname, request, response, url }) {
    const method = request.method;
    if (pathname === "/api/courses" && method === "GET") {
      sendJson(response, 200, this.workspace.courseInventory());
      return true;
    }
    if (pathname === "/api/summary" && method === "GET") {
      sendJson(response, 200, this.workspace.archiveSummary());
      return true;
    }
    if (pathname === "/api/search" && method === "GET") {
      sendJson(response, 200, {
        results: this.workspace.searchArchive(url.searchParams.get("q"), {
          courseId: url.searchParams.get("courseId"),
          limit: url.searchParams.get("limit"),
        }),
      });
      return true;
    }
    if (pathname === "/api/files" && method === "GET") {
      sendJson(response, 200, this.workspace.listArchiveFiles({
        query: url.searchParams.get("q"),
        preview: url.searchParams.get("preview"),
        scope: url.searchParams.get("scope"),
        courseId: url.searchParams.get("courseId"),
        offset: url.searchParams.get("offset"),
        limit: url.searchParams.get("limit"),
      }));
      return true;
    }
    let match = pathname.match(/^\/api\/courses\/([^/]+)$/);
    if (match && method === "GET") {
      sendJson(response, 200, this.workspace.courseDetails(match[1]));
      return true;
    }
    match = pathname.match(/^\/api\/courses\/([^/]+)\/file$/);
    if (match && ["GET", "HEAD"].includes(method)) {
      const resolved = this.workspace.resolveArchiveFile(match[1], url.searchParams.get("path"));
      this.serveFile({
        request,
        response,
        file: resolved.file,
        download: url.searchParams.get("download") === "1",
        mimeType,
      });
      return true;
    }
    return false;
  }
}

module.exports = { ArchiveHttpController };
