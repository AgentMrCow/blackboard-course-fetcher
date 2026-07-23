const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { sanitizePart } = require("./blackboard-archive-layout");

async function streamResponseToTempFile(response, directory, filename) {
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${sanitizePart(filename, "file")}.part-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );
  const hash = crypto.createHash("sha256");
  let size = 0;
  let head = Buffer.alloc(0);
  const inspector = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      size += buffer.length;
      hash.update(buffer);
      if (head.length < 300) {
        head = Buffer.concat([head, buffer.subarray(0, 300 - head.length)]);
      }
      callback(null, buffer);
    },
  });

  try {
    const source = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    await pipeline(source, inspector, fs.createWriteStream(temporaryPath, { flags: "wx" }));
    return { temporaryPath, size, head, sha256: hash.digest("hex") };
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

module.exports = { streamResponseToTempFile };
