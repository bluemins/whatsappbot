#!/usr/bin/env node
/**
 * scripts/redis-inspect.js
 * ─────────────────────────────────────────────────────────────
 * CLI utility to inspect, view, and manage Redis session data
 * stored by the Bluemins WhatsApp Bot.
 *
 * Usage:
 *   node scripts/redis-inspect.js list              # List all session keys
 *   node scripts/redis-inspect.js view +919876543210 # View one session
 *   node scripts/redis-inspect.js clear +919876543210 # Delete one session
 *   node scripts/redis-inspect.js clearall           # Delete ALL sessions ⚠️
 *   node scripts/redis-inspect.js stats              # Summary stats
 *
 * Environment:
 *   REDIS_URL   — default: redis://localhost:6379
 *
 * Run from repo root:
 *   node scripts/redis-inspect.js list
 * ─────────────────────────────────────────────────────────────
 */

import Redis  from "ioredis";
import dotenv from "dotenv";

// Load .env so REDIS_URL is available without manual export
dotenv.config();

// ── Redis client ──────────────────────────────────────────────
// Use a short connect timeout for a CLI tool — fail fast if Redis is down
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  connectTimeout:       3000,  // 3s to establish TCP connection
  maxRetriesPerRequest: 1,     // don't hang on retry loops in a CLI
  lazyConnect:          false,
});

// Surface connection errors immediately rather than swallowing them
redis.on("error", (err) => {
  console.error("❌ Redis connection error:", err.message);
  process.exit(1);
});

// ── Key schema ────────────────────────────────────────────────
// Must match the PREFIX in src/session.js
// Key format: "session:<whatsapp_number>"  e.g. "session:+919876543210"
const PREFIX = "session:";

/**
 * getAllSessionKeys()
 * Scan all Redis keys matching the session prefix.
 * Uses SCAN (not KEYS) to avoid blocking Redis on large datasets.
 *
 * @returns {Promise<string[]>} array of matching keys
 */
async function getAllSessionKeys() {
  const keys = [];
  let cursor = "0";

  // SCAN iterates in batches — safe for production Redis
  do {
    // COUNT 100 is a hint, not a guarantee; Redis decides actual batch size
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys;
}

/**
 * getSessionData(key)
 * Fetch and parse a single session from Redis.
 * Also retrieves the remaining TTL so we know when it expires.
 *
 * @param {string} key - Full Redis key e.g. "session:+919876543210"
 * @returns {Promise<{ data: Object, ttlSeconds: number }>}
 */
async function getSessionData(key) {
  // Fetch value and TTL in parallel to minimize round trips
  const [raw, ttl] = await Promise.all([
    redis.get(key),
    redis.ttl(key),      // remaining TTL in seconds; -1 = no expiry; -2 = key gone
  ]);

  if (!raw) return { data: null, ttlSeconds: ttl };

  try {
    return { data: JSON.parse(raw), ttlSeconds: ttl };
  } catch {
    // Corrupted JSON — return raw string for debugging
    return { data: { _raw: raw, _parseError: true }, ttlSeconds: ttl };
  }
}

/**
 * formatTtl(seconds)
 * Convert TTL seconds to a human-readable string.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTtl(seconds) {
  if (seconds === -2) return "⚠️  KEY EXPIRED/MISSING";
  if (seconds === -1) return "♾️  No expiry set";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s remaining`;
}

/**
 * formatStage(stage)
 * Render the order flow stage with an emoji for quick scanning.
 *
 * @param {string|null} stage
 * @returns {string}
 */
function formatStage(stage) {
  const stageMap = {
    null:        "💤 No active order",
    ASK_SIZE:    "1️⃣  Waiting for size selection",
    ASK_QTY:     "2️⃣  Waiting for quantity",
    ASK_NAME:    "3️⃣  Waiting for name",
    ASK_PHONE:   "4️⃣  Waiting for phone number",
    ASK_ADDRESS: "5️⃣  Waiting for delivery address",
    ASK_NOTES:   "6️⃣  Waiting for special notes",
    CONFIRM:     "7️⃣  Awaiting order confirmation (yes/no)",
  };
  return stageMap[stage] ?? `❓ Unknown stage: ${stage}`;
}

// ── Commands ──────────────────────────────────────────────────

/**
 * cmdList()
 * Print all active session keys with their stage and TTL.
 * Gives a quick overview of all users currently in a conversation.
 */
async function cmdList() {
  const keys = await getAllSessionKeys();

  if (keys.length === 0) {
    console.log("📭 No active sessions in Redis.");
    return;
  }

  console.log(`\n📋 Active sessions: ${keys.length}\n`);
  console.log("─".repeat(70));

  // Fetch all sessions in parallel for speed
  const entries = await Promise.all(
    keys.map(async (key) => {
      const { data, ttlSeconds } = await getSessionData(key);
      // Strip the "session:" prefix to show just the phone number
      const phone = key.replace(PREFIX, "");
      return { phone, data, ttlSeconds };
    })
  );

  // Sort by phone number for consistent output
  entries.sort((a, b) => a.phone.localeCompare(b.phone));

  for (const { phone, data, ttlSeconds } of entries) {
    const stage = data?.stage ?? null;
    console.log(`📱 ${phone}`);
    console.log(`   Stage : ${formatStage(stage)}`);
    console.log(`   TTL   : ${formatTtl(ttlSeconds)}`);

    // Show draft fields that have been collected so far
    const draft = data?.draft ?? {};
    const filledFields = Object.entries(draft).filter(([, v]) => v !== null && v !== undefined);
    if (filledFields.length > 0) {
      console.log(`   Draft : ${filledFields.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    console.log();
  }
}

/**
 * cmdView(phone)
 * Pretty-print the full session data for a single user.
 * Use this to debug stuck orders or verify field collection.
 *
 * @param {string} phone - Phone number (with or without "session:" prefix)
 */
async function cmdView(phone) {
  // Accept both "+919876543210" and "session:+919876543210"
  const key = phone.startsWith(PREFIX) ? phone : `${PREFIX}${phone}`;
  const { data, ttlSeconds } = await getSessionData(key);

  if (!data) {
    console.log(`❌ No session found for key: ${key}`);
    return;
  }

  const displayPhone = key.replace(PREFIX, "");
  console.log(`\n📱 Session for ${displayPhone}`);
  console.log("─".repeat(50));
  console.log(`TTL    : ${formatTtl(ttlSeconds)}`);
  console.log(`Stage  : ${formatStage(data.stage)}`);
  console.log(`\nDraft fields collected so far:`);

  const draft = data.draft ?? {};
  if (Object.keys(draft).length === 0) {
    console.log("  (empty — no fields collected yet)");
  } else {
    // Print each field with its value; label price in ₹ for clarity
    for (const [key, value] of Object.entries(draft)) {
      const label  = key.padEnd(10);
      const display = key === "price" ? `₹${value}` : value;
      console.log(`  ${label}: ${display}`);
    }
  }

  // Show raw JSON for debugging parse errors or unexpected shapes
  console.log("\nRaw JSON:");
  console.log(JSON.stringify(data, null, 2));
  console.log();
}

/**
 * cmdClear(phone)
 * Delete a single user's session from Redis.
 * Useful when a customer is stuck in an order flow they can't exit.
 *
 * @param {string} phone - Phone number e.g. "+919876543210"
 */
async function cmdClear(phone) {
  const key = phone.startsWith(PREFIX) ? phone : `${PREFIX}${phone}`;
  const deleted = await redis.del(key);

  if (deleted === 0) {
    console.log(`⚠️  Key not found (already gone?): ${key}`);
  } else {
    console.log(`✅ Deleted session: ${key}`);
  }
}

/**
 * cmdClearAll()
 * Delete ALL session keys from Redis.
 * ⚠️ This resets every active order flow — use with caution!
 * Useful during development or after a bot restart to clear stale state.
 */
async function cmdClearAll() {
  const keys = await getAllSessionKeys();

  if (keys.length === 0) {
    console.log("📭 No sessions to clear.");
    return;
  }

  // Confirm before deleting — prints count so the operator can verify
  console.log(`\n⚠️  About to delete ${keys.length} session(s):`);
  keys.forEach((k) => console.log(`   - ${k}`));
  console.log();

  // Use pipeline to batch all DEL commands in a single round trip
  const pipeline = redis.pipeline();
  keys.forEach((k) => pipeline.del(k));
  await pipeline.exec();

  console.log(`✅ Cleared ${keys.length} session(s).`);
}

/**
 * cmdStats()
 * Print aggregate statistics about current sessions.
 * Useful for a quick health check during business hours.
 */
async function cmdStats() {
  const keys = await getAllSessionKeys();

  if (keys.length === 0) {
    console.log("\n📊 Stats: 0 active sessions.\n");
    return;
  }

  // Fetch all sessions in parallel
  const sessions = await Promise.all(
    keys.map((k) => getSessionData(k).then(({ data }) => data))
  );

  // Tally sessions by stage
  const stageCounts = {};
  for (const s of sessions) {
    const stage = s?.stage ?? "null (no active order)";
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
  }

  console.log(`\n📊 Redis Session Stats`);
  console.log("─".repeat(40));
  console.log(`Total active sessions: ${keys.length}`);
  console.log(`\nBreakdown by stage:`);
  for (const [stage, count] of Object.entries(stageCounts)) {
    // Pad stage name for aligned columns
    console.log(`  ${stage.padEnd(30)} : ${count}`);
  }
  console.log();
}

// ── CLI entry point ───────────────────────────────────────────
const [,, command, arg] = process.argv;

// Map command strings to handler functions
const COMMANDS = {
  list:     () => cmdList(),
  view:     () => cmdView(arg),
  clear:    () => cmdClear(arg),
  clearall: () => cmdClearAll(),
  stats:    () => cmdStats(),
};

async function main() {
  const handler = COMMANDS[command];

  if (!handler) {
    // Print usage help when command is missing or unrecognised
    console.log(`
Bluemins Redis Session Inspector
─────────────────────────────────
Usage:
  node scripts/redis-inspect.js list
  node scripts/redis-inspect.js view <phone>       e.g. +919876543210
  node scripts/redis-inspect.js clear <phone>      Delete one session
  node scripts/redis-inspect.js clearall           ⚠️  Delete ALL sessions
  node scripts/redis-inspect.js stats              Aggregate stats

Environment:
  REDIS_URL   (default: redis://localhost:6379)
    `);
    process.exit(0);
  }

  // Validate that commands requiring a phone argument have one
  if (["view", "clear"].includes(command) && !arg) {
    console.error(`❌ Command "${command}" requires a phone number argument.`);
    console.error(`   Example: node scripts/redis-inspect.js ${command} +919876543210`);
    process.exit(1);
  }

  try {
    await handler();
  } catch (err) {
    console.error("❌ Unexpected error:", err.message);
    process.exit(1);
  } finally {
    // Always close the connection so the process exits cleanly
    await redis.quit();
  }
}

main();
