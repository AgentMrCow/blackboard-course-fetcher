const path = require("path");
const { mimeType } = require("../../../domain/archive/archive-metadata");
const { httpError } = require("../../../shared/http-error");
const { serveStaticFile } = require("../file-responses");

class StaticHttpController {
  constructor({ paths, serveFile = serveStaticFile }) {
    if (!paths) throw new TypeError("StaticHttpController requires paths");
    this.paths = paths;
    this.serveFile = serveFile;
  }

  async handle({ pathname, request, response }) {
    if (pathname.startsWith("/assets/")) {
      const file = path.resolve(this.paths.publicDirectory, pathname.slice(1));
      if (!file.startsWith(`${this.paths.publicDirectory}${path.sep}`)) throw httpError(400, "Invalid asset path");
      this.serve(file, response, false);
      return true;
    }
    if (request.method === "GET") {
      this.serve(path.join(this.paths.publicDirectory, "index.html"), response, false);
      return true;
    }
    return false;
  }

  serve(file, response, cache) {
    return this.serveFile({ response, file, cache, mimeType });
  }
}

module.exports = { StaticHttpController };
