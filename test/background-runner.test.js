const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const { NodeAuthenticationRunner } = require("../src/adapters/system/node-authentication-runner");
const { NodeInventoryProcessRunner } = require("../src/adapters/system/node-inventory-process-runner");

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeChild() {
  const child = new EventEmitter();
  child.connected = true;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.sent = [];
  child.send = (message) => child.sent.push(message);
  child.kill = () => { child.killed = true; };
  return child;
}

test("authentication runner owns worker paths, private environment, IPC, and stderr tail", async (context) => {
  const root = temporaryDirectory(context, "blackboard-auth-runner-");
  const child = fakeChild();
  let invocation;
  const runner = new NodeAuthenticationRunner({
    dashboardDirectory: path.join(root, "dashboard"),
    environment: { EXISTING: "value" },
    forkImpl(modulePath, args, options) {
      invocation = { args, modulePath, options };
      return child;
    },
    scriptDirectory: root,
  });
  const messages = [];
  let exit;
  runner.start({
    base: "https://blackboard.example.edu",
    profileDirectory: path.join(root, "profile"),
    stateFile: path.join(root, "state.json"),
  }, {
    onExit: (result) => { exit = result; },
    onMessage: (message) => messages.push(message),
  });
  child.emit("message", { type: "ready" });
  child.stderr.write("first\n");
  child.stderr.end("last\n");
  child.emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(invocation.modulePath, path.join(root, "dashboard", "auth-worker.js"));
  assert.equal(invocation.options.env.BB_AUTH_BASE, "https://blackboard.example.edu");
  assert.equal(invocation.options.env.BB_AUTH_STATE_FILE, path.join(root, "state.json"));
  assert.deepEqual(messages, [{ type: "ready" }]);
  assert.match(exit.stderr, /last/);
  assert.equal(runner.send(child, { type: "save" }), true);
  assert.deepEqual(child.sent, [{ type: "save" }]);
  assert.equal(runner.cancel(child), true);
  assert.deepEqual(child.sent.at(-1), { type: "cancel" });
});

test("inventory runner owns CLI protocol, merged lines, and process-tree signals", async (context) => {
  const root = temporaryDirectory(context, "blackboard-inventory-runner-");
  const child = fakeChild();
  let invocation;
  const signals = [];
  const runner = new NodeInventoryProcessRunner({
    environment: { EXISTING: "value" },
    executable: "/node",
    platform: "linux",
    scriptDirectory: root,
    signalImpl: (handle, signal) => { signals.push({ handle, signal }); return true; },
    spawnImpl(command, args, options) {
      invocation = { args, command, options };
      return child;
    },
  });
  const lines = [];
  let exit;
  runner.start({
    archiveRoot: path.join(root, "archive"),
    base: "https://blackboard.example.edu",
    downloadMode: "placeholder",
    stateFile: path.join(root, "state.json"),
  }, {
    onExit: (code, signal) => { exit = { code, signal }; },
    onLine: (line, stream) => lines.push({ line, stream }),
  });
  child.stdout.end("inventory line\n");
  child.stderr.end("warning line\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(invocation.command, "/node");
  assert.deepEqual(invocation.args, [
    path.join(root, "bin", "fetch-blackboard-all.js"),
    "--base", "https://blackboard.example.edu",
    "--state", path.join(root, "state.json"),
    "--output", path.join(root, "archive"),
    "--download-mode", "placeholder",
    "--inventory-only",
  ]);
  assert.equal(invocation.options.detached, true);
  assert.deepEqual(lines, [
    { line: "inventory line", stream: "stdout" },
    { line: "warning line", stream: "stderr" },
  ]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(runner.signal(child, "SIGTERM"), true);
  assert.deepEqual(signals, [{ handle: child, signal: "SIGTERM" }]);
});
