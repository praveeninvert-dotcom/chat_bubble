// Stands in for the Chrome extension so the server can be tested without it.
// Connects as role=extension using the real pairing token, prints every
// message the server sends back, and sends whatever JSON you type — one
// message per line, Enter to send.
//
// Run: node desktop/test-client.js   (with the desktop app already running)
const WebSocket = require("ws");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");

const APP_NAME = "claude-bubble";
const HOST = "127.0.0.1";
const PORT = 8787;

function readToken() {
  const tokenFile = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    APP_NAME,
    "pairing-token.txt"
  );
  if (!fs.existsSync(tokenFile)) {
    console.error("[test-client] no token file at:", tokenFile);
    console.error("[test-client] start the desktop app first (npm start, from desktop/) so it can generate one.");
    process.exit(1);
  }
  return fs.readFileSync(tokenFile, "utf8").trim();
}

const token = readToken();
const url = `ws://${HOST}:${PORT}/?role=extension&token=${token}`;

console.log("[test-client] connecting to", url);

// A real Chrome extension's Origin header is set by Chrome itself and can't
// be forged by a web page. This script is a trusted local dev tool standing
// in for the extension, so it can set any Origin it likes to pass the
// server's allowlist — that's a test convenience, not a hole in the server.
const ws = new WebSocket(url, {
  headers: { Origin: "chrome-extension://test-client-fake-id" },
});

ws.on("unexpected-response", (_req, res) => {
  console.error("[test-client] rejected before the handshake completed. HTTP status:", res.statusCode);
  let body = "";
  res.on("data", (chunk) => (body += chunk));
  res.on("end", () => {
    if (body) console.error("[test-client] body:", body);
    process.exit(1);
  });
});

ws.on("open", () => {
  console.log("[test-client] connected");
  const hello = { type: "hello", role: "extension", clientId: "test-client-" + Date.now() };
  console.log("[test-client] sending:", JSON.stringify(hello));
  ws.send(JSON.stringify(hello));
  startPrompt();
});

ws.on("message", (data) => {
  console.log("[test-client] received:", data.toString());
});

ws.on("close", (code, reason) => {
  console.log("[test-client] closed. code:", code, "reason:", reason.toString());
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[test-client] socket error:", err.message);
});

function startPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed); // catch typos here rather than send garbage
        ws.send(trimmed);
      } catch {
        console.log("[test-client] not valid JSON, not sent:", trimmed);
      }
    }
    rl.prompt();
  });
  rl.on("close", () => {
    ws.close();
  });
}
