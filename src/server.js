/**
 * server.js
 * ─────────────────────────────────────────────────────────────
 * Express server — Twilio WhatsApp webhook handler.
 * No AI calls. All logic lives in router.js → orderFlow.js.
 *
 * Request lifecycle:
 *   POST /twilio/whatsapp
 *     ↓  validate Twilio signature
 *     ↓  deduplicate (MessageSid check via Redis)
 *     ↓  getSession(from)       ← Redis
 *     ↓  route(text, session, from)  ← deterministic dispatcher
 *     ↓  setSession(from, newSession) ← Redis
 *     ↓  Twilio REST → send reply
 *     ↓  200 OK
 * ─────────────────────────────────────────────────────────────
 */

import express  from "express";
import twilio   from "twilio";
import dotenv   from "dotenv";

import { validateTwilioWebhook } from "./twilio.js";
import { getSession, setSession, clearSession, closeRedis } from "./session.js";
import { route }                 from "./router.js";

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

function hasProcessed(sid) { return processed.has(sid); }
function markProcessed(sid) {
  // Evict oldest entries if the set grows too large
  if (processed.size >= MAX_DEDUP_SIZE) {
    const first = processed.values().next().value;
    processed.delete(first);
  }
  processed.add(sid);
}

// ── Twilio client (reused across requests) ────────────────────
function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

/**
 * sendReply(to, body)
 * Send a WhatsApp message via Twilio REST API.
 * Throws on failure so the caller can handle fallback.
 *
 * @param {string} to   - WhatsApp number (e.g. "whatsapp:+91XXXXXXXXXX")
 * @param {string} body - Message text
 */
async function sendReply(to, body) {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!from) throw new Error("TWILIO_WHATSAPP_FROM is not set");

  await getTwilioClient().messages.create({ from, to, body });
}

// ── Webhook handler ───────────────────────────────────────────
app.post("/twilio/whatsapp", async (req, res) => {

  // ── Step 1: Validate Twilio signature ──────────────────────
  // Rejects any POST not originating from Twilio's servers.
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

  // Validate required fields exist
  if (!rawText || !from || !sid) {
    console.warn("⚠️  Missing Body, From, or MessageSid in webhook payload");
    return res.sendStatus(400);
  }

  const userText = rawText.trim();
  console.log(`📱 [${sid}] from ${from}: ${userText}`);

  // ── Step 3: Deduplicate (Twilio can retry on slow responses) ──
  if (hasProcessed(sid)) {
    console.log(`⏭️  Duplicate message ${sid} — skipping`);
    // Return 200 so Twilio stops retrying
    return res.sendStatus(200);
  }

  // Acknowledge to Twilio immediately to prevent retries (5s timeout)
  // We do the heavy work after sending 200.
  res.sendStatus(200);
  markProcessed(sid);

  // ── Step 4: Fetch session from Redis ──────────────────────
  let session;
  try {
    session = await getSession(from);
  } catch (err) {
    console.error("❌ Redis getSession failed:", err.message);
    // Continue with empty session — degraded but functional
    session = { stage: null, draft: {} };
  }

  // ── Step 5: Route message → get reply ────────────────────
  let reply;
  let newSession;

  try {
    ({ reply, newSession } = await route(userText, session, from));
  } catch (err) {
    console.error("❌ Router error:", err.message);
    reply      = "Sorry, something went wrong. Please try again. 🙏";
    newSession = session; // preserve existing session on error
  }

  // ── Step 6: Persist updated session to Redis ─────────────
  try {
    // If newSession.stage is null and draft is empty, clear the key
    // to avoid accumulating stale empty sessions in Redis
    if (newSession.stage === null && Object.keys(newSession.draft || {}).length === 0) {
      await clearSession(from);
    } else {
      await setSession(from, newSession);
    }
  } catch (err) {
    // Non-fatal — the reply is already queued; log and continue
    console.error("❌ Redis setSession failed:", err.message);
  }

  // ── Step 7: Send reply to customer via Twilio ────────────
  try {
    await sendReply(from, reply);
    console.log(`✅ Reply sent to ${from}`);
  } catch (err) {
    console.error("❌ Twilio send failed:", err.message);
    // At this point we can't send a fallback (reply channel is broken)
    // Alert via logging / monitoring
  }
});

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    service:   "Bluemins WhatsApp Bot",
    timestamp: new Date().toISOString(),
  });
});

// ── Root ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ name: "Bluemins WhatsApp Bot", version: "2.0.0" });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   🛒 Bluemins WhatsApp Bot  v2.0 (No-AI) ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`\n📡 Port:     ${PORT}`);
  console.log(`🏥 Health:   http://localhost:${PORT}/health`);
  console.log(`📱 Webhook:  POST /twilio/whatsapp\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────
// Close Redis before process exits to avoid connection leaks
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  await closeRedis();
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));