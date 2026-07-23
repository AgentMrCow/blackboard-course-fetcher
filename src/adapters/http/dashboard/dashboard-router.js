const { httpError } = require("../../../shared/http-error");
const { assertLocalRequestHost, assertMutationOrigin } = require("../security");

class DashboardRouter {
  constructor({
    controllers,
    hostGuard = assertLocalRequestHost,
    mutationGuard = assertMutationOrigin,
  }) {
    if (!Array.isArray(controllers) || !controllers.length) {
      throw new TypeError("DashboardRouter requires at least one controller");
    }
    this.controllers = controllers;
    this.hostGuard = hostGuard;
    this.mutationGuard = mutationGuard;
  }

  async route(request, response) {
    this.hostGuard(request);
    this.mutationGuard(request);
    const url = new URL(request.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const context = { pathname, request, response, url };
    for (const controller of this.controllers) {
      if (await controller.handle(context)) return;
    }
    throw httpError(404, "Route not found");
  }
}

module.exports = { DashboardRouter };
