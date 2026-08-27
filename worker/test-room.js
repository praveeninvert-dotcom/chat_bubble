"use strict";

// Prints a valid room key for testing, derived the same way the extension
// will derive its own — SHA-256 of the secret alone, no conversation ID
// (SPEC.md §5).
//
// The secret is represented as a hex string wherever it's displayed or
// stored (that's what will live in chrome.storage.local later). The hash is
// taken over the raw bytes that hex string decodes to, not over the hex
// characters themselves — the extension must follow this same rule or the
// two sides will compute different room keys from the "same" secret.

const { randomBytes, createHash } = require("node:crypto");

const secret = randomBytes(32);
const secretHex = secret.toString("hex");
const roomKey = createHash("sha256").update(secret).digest("hex");

console.log("Test secret (hex, 32 bytes) — stands in for what chrome.storage.local will hold:");
console.log(`  ${secretHex}`);
console.log();
console.log("Room key (SHA-256 of the secret's raw bytes):");
console.log(`  ${roomKey}`);
console.log();
console.log("Use this room key in two terminals to test the relay:");
console.log(`  node test-client.js ${roomKey} extension`);
console.log(`  node test-client.js ${roomKey} bubble`);
