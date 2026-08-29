// Deliberately exercises the turn.end conversationId guard in server.js that
// replaced the convo.total guess-fallback removed 2026-08-29 (SPEC.md §4).
// That guess is what silently wrote one conversation's replies into a
// different conversation's stored history — this test reproduces the exact
// shape of that bug on purpose and confirms the fix drops the turn instead.
//
// Runs its OWN throwaway server on a separate port with a temporary
// userData directory — it never touches the real desktop app, the real
// extension connection, or the real conversations.json. Safe to run
// anytime, with or without the real app running.
//
// Run: node desktop/test-conversation-guard.js
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { createBubbleServer } = require("./server");

const TEST_PORT = 18787; // unrelated to the real app's 8787
const TOKEN = "test-guard-token";
const CONVO_A = "TEST-GUARD-CONVERSATION-A";
const CONVO_B = "TEST-GUARD-CONVERSATION-B";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bubble-guard-test-"));

// Captured so the test can check the server actually LOGGED the drop, not
// just that nothing landed on disk — both should be true.
const serverLogs = [];
const originalLog = console.log;
console.log = (...args) => {
  serverLogs.push(args.join(" "));
  originalLog(...args);
};

const server = createBubbleServer({
  userDataDir: tmpDir,
  getToken: () => TOKEN,
  onEvent: () => {},
  port: TEST_PORT,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanup(exitCode) {
  console.log = originalLog;
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(exitCode);
}

async function run() {
  await sleep(200); // let httpServer.listen finish

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?role=extension&token=${TOKEN}`, {
    headers: { Origin: "chrome-extension://test-guard-fake-id" },
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  const send = (msg) => ws.send(JSON.stringify(msg));

  // --- Scenario 1: a turn finishes after the operator has switched to a
  // different conversation. This is exactly what used to happen when a
  // reconnect (or a same-id reannounce) orphaned pendingTurns mid-reply.
  send({ type: "conversation", conversationId: CONVO_A, title: "Guard test A" });
  await sleep(100);
  const turnId1 = "guard-turn-1";
  send({
    type: "turn.start",
    turnId: turnId1,
    role: "assistant",
    origin: "native",
    promptId: null,
    conversationId: CONVO_A,
    ts: Date.now(),
    index: 0,
  });
  await sleep(100);
  send({ type: "conversation", conversationId: CONVO_B, title: "Guard test B" }); // operator "switches"
  await sleep(100);
  send({
    type: "turn.end",
    turnId: turnId1,
    conversationId: CONVO_A, // still correctly tagged with where it started
    text: "SCENARIO 1 LEAK — should never be persisted",
  });
  await sleep(200);

  // --- Scenario 2: turn.end with no matching turn.start at all (the other
  // guard clause — no usable index, regardless of conversationId).
  send({
    type: "turn.end",
    turnId: "guard-turn-2",
    conversationId: CONVO_B,
    text: "SCENARIO 2 LEAK — should never be persisted",
  });
  await sleep(200);

  ws.close();

  const storeFile = path.join(tmpDir, "conversations.json");
  const data = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : { conversations: {} };
  const convoA = data.conversations[CONVO_A];
  const convoB = data.conversations[CONVO_B];
  const aHasTurns = !!(convoA && convoA.turns && Object.keys(convoA.turns).length > 0);
  const bHasTurns = !!(convoB && convoB.turns && Object.keys(convoB.turns).length > 0);
  const droppedMismatch = serverLogs.some((l) => l.includes("dropped turn.end") && l.includes(CONVO_A));
  const droppedOrphan = serverLogs.some((l) => l.includes("dropped turn.end") && l.includes("no pendingTurns entry"));

  originalLog("");
  originalLog("=== Scenario 1: conversationId mismatch (started under A, finished after switching to B) ===");
  originalLog(aHasTurns || bHasTurns ? "FAIL — turn was written to disk somewhere." : "PASS — dropped, nothing written.");
  originalLog(droppedMismatch ? "PASS — server logged the drop." : "FAIL — no drop was logged.");

  originalLog("");
  originalLog("=== Scenario 2: turn.end with no prior turn.start ===");
  originalLog(bHasTurns ? "FAIL — turn was written to disk." : "PASS — dropped, nothing written.");
  originalLog(droppedOrphan ? "PASS — server logged the drop." : "FAIL — no drop was logged.");

  const failed = aHasTurns || bHasTurns || !droppedMismatch || !droppedOrphan;
  originalLog("");
  originalLog(
    failed
      ? "RESULT: FAIL — the guard did not behave as expected. Investigate before trusting it."
      : "RESULT: PASS — both mismatched turns were dropped, not misfiled."
  );
  cleanup(failed ? 1 : 0);
}

run().catch((err) => {
  originalLog("[test-guard] error:", err);
  cleanup(1);
});
