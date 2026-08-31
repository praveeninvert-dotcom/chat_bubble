// Deliberately exercises two related server.js guards around pendingTurns:
//
// Scenarios 1-2: the turn.end conversationId guard that replaced the
// convo.total guess-fallback removed 2026-08-29 (SPEC.md §4). That guess is
// what silently wrote one conversation's replies into a different
// conversation's stored history — these reproduce the exact shape of that
// bug on purpose and confirm the fix drops the turn instead.
//
// Scenario 3: ensurePendingTurn, added 2026-08-30 (SPEC.md §4) alongside
// turn.delta/turn.replace/turn.end all carrying `index`. A turn.end for a
// turnId whose turn.start this server never saw (e.g. the desktop app was
// quit and relaunched mid-reply) used to be dropped unconditionally, losing
// the reply permanently — this confirms it now persists instead, using the
// index carried on turn.end itself.
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
const CONVO_C = "TEST-GUARD-CONVERSATION-C";

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

  // --- Scenario 2: turn.end with no matching turn.start at all, and no
  // index either (the other guard clause — no usable index, regardless of
  // conversationId). Distinct from Scenario 3 below: this one has nothing
  // ensurePendingTurn could recover from, so it should still drop.
  send({
    type: "turn.end",
    turnId: "guard-turn-2",
    conversationId: CONVO_B,
    text: "SCENARIO 2 LEAK — should never be persisted",
  });
  await sleep(200);

  // --- Scenario 3: turn.end with an index but genuinely no prior
  // turn.start — the concrete case being a desktop app restart mid-reply,
  // so the new process's pendingTurns never had an entry for this turn at
  // all (SPEC.md §4, 2026-08-30). Unlike Scenario 2, this SHOULD persist:
  // ensurePendingTurn recovers a pendingTurns entry from msg.index itself.
  // Run on its own conversation (C) so it can't be confused with A/B's
  // "should stay empty" assertions above.
  send({ type: "conversation", conversationId: CONVO_C, title: "Guard test C" });
  await sleep(100);
  const turnId3 = "guard-turn-3";
  const scenario3Index = 5;
  send({
    type: "turn.end",
    turnId: turnId3,
    conversationId: CONVO_C,
    index: scenario3Index,
    text: "SCENARIO 3 — should persist via recovered index",
  });
  await sleep(200);

  ws.close();

  const storeFile = path.join(tmpDir, "conversations.json");
  const data = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : { conversations: {} };
  const convoA = data.conversations[CONVO_A];
  const convoB = data.conversations[CONVO_B];
  const convoC = data.conversations[CONVO_C];
  const aHasTurns = !!(convoA && convoA.turns && Object.keys(convoA.turns).length > 0);
  const bHasTurns = !!(convoB && convoB.turns && Object.keys(convoB.turns).length > 0);
  const droppedMismatch = serverLogs.some((l) => l.includes("dropped turn.end") && l.includes(CONVO_A));
  const droppedOrphan = serverLogs.some((l) => l.includes("dropped turn.end") && l.includes("no pendingTurns entry"));
  const scenario3Turn = convoC && convoC.turns && convoC.turns[String(scenario3Index)];
  const scenario3Persisted = !!(scenario3Turn && scenario3Turn.text === "SCENARIO 3 — should persist via recovered index");
  const scenario3Recovered = serverLogs.some(
    (l) => l.includes("recovered pendingTurns entry") && l.includes(turnId3) && l.includes(`index=${scenario3Index}`)
  );

  originalLog("");
  originalLog("=== Scenario 1: conversationId mismatch (started under A, finished after switching to B) ===");
  originalLog(aHasTurns || bHasTurns ? "FAIL — turn was written to disk somewhere." : "PASS — dropped, nothing written.");
  originalLog(droppedMismatch ? "PASS — server logged the drop." : "FAIL — no drop was logged.");

  originalLog("");
  originalLog("=== Scenario 2: turn.end with no prior turn.start and no index ===");
  originalLog(bHasTurns ? "FAIL — turn was written to disk." : "PASS — dropped, nothing written.");
  originalLog(droppedOrphan ? "PASS — server logged the drop." : "FAIL — no drop was logged.");

  originalLog("");
  originalLog("=== Scenario 3: turn.end with an index but no prior turn.start (app-restart-mid-reply) ===");
  originalLog(scenario3Persisted ? "PASS — persisted at the recovered index." : "FAIL — turn was NOT persisted.");
  originalLog(scenario3Recovered ? "PASS — server logged the recovery." : "FAIL — no recovery was logged.");

  const failed =
    aHasTurns || bHasTurns || !droppedMismatch || !droppedOrphan || !scenario3Persisted || !scenario3Recovered;
  originalLog("");
  originalLog(
    failed
      ? "RESULT: FAIL — the guards did not behave as expected. Investigate before trusting them."
      : "RESULT: PASS — both mismatched turns were dropped, and the restart-mid-reply turn was recovered and persisted."
  );
  cleanup(failed ? 1 : 0);
}

run().catch((err) => {
  originalLog("[test-guard] error:", err);
  cleanup(1);
});
