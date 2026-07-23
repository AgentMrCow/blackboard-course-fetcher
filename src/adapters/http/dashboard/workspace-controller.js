const { readJsonBody } = require("../request-body");
const { sendJson } = require("../responses");

class WorkspaceHttpController {
  constructor({ clock = () => new Date(), eventHub, readBody = readJsonBody, workspace }) {
    if (!eventHub) throw new TypeError("WorkspaceHttpController requires an eventHub");
    if (!workspace) throw new TypeError("WorkspaceHttpController requires a workspace");
    this.clock = clock;
    this.eventHub = eventHub;
    this.readBody = readBody;
    this.workspace = workspace;
  }

  async handle({ pathname, request, response, url }) {
    const method = request.method;
    if (pathname === "/api/events" && method === "GET") {
      this.eventHub.connect(request, response);
      return true;
    }
    if (pathname === "/api/bootstrap" && method === "GET") {
      sendJson(response, 200, await this.workspace.bootstrap({ refresh: url.searchParams.get("refresh") === "1" }));
      return true;
    }
    if (pathname === "/api/health" && method === "GET") {
      sendJson(response, 200, { ok: true, at: this.clock().toISOString() });
      return true;
    }
    if (pathname === "/api/settings" && method === "POST") {
      sendJson(response, 200, this.workspace.saveSettings(await this.readBody(request)));
      return true;
    }
    if (pathname === "/api/auth/check" && method === "POST") {
      sendJson(response, 200, await this.workspace.checkAuthentication());
      return true;
    }
    if (pathname === "/api/auth/start" && method === "POST") {
      sendJson(response, 202, this.workspace.startAuth());
      return true;
    }
    if (pathname === "/api/auth/save" && method === "POST") {
      sendJson(response, 202, this.workspace.saveAuth());
      return true;
    }
    if (pathname === "/api/auth/cancel" && method === "POST") {
      sendJson(response, 200, this.workspace.cancelAuth());
      return true;
    }
    if (pathname === "/api/inventory" && method === "POST") {
      sendJson(response, 202, this.workspace.startInventory());
      return true;
    }
    if (pathname === "/api/inventory/cancel" && method === "POST") {
      sendJson(response, 200, this.workspace.cancelInventory());
      return true;
    }
    return false;
  }
}

module.exports = { WorkspaceHttpController };
