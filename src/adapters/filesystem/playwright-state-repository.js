const fs = require("fs");
const path = require("path");

class PlaywrightStateRepository {
  exists(file) {
    return fs.existsSync(path.resolve(file));
  }

  load(file) {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  }
}

module.exports = { PlaywrightStateRepository };
