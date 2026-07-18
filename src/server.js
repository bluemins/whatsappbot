/**
 * server.js
 * ─────────────────────────────────────────────────────────────
 * Express server — Twilio WhatsApp webhook handler.
 * No AI calls. All logic lives in router.js → orderFlow.js.
 *
 * ⚠️  BUG FIX (2025):
 *   Previously used res.sendStatus(200) which sends "OK" as the HTTP
 *   response body. Twilio interprets any non-empty response body as a
 *   TwiML/text reply and forwards it to the customer as a WhatsApp
 *   message — causing unwanted "OK" messages and doubling Twilio costs.
 *   Fix: use res.status(200).end() which sends an empty body.
 *
 * Request lifecycle:
 *   POST /twilio/whatsapp
 *     ↓  validate Twilio signature
 *     ↓  respond 200 with EMPTY body (prevents Twilio echo)
 *     ↓  deduplicate (MessageSid check)
 *     ↓  getSession(from)              ← Redis
 *     ↓  route(text, session, from)    ← deterministic dispatcher
 *     ↓  setSession(from, newSession)  ← Redis
 *     ↓  Twilio REST → send reply
 * ─────────────────────────────────────────────────────────────
 */

import express from "express";
import twilio  from "twilio";
import dotenv  from "dotenv";

import { validateTwilioWebhook }                           from "./twilio.js";
import { getSession, setSession, clearSession, closeRedis } from "./session.js";
import { route }                                            from "./router.js";

// Load .env before accessing any process.env values
dotenv.config();

// ── Express setup ─────────────────────────────────────────────
const app = express();

// Twilio sends webhook bodies as URL-encoded form data
app.use(express.urlencoded({ extended: false }));

// ── In-memory dedup set (MessageSid) ─────────────────────────
// Twilio may re-deliver a webhook if your server is slow to respond.
// We track processed MessageSids in a bounded Set (last 1000).
// For production scale, push this into Redis with a short TTL.
const processed = new Set();
const MAX_DEDUP_SIZE = 1000;

/**
 * hasProcessed(sid)
 * Check if a MessageSid has already been handled in this process lifecycle.
 * Prevents duplicate processing when Twilio retries a slow webhook.
 *
 * @param {string} sid - Twilio MessageSid
 * @returns {boolean}
 */
function hasProcessed(sid) { return processed.has(sid); }

/**
 * markProcessed(sid)
 * Add a MessageSid to the dedup set.
 * Evicts the oldest entry when the set reaches MAX_DEDUP_SIZE
 * to avoid unbounded memory growth in long-running processes.
 *
 * @param {string} sid - Twilio MessageSid
 */
function markProcessed(sid) {
  // Evict oldest entry if set is at capacity
  if (processed.size >= MAX_DEDUP_SIZE) {
    const first = processed.values().next().value;
    processed.delete(first);
  }
  processed.add(sid);
}

// ── Twilio client (reused across requests) ────────────────────
/**
 * getTwilioClient()
 * Returns a Twilio REST client authenticated via env vars.
 * Called lazily so missing env vars fail fast at request time, not startup.
 *
 * @returns {twilio.Twilio}
 */
function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

/**
 * sendReply(to, body)
 * Send a WhatsApp message via Twilio REST API.
 * This is the ONLY way we send messages to customers.
 * We never rely on Twilio forwarding our HTTP response body.
 *
 * @param {string} to   - WhatsApp sender ID e.g. "whatsapp:+91XXXXXXXXXX"
 * @param {string} body - Plain-text message content
 * @throws {Error} if TWILIO_WHATSAPP_FROM is not set or API call fails
 */
async function sendReply(to, body) {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!from) throw new Error("TWILIO_WHATSAPP_FROM is not set");

  // REST API call — completely separate from the webhook HTTP response
  await getTwilioClient().messages.create({ from, to, body });
}

/**
 * shouldSendReply(reply)
 * Guard against sending empty, null, or whitespace-only replies.
 * Avoids unnecessary Twilio API calls (each call costs money).
 *
 * @param {string} reply - Candidate reply string
 * @returns {boolean}    - true if the reply has content worth sending
 */
function shouldSendReply(reply) {
  // Reject null, undefined, non-strings, or empty/whitespace strings
  if (!reply || typeof reply !== "string") return false;
  return reply.trim().length > 0;
}

// ── Webhook handler ───────────────────────────────────────────
app.post("/twilio/whatsapp", async (req, res) => {

  // ── Step 1: Validate Twilio signature ──────────────────────
  // Rejects any POST not originating from Twilio's servers.
  // This prevents replay attacks and spoofed webhook calls.
  const isValid = validateTwilioWebhook({
    req,
    publicUrl: process.env.PUBLIC_WEBHOOK_URL + "/twilio/whatsapp",
  });

  if (!isValid) {
    console.warn("⚠️  Rejected request — invalid Twilio signature");
    return res.sendStatus(403);
  }

  // ── Step 2: Extract message fields ─────────────────────────
  const { Body: rawText, From: from, MessageSid: sid } = req.body;

  // Validate required fields are present in the webhook payload
  if (!rawText || !from || !sid) {
    console.warn("⚠️  Missing Body, From, or MessageSid in webhook payload");
    return res.sendStatus(400);
  }

  const userText = rawText.trim();
  console.log(`📱 [${sid}] from ${from}: ${userText}`);

  // ── Step 3: Respond 200 with EMPTY BODY immediately ────────
  //
  // ✅ CRITICAL FIX: Use res.status(200).end() NOT res.sendStatus(200)
  //
  // res.sendStatus(200) sets status 200 AND sends "OK" as the response
  // body. Twilio's webhook handler reads that body and, if it contains
  // text, forwards it as a WhatsApp message to the customer — causing
  // the unwanted "OK" messages seen in the screenshot.
  //
  // res.status(200).end() sends status 200 with a completely empty body.
  // Twilio receives 200 (stops retrying) but has nothing to forward.
  //
  // We then handle the actual reply ourselves via the Twilio REST API
  // in Step 7 below, which gives us full control over message content.
  res.status(200).end();

  // ── Step 4: Deduplicate ────────────────────────────────────
  // Must happen AFTER responding 200, so Twilio stops retrying.
  // But we still skip processing if we've already handled this SID.
  if (hasProcessed(sid)) {
    console.log(`⏭️  Duplicate message ${sid} — skipping`);
    return; // response already sent above; just stop processing
  }
  markProcessed(sid);

  // ── Step 5: Fetch session from Redis ──────────────────────
  // Each WhatsApp number has an isolated session (order stage + draft).
  // Falls back to an empty default session if Redis is temporarily down.
  let session;
  try {
    session = await getSession(from);
  } catch (err) {
    console.error("❌ Redis getSession failed:", err.message);
    // Degraded mode: continue with empty session (order flow restarts)
    session = { stage: null, draft: {} };
  }

  // ── Step 6: Route message → get reply ────────────────────
  // Deterministic dispatcher — no AI, pure regex + state machine.
  let reply;
  let newSession;

  try {
    ({ reply, newSession } = await route(userText, session, from));
  } catch (err) {
    console.error("❌ Router error:", err.message);
    // Generic fallback — don't expose internal errors to customers
    reply      = "Sorry, something went wrong. Please try again. 🙏";
    newSession = session; // preserve existing session state on error
  }

  // ── Step 7: Persist updated session to Redis ─────────────
  // Refresh TTL on every message so active conversations never expire.
  // Completed/cancelled orders clear their session key entirely.
  try {
    if (newSession.stage === null && Object.keys(newSession.draft || {}).length === 0) {
      // Order complete or no active flow — delete the key to free memory
      await clearSession(from);
    } else {
      // Active order in progress — persist stage and draft fields
      await setSession(from, newSession);
    }
  } catch (err) {
    // Non-fatal — reply is already queued; log for monitoring
    console.error("❌ Redis setSession failed:", err.message);
  }

  // ── Step 8: Send reply to customer via Twilio REST API ───
  // We only reach here via our own API call (Step 7 in lifecycle).
  // Twilio has already received our empty 200 response and stopped.
  // This REST call is completely independent of the webhook response.
  if (shouldSendReply(reply)) {
    try {
      await sendReply(from, reply);
      console.log(`✅ Reply sent to ${from}: "${reply.slice(0, 60)}..."`);
    } catch (err) {
      console.error("❌ Twilio send failed:", err.message);
      // Cannot send a fallback — the reply channel itself failed.
      // Alert via logging/monitoring (PagerDuty, Sentry, etc.)
    }
  } else {
    // Nothing to send — avoids unnecessary Twilio API calls
    console.log(`⏭️  No reply to send for ${from}`);
  }
});

// ── Health check ──────────────────────────────────────────────
// Used by load balancers and monitoring tools to verify the service is up.
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    service:   "Bluemins WhatsApp Bot",
    version:   "2.0.1",
    timestamp: new Date().toISOString(),
  });
});

// ── Root ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ name: "Bluemins WhatsApp Bot", version: "2.0.1" });
});

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  🛒 Bluemins WhatsApp Bot  v2.0.1 (No-AI)   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`\n📡 Port:     ${PORT}`);
  console.log(`🏥 Health:   http://localhost:${PORT}/health`);
  console.log(`📱 Webhook:  POST /twilio/whatsapp`);
  console.log(`\n✅ FIX ACTIVE: Empty HTTP body (no more "OK" messages)\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────
// Ensures Redis connection is properly closed before the process exits,
// preventing connection pool exhaustion in Redis server.
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  await closeRedis();
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
