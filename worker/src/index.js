const ROOM_KEY_RE = /^[0-9a-f]{64}$/;
const VALID_ROLES = new Set(["extension", "bubble"]);

export class SessionRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: the DO can be evicted between messages without
    // dropping the socket. Tag it with its role so we can look it up later.
    this.ctx.acceptWebSocket(server, [role]);

    console.log(`[bubble-worker] accepted ${role} connection in room ${this.ctx.id}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const [role] = this.ctx.getTags(ws);
    const preview = typeof message === "string" ? message : `<binary, ${message.byteLength} bytes>`;
    console.log(`[bubble-worker] message from ${role}: ${preview}`);
    ws.send(message);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const [role] = this.ctx.getTags(ws);
    console.log(`[bubble-worker] ${role} closed: code=${code} reason="${reason}" wasClean=${wasClean}`);
  }

  async webSocketError(ws, error) {
    const [role] = this.ctx.getTags(ws);
    console.log(`[bubble-worker] ${role} socket error: ${error}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", { status: 400 });
    }

    const room = url.searchParams.get("room");
    if (!room || !ROOM_KEY_RE.test(room)) {
      return new Response(
        "Bad request: 'room' query param must be a 64-character hex string",
        { status: 400 },
      );
    }

    const role = url.searchParams.get("role");
    if (!role || !VALID_ROLES.has(role)) {
      return new Response(
        "Bad request: 'role' query param must be 'extension' or 'bubble'",
        { status: 400 },
      );
    }

    const id = env.SESSION_ROOM.idFromName(room);
    const stub = env.SESSION_ROOM.get(id);
    return stub.fetch(request);
  },
};
