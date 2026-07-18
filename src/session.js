/**
 * session.js
 * ─────────────────────────────────────────────────────────────
 * Redis-backed session store using ioredis.
 *
 * Session schema per WhatsApp user (stored as JSON string in Redis):
 * {
 *   stage:  string | null,   // current order-flow stage (see STAGES in orderFlow.js)
 *   draft: {                 // order fields collected so far
 *     size?:    string,      // "1L" | "500ml" | "250ml"
 *     sku?:     string,      // "BM-1L" | "BM-500" | "BM-250"
 *     price?:   number,      // unit price in ₹
 *     quantity?: number,
 *     name?:    string,
 *     phone?:   string,
 *     address?: string,
 *     notes?:   string,
 *   }
 * }
 *
 * Key format:  session:<whatsapp_number>
 * TTL:         SESSION_TTL_SECONDS (default 1800 = 30 min)
 *              Refreshed on every interaction so active conversations
 *              never expire mid-flow.
 * ─────────────────────────────────────────────────────────────
 */

import Redis from "ioredis";

// ── Redis client (singleton) ──────────────────────────────────
let _redis = null;

/**
 * getRedis()
 * Lazily creates the ioredis client on first use.
 * Reads REDIS_URL from env (default: redis://localhost:6379).
 * ioredis automatically reconnects on dropped connections.
 *
 * @returns {Redis} ioredis client instance
 */
function getRedis() {
  if (_redis) return _redis;

  const url = process.env.REDIS_URL || "redis://localhost:6379";

  _redis = new Redis(url, {
    // Retry strategy: wait 500 ms, then 1 s, then 2 s, cap at 5 s
    retryStrategy: (times) => Math.min(times * 500, 5000),
    // Log but don't crash on connection errors
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });

  _redis.on("connect",    () => console.log("✅ Redis connected"));
  _redis.on("error",      (err) => console.error("❌ Redis error:", err.message));
  _redis.on("reconnecting", () => console.log("🔄 Redis reconnecting..."));

  return _redis;
}

// ── Constants ─────────────────────────────────────────────────
// 30-minute TTL; refreshed on every message so active orders never expire
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || "1800", 10);

// Key prefix keeps session keys namespaced if Redis is shared
const PREFIX = "session:";

/**
 * buildKey(from)
 * Build a Redis key from the WhatsApp sender ID.
 * Twilio sends "from" as "whatsapp:+91XXXXXXXXXX".
 * We strip the "whatsapp:" prefix so keys read cleanly in Redis CLI.
 *
 * @param {string} from - Twilio sender ID
 * @returns {string}    - Redis key, e.g. "session:+91XXXXXXXXXX"
 */
function buildKey(from) {
  const number = from.replace(/^whatsapp:/i, "");
  return `${PREFIX}${number}`;
}

/**
 * getSession(from)
 * Fetch the session for a user. Returns a default empty session
 * if none exists yet (first message from this number).
 *
 * @param {string} from - Twilio sender ID
 * @returns {Promise<{ stage: string|null, draft: Object }>}
 */
export async function getSession(from) {
  const redis = getRedis();
  const key   = buildKey(from);

  const raw = await redis.get(key);

  if (!raw) {
    // No session yet — return clean default
    return { stage: null, draft: {} };
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    // Corrupted JSON (shouldn't happen, but be safe)
    console.error(`Session parse error for ${key}:`, err.message);
    return { stage: null, draft: {} };
  }
}

/**
 * setSession(from, session)
 * Persist the session and refresh its TTL.
 * Called after every stage transition or field update.
 *
 * @param {string} from                    - Twilio sender ID
 * @param {{ stage: string|null, draft: Object }} session
 * @returns {Promise<void>}
 */
export async function setSession(from, session) {
  const redis = getRedis();
  const key   = buildKey(from);

  // EX sets the key with a TTL in seconds; refreshes on every write
  await redis.set(key, JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
}

/**
 * clearSession(from)
 * Delete the session after a completed or cancelled order.
 * The next message from this user starts a fresh flow.
 *
 * @param {string} from - Twilio sender ID
 * @returns {Promise<void>}
 */
export async function clearSession(from) {
  const redis = getRedis();
  const key   = buildKey(from);
  await redis.del(key);
}

/**
 * closeRedis()
 * Gracefully close the Redis connection on server shutdown.
 * Call from SIGINT / SIGTERM handler in server.js.
 *
 * @returns {Promise<void>}
 */
export async function closeRedis() {
  if (_redis) {
    await _redis.quit();
    _redis = null;
    console.log("Redis connection closed.");
  }
}