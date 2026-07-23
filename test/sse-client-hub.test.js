const { EventEmitter } = require("events");
const test = require("node:test");
const assert = require("node:assert/strict");
const { SseClientHub, eventFrame } = require("../src/adapters/http/sse-client-hub");

class EventResponse extends EventEmitter {
  constructor() {
    super();
    this.body = "";
    this.ended = false;
    this.headers = null;
    this.statusCode = null;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.body += String(chunk);
  }

  end() {
    this.ended = true;
  }
}

test("SSE client hub owns connection lifecycle and event serialization", () => {
  const hub = new SseClientHub({ clock: () => new Date("2026-07-23T00:00:00.000Z") });
  const request = new EventEmitter();
  const response = new EventResponse();

  hub.connect(request, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "text/event-stream");
  assert.match(response.body, /event: connected\ndata: {"at":"2026-07-23T00:00:00.000Z"}/);
  assert.equal(hub.size(), 1);

  hub.publish("inventory", { courses: 3 });
  assert.match(response.body, /event: inventory\ndata: {"courses":3}/);
  request.emit("close");
  assert.equal(hub.size(), 0);
});

test("SSE client hub closes clients and sanitizes event names", () => {
  const hub = new SseClientHub();
  const request = new EventEmitter();
  const response = new EventResponse();
  hub.connect(request, response);

  assert.equal(eventFrame("jobs\ninvalid", { ready: true }), "event: jobsinvalid\ndata: {\"ready\":true}\n\n");
  hub.close();
  assert.equal(hub.size(), 0);
  assert.equal(response.ended, true);
  assert.equal(request.listenerCount("close"), 0);
});
