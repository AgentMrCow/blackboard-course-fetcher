const { ArchiveHttpController } = require("../adapters/http/dashboard/archive-controller");
const { DashboardRouter } = require("../adapters/http/dashboard/dashboard-router");
const { FetchHttpController } = require("../adapters/http/dashboard/fetch-controller");
const { StaticHttpController } = require("../adapters/http/dashboard/static-controller");
const { WorkspaceHttpController } = require("../adapters/http/dashboard/workspace-controller");

function createDashboardRouter({ dashboard, eventHub, paths }) {
  return new DashboardRouter({
    controllers: [
      new WorkspaceHttpController({ eventHub, workspace: dashboard }),
      new ArchiveHttpController({ workspace: dashboard }),
      new FetchHttpController({ workspace: dashboard }),
      new StaticHttpController({ paths }),
    ],
  });
}

module.exports = { createDashboardRouter };
