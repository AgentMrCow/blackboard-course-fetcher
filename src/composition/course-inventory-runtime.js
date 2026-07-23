const { BlackboardCourseMembershipGateway } = require("../adapters/blackboard/blackboard-course-membership-gateway");
const { CourseInventoryRepository } = require("../adapters/filesystem/course-inventory-repository");
const { PlaywrightStateRepository } = require("../adapters/filesystem/playwright-state-repository");
const { CourseInventoryService } = require("../application/inventory/course-inventory-service");

function createCourseInventoryRuntime({
  archiveRoot,
  clock,
  delay,
  fetchImpl,
  membershipGateway,
  repository,
  stateRepository,
} = {}) {
  const resolvedStateRepository = stateRepository || new PlaywrightStateRepository();
  const resolvedMembershipGateway = membershipGateway || new BlackboardCourseMembershipGateway({
    delay,
    fetchImpl,
    stateRepository: resolvedStateRepository,
  });
  const resolvedRepository = repository || new CourseInventoryRepository({ archiveRoot });
  const inventoryService = new CourseInventoryService({
    clock,
    membershipGateway: resolvedMembershipGateway,
    repository: resolvedRepository,
  });
  return {
    inventoryService,
    membershipGateway: resolvedMembershipGateway,
    repository: resolvedRepository,
    stateRepository: resolvedStateRepository,
  };
}

module.exports = { createCourseInventoryRuntime };
