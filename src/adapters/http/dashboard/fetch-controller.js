const { readJsonBody } = require("../request-body");
const { sendJson } = require("../responses");

class FetchHttpController {
  constructor({ readBody = readJsonBody, workspace }) {
    if (!workspace) throw new TypeError("FetchHttpController requires a workspace");
    this.readBody = readBody;
    this.workspace = workspace;
  }

  async handle({ pathname, request, response }) {
    const method = request.method;
    if (pathname === "/api/jobs" && method === "GET") {
      sendJson(response, 200, { jobs: this.workspace.jobsSnapshot() });
      return true;
    }
    if (pathname === "/api/fetch" && method === "POST") {
      sendJson(response, 202, this.workspace.startFetch(await this.readBody(request)));
      return true;
    }
    let match = pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|cancel)$/);
    if (match && method === "POST") {
      sendJson(response, 200, this.workspace.controlFetchBatch(match[1], match[2]));
      return true;
    }
    match = pathname.match(/^\/api\/jobs\/([^/]+)\/tasks\/([^/]+)\/(pause|resume|cancel)$/);
    if (match && method === "POST") {
      sendJson(response, 200, this.workspace.controlFetchTask(match[1], match[2], match[3]));
      return true;
    }
    return false;
  }
}

module.exports = { FetchHttpController };
