function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = { httpError };
