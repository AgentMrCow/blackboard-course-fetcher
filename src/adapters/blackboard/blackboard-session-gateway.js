const { stateMetadata, validateState } = require("./session-state");

class BlackboardSessionGateway {
  metadata(settings) {
    return stateMetadata(settings);
  }

  exists(settings) {
    return this.metadata(settings).exists;
  }

  validate(settings) {
    return validateState(settings);
  }
}

module.exports = { BlackboardSessionGateway };
