function eventFrame(type, payload) {
  const eventType = String(type || "message").replace(/[\r\n]+/g, "");
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

class SseClientHub {
  constructor({ clock = () => new Date() } = {}) {
    this.clients = new Map();
    this.clock = clock;
  }

  connect(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(eventFrame("connected", { at: this.clock().toISOString() }));

    const disconnect = () => this.remove(response);
    this.clients.set(response, { disconnect, request, response });
    request.once("close", disconnect);
    response.once?.("close", disconnect);
    response.once?.("error", disconnect);
  }

  remove(response) {
    const client = this.clients.get(response);
    if (!client) return false;
    this.clients.delete(response);
    client.request.off?.("close", client.disconnect);
    client.response.off?.("close", client.disconnect);
    client.response.off?.("error", client.disconnect);
    return true;
  }

  publish(type, payload) {
    const data = eventFrame(type, payload);
    for (const response of this.clients.keys()) {
      try {
        response.write(data);
      } catch {
        this.remove(response);
        response.destroy?.();
      }
    }
  }

  size() {
    return this.clients.size;
  }

  close() {
    for (const response of [...this.clients.keys()]) {
      this.remove(response);
      response.end();
    }
  }
}

module.exports = { eventFrame, SseClientHub };
