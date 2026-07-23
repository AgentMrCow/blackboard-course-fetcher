const test = require("node:test");
const assert = require("node:assert/strict");
const { AuthenticationCoordinator } = require("../src/application/authentication/authentication-coordinator");
const { InventoryCoordinator } = require("../src/application/inventory/inventory-coordinator");

const SETTINGS = {
  archiveRoot: "/archive",
  blackboardBase: "https://blackboard.example.edu",
  downloadMode: "placeholder",
  stateFile: "/private/state.json",
};
const NOW = new Date("2026-07-23T04:00:00.000Z");

function sessionGateway(exists = true) {
  return {
    exists: () => exists,
    metadata: () => ({ exists, stateFile: SETTINGS.stateFile, cookieCount: exists ? 2 : 0 }),
    validate: async () => ({ valid: true, message: "Blackboard session is valid", user: { id: "_1_1" } }),
  };
}

function authenticationRunner() {
  const handle = { connected: true };
  return {
    cancelled: false,
    handle,
    handlers: null,
    sent: [],
    canSend: (candidate) => candidate === handle && candidate.connected,
    cancel(candidate) {
      this.cancelled = candidate === handle;
      return this.cancelled;
    },
    send(candidate, message) {
      if (candidate !== handle) return false;
      this.sent.push(message);
      return true;
    },
    start(specification, handlers) {
      this.specification = specification;
      this.handlers = handlers;
      return handle;
    },
  };
}

function inventoryRunner() {
  const handle = { pid: 123 };
  return {
    handle,
    handlers: null,
    signals: [],
    signal(candidate, signal) {
      this.signals.push({ candidate, signal });
      return true;
    },
    start(specification, handlers) {
      this.specification = specification;
      this.handlers = handlers;
      return handle;
    },
  };
}

function controlledScheduler() {
  return {
    delayed: [],
    delay(callback, milliseconds) {
      this.delayed.push({ callback, milliseconds });
    },
  };
}

test("authentication coordinator owns check, browser IPC, and terminal state", async () => {
  const runner = authenticationRunner();
  const updates = [];
  const coordinator = new AuthenticationCoordinator({
    clock: () => NOW,
    profileDirectory: "/private/profile",
    runner,
    sessionGateway: sessionGateway(),
    settings: SETTINGS,
  });
  coordinator.on("update", (snapshot) => updates.push(snapshot.status));

  assert.equal((await coordinator.check()).status, "connected");
  assert.equal(coordinator.start().status, "starting");
  assert.deepEqual(runner.specification, {
    base: SETTINGS.blackboardBase,
    profileDirectory: "/private/profile",
    stateFile: SETTINGS.stateFile,
  });
  runner.handlers.onMessage({ type: "ready", message: "Complete sign-in" });
  assert.equal(coordinator.snapshot().status, "waiting");
  assert.equal(coordinator.save().status, "saving");
  assert.deepEqual(runner.sent, [{ type: "save" }]);
  runner.handlers.onMessage({ type: "saved", message: "Ready", validation: { valid: true } });
  runner.handlers.onExit({ code: 0, signal: null, stderr: "" });
  assert.equal(coordinator.snapshot().status, "connected");
  assert.equal(coordinator.active(), false);
  assert.ok(updates.includes("waiting"));
});

test("authentication coordinator cancels the active browser without exposing session data", () => {
  const runner = authenticationRunner();
  const coordinator = new AuthenticationCoordinator({
    profileDirectory: "/private/profile",
    runner,
    sessionGateway: sessionGateway(),
    settings: SETTINGS,
  });
  coordinator.start();
  const snapshot = coordinator.cancel();

  assert.equal(runner.cancelled, true);
  assert.equal(snapshot.status, "idle");
  assert.equal(JSON.stringify(snapshot).includes("cookieValue"), false);
});

test("inventory coordinator validates session state and reports successful refresh", () => {
  const runner = inventoryRunner();
  const scheduler = controlledScheduler();
  const archiveService = {
    getInventory: () => ({ courses: [{ id: "one" }, { id: "two" }] }),
    invalidations: 0,
    invalidate() { this.invalidations += 1; },
  };
  const coordinator = new InventoryCoordinator({
    archiveService,
    clock: () => NOW,
    runner,
    scheduler,
    sessionGateway: sessionGateway(),
    settings: SETTINGS,
  });
  let finished;
  coordinator.on("finished", (inventory) => { finished = inventory; });
  assert.equal(coordinator.start().status, "running");
  assert.deepEqual(runner.specification, {
    archiveRoot: SETTINGS.archiveRoot,
    base: SETTINGS.blackboardBase,
    downloadMode: "placeholder",
    stateFile: SETTINGS.stateFile,
  });
  runner.handlers.onLine("Inventory progress", "stdout");
  runner.handlers.onExit(0, null);

  assert.equal(coordinator.snapshot().status, "completed");
  assert.equal(coordinator.snapshot().message, "Inventory now contains 2 courses");
  assert.equal(coordinator.snapshot().logs[0].line, "Inventory progress");
  assert.equal(archiveService.invalidations, 1);
  assert.equal(finished.courses.length, 2);
});

test("inventory coordinator performs graceful then forced cancellation", () => {
  const runner = inventoryRunner();
  const scheduler = controlledScheduler();
  const coordinator = new InventoryCoordinator({
    archiveService: { getInventory: () => ({ courses: [] }), invalidate() {} },
    runner,
    scheduler,
    sessionGateway: sessionGateway(),
    settings: SETTINGS,
  });
  coordinator.start();
  assert.equal(coordinator.cancel().status, "cancelling");
  assert.deepEqual(runner.signals.map((entry) => entry.signal), ["SIGTERM"]);
  assert.equal(scheduler.delayed[0].milliseconds, 5_000);
  scheduler.delayed[0].callback();
  assert.deepEqual(runner.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  runner.handlers.onExit(null, "SIGTERM");
  assert.equal(coordinator.snapshot().status, "cancelled");
});

test("inventory coordinator rejects a missing saved session before starting a process", () => {
  const coordinator = new InventoryCoordinator({
    archiveService: { getInventory: () => ({ courses: [] }), invalidate() {} },
    runner: inventoryRunner(),
    sessionGateway: sessionGateway(false),
    settings: SETTINGS,
  });
  assert.throws(() => coordinator.start(), (error) => error.statusCode === 400);
});
