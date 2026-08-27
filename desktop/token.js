// Pairing token: 32 random bytes, generated once, stored as hex in userData.
// The operator pastes this into the extension's options page (SPEC.md §5).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TOKEN_FILE = "pairing-token.txt";

function tokenPath(userDataDir) {
  return path.join(userDataDir, TOKEN_FILE);
}

function getOrCreateToken(userDataDir) {
  const file = tokenPath(userDataDir);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }
  return regenerateToken(userDataDir);
}

function regenerateToken(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenPath(userDataDir), token, { mode: 0o600 });
  return token;
}

module.exports = { getOrCreateToken, regenerateToken, tokenPath };
