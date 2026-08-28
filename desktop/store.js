// JSON persistence for conversation turns. Shape:
// { conversations: { <id>: { title, updatedAt, total, turns: { <index>: {role, text} } } } }
// turns is a sparse map keyed by index, not an array — the transcript is
// virtualized (SPEC.md §4.1), so what's stored can have gaps.
const fs = require("node:fs");
const path = require("node:path");

const STORE_FILE = "conversations.json";

function storePath(userDataDir) {
  return path.join(userDataDir, STORE_FILE);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Every read in server.js assumes store.conversations[id].turns is a plain
// object it can index into (convo.turns[index] = ...). A file that's valid
// JSON but the wrong shape — a string, an array, a conversation with turns
// as something other than an object — is just as unusable as corrupt JSON.
function isValidStoreShape(data) {
  if (!isPlainObject(data) || !isPlainObject(data.conversations)) return false;
  for (const convo of Object.values(data.conversations)) {
    if (!isPlainObject(convo)) return false;
    if (convo.turns !== undefined && !isPlainObject(convo.turns)) return false;
  }
  return true;
}

function loadStore(userDataDir) {
  const file = storePath(userDataDir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (isValidStoreShape(data)) return data;
    console.error("[bubble-server] conversations.json has an unexpected shape, starting fresh instead of using it:", file);
  } catch (err) {
    // Missing file on first run is normal and not worth logging. Anything
    // else (corrupt JSON, a read error) starts fresh rather than crashing,
    // but is worth a log line since it silently drops whatever was there.
    if (err.code !== "ENOENT") {
      console.error("[bubble-server] conversations.json could not be read, starting fresh:", err.message);
    }
  }
  return { conversations: {} };
}

function saveStore(userDataDir, data) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = storePath(userDataDir);
  const tmp = file + ".tmp";
  // Write to a temp file and rename over the real one — atomic on the same
  // volume, so a crash mid-write can't leave a half-written JSON file behind.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadStore, saveStore, storePath };
