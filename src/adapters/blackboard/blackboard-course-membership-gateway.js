const {
  createBlackboardRestClient,
  INVENTORY_PAGINATION_POLICY,
  RETRYABLE_STATUS_CODES,
} = require("./blackboard-rest-client");

class BlackboardCourseMembershipGateway {
  constructor({ delay, fetchImpl = fetch, maxAttempts = 4, stateRepository }) {
    if (!stateRepository) throw new TypeError("BlackboardCourseMembershipGateway requires a stateRepository");
    this.delay = delay;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.stateRepository = stateRepository;
  }

  async listMemberships({ base, stateFile }) {
    const state = this.stateRepository.load(stateFile);
    const client = createBlackboardRestClient({
      base,
      delay: this.delay,
      describeErrorUrl: (url) => url.pathname,
      fetchImpl: this.fetchImpl,
      maxAttempts: this.maxAttempts,
      paginationPolicy: INVENTORY_PAGINATION_POLICY,
      state,
    });
    const user = await client.get("/learn/api/v1/users/me");
    if (!user?.id) throw new Error("Blackboard user response did not include an id");
    return client.all(
      `/learn/api/v1/users/${user.id}/memberships?expand=course,term,courseRole&includeCount=true&limit=100&offset=0`
    );
  }
}

module.exports = { BlackboardCourseMembershipGateway, createBlackboardRestClient, RETRYABLE_STATUS_CODES };
