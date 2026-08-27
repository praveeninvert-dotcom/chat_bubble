"use strict";

// A minimal interactive WebSocket client for exercising the Worker by hand.
// Connects, sends `hello`, prints everything it receives, and sends whatever
// JSON you type at the prompt. Uses Node's built-in WebSocket and readline —
// no extra packages.

const readline = require("node:readline");
const { randomUUID } = require("node:crypto");

const [, , roomKey, role, urlArg] = process.argv;

if (!roomKey || !role) {
  console.error("Usage: node test-client.js <roomKey> <extension|bubble> [wsUrl]");
  console.error("  wsUrl defaults to ws://localhost:8787");
  console.error("  Get a roomKey by running: node test-room.js");
  process.exit(1);
}

if (role !== "extension" && role !== "bubble") {
  console.error(`Bad role "${role}" — must be "extension" or "bubble"`);
  process.exit(1);
}

const base = urlArg || "ws://localhost:8787";
const url = `${base}/ws?room=${roomKey}&role=${role}`;
const tag = `[${role}]`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${tag} > `,
});

console.log(`${tag} connecting to ${url}`);
const ws = new WebSocket(url);

let isOpen = false;
const pending = [];

function sendJson(obj) {
  const text = JSON.stringify(obj);
  ws.send(text);
  console.log(`${tag} sent: ${text}`);
}

ws.addEventListener("open", () => {
  console.log(`${tag} connected`);
  isOpen = true;
  sendJson({ type: "hello", role, clientId: randomUUID() });
  for (const msg of pending.splice(0)) {
    sendJson(msg);
  }
  rl.prompt();
});

ws.addEventListener("message", (event) => {
  console.log(`${tag} received: ${event.data}`);
  rl.prompt();
});

ws.addEventListener("close", (event) => {
  console.log(`${tag} connection closed (code ${event.code}${event.reason ? `, reason: ${event.reason}` : ""})`);
  process.exit(0);
});

ws.addEventListener("error", () => {
  console.error(`${tag} connection error — is the Worker running? (npx wrangler dev)`);
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    console.error(`${tag} not valid JSON, nothing sent: ${err.message}`);
    rl.prompt();
    return;
  }
  if (isOpen) {
    sendJson(parsed);
  } else {
    pending.push(parsed);
    console.log(`${tag} not connected yet — will send once open`);
  }
  rl.prompt();
});

rl.on("close", () => {
  ws.close();
});
