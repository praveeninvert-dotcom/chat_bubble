// JSON persistence for conversation turns. See CLAUDE.md conversation with the
// operator for the file shape: { conversations: { <id>: { title, updatedAt, turns } } }
const fs = require("node:fs");
const path = require("node:path");

const STORE_FILE = "conversations.json";

function storePath(userDataDir) {
  return path.join(userDataDir, STORE_FILE);
}

function loadStore(userDataDir) {
  const file = storePath(userDataDir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && data.conversations) return data;
  } catch {
    // Missing file on first run, or corrupt JSON — start fresh rather than crash.
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
