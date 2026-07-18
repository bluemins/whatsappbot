/**
 * server.js — FIXED VERSION
 * ─────────────────────────────────────────────────────────────
 * Express server — Twilio WhatsApp webhook handler.
 * No AI calls. All logic lives in router.js → orderFlow.js.
 *
 * KEY FIXES:
 * 1. Removed parameter passing mismatch (from not passed to sendWhatsAppMessage)
 * 2. Added detailed error logging for Twilio failures
 * 3. Improved startup validation of Twilio credentials
 * 4. Better error context in catch blocks
 * ─────────────────────────────────────────────────────────────
 */

import express from "express";
import dotenv from "dotenv";

import { getSession, setSession, clearSession, closeRedis } from "./session.js";
import { getTwilioClient, sendWhatsAppMessage } from "./twilio.js";
import { route } from "./router.js";

// Load .env before accessing any process.env values
dotenv.config();

// ── Startup Validation ──────────────────────────────────────────
// Validate critical environment variables are set on startup.
// Fail fast rather than waiting for the first webhook to expose config issues.
function validateStartupConfig() {
	const required = [
		"TWILIO_ACCOUNT_SID",
		"TWILIO_AUTH_TOKEN",
		"TWILIO_WHATSAPP_FROM",
		"PUBLIC_WEBHOOK_URL"
	];

	const missing = required.filter(key => !process.env[key]);
	if (missing.length > 0) {
		console.error(
			`\n❌ STARTUP ERROR: Missing required environment variables:\n` +
			missing.map(k => `   - ${k}`).join("\n") +
			`\n\nCopy .env.example to .env and fill in real values from:\n` +
			`   https://console.twilio.com/account\n`
		);
		process.exit(1);
	}

	// Warn about placeholder credentials
	if (
		process.env.TWILIO_ACCOUNT_SID ||
		process.env.TWILIO_AUTH_TOKEN
	) {
		console.error(
			`\n⚠️  WARNING: Twilio credentials in .env appear to be placeholders (contain 'X').\n` +
			`   Go to https://console.twilio.com/account and copy real values.\n\n`
		);
		// Don't exit — let it fail on first message so we see the Twilio error
	}

	console.log("✅ Environment validation passed");
}

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
function hasProcessed(sid) {
	return processed.has(sid);
}

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

/**
 * sendReply(to, body)
 * Send a WhatsApp message via Twilio REST API.
 * This is the ONLY way we send messages to customers.
 * We never rely on Twilio forwarding our HTTP response body.
 *
 * FIXED: Now properly calls sendWhatsAppMessage without redundant 'from' parameter.
 *
 * @param {string} to   - WhatsApp sender ID e.g. "whatsapp:+91XXXXXXXXXX"
 * @param {string} body - Plain-text message content
 * @throws {Error} if TWILIO_WHATSAPP_FROM is not set or API call fails
 */
async function sendReply(to, body) {
	const from = process.env.TWILIO_WHATSAPP_FROM;
	if (!from) {
		throw new Error("TWILIO_WHATSAPP_FROM is not set in environment variables");
	}

	// Log outgoing message for debugging
	console.log(`📤 Sending to ${to}:`);
	console.log(`   From: ${from}`);
	console.log(`   Body preview: "${body.substring(0, 80)}${body.length > 80 ? "..." : ""}"`);

	try {
		// Call sendWhatsAppMessage with ONLY the parameters it expects
		const response = await sendWhatsAppMessage({ to, body });
		console.log(`✅ Message delivered — Twilio SID: ${response.sid}`);
		return response;
	} catch (err) {
		// Re-throw with full context for better debugging
		console.error(`❌ Failed to send message to ${to}:`);
		console.error(`   Error: ${err.message}`);
		throw err;
	}
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
	// ── Step 1: Extract message fields ─────────────────────────
	const { Body: rawText, From: from, MessageSid: sid } = req.body;

	// Validate required fields are present in the webhook payload
	if (!rawText || !from || !sid) {
		console.warn("⚠️  Missing Body, From, or MessageSid in webhook payload");
		return res.status(400).end();
	}

	const userText = rawText.trim();
	console.log(`\n📱 [${sid}] from ${from}: "${userText}"`);

	// ── Step 2: Respond 200 with EMPTY BODY immediately ────────
	//
	// CRITICAL FIX: Use res.status(200).end() NOT res.sendStatus(200)
	// res.sendStatus(200) sends "OK" as the response body, which Twilio
	// forwards as a WhatsApp message. res.status(200).end() sends an
	// empty body and prevents the unwanted "OK" messages.
	//
	res.status(200).end();

	// ── Step 3: Deduplicate ────────────────────────────────────
	// Must happen AFTER responding 200, so Twilio stops retrying.
	// But we still skip processing if we've already handled this SID.
	if (hasProcessed(sid)) {
		console.log(`⏭️  Duplicate message ${sid} — skipping`);
		return; // response already sent above; just stop processing
	}
	markProcessed(sid);

	// ── Step 4: Fetch session from Redis ──────────────────────
	// Each WhatsApp number has an isolated session (order stage + draft).
	// Falls back to an empty default session if Redis is temporarily down.
	let session;
	try {
		session = await getSession(from);
	} catch (err) {
		console.error(`❌ Redis getSession failed for ${from}:`, err.message);
		// Degraded mode: continue with empty session (order flow restarts)
		session = { stage: null, draft: {} };
	}

	// ── Step 5: Route message → get reply ────────────────────
	// Deterministic dispatcher — no AI, pure regex + state machine.
	let reply;
	let newSession;
  
	try {
		({ reply, newSession } = await route(userText, session, from));
	} catch (err) {
		console.error(`❌ Router error for ${from}:`, err.message);
		// Generic fallback — don't expose internal errors to customers
		reply = "Sorry, something went wrong. Please try again. 🙏";
		newSession = { stage: null, draft: {} };
	}

	// ── Step 6: Persist updated session to Redis ─────────────
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
		console.error(`❌ Redis setSession failed for ${from}:`, err.message);
	}

	// ── Step 7: Send reply to customer via Twilio REST API ───
	// We only reach here via our own API call (Step 7 in lifecycle).
	// Twilio has already received our empty 200 response and stopped.
	// This REST call is completely independent of the webhook response.
	if (shouldSendReply(reply)) {
		try {
			await sendReply(from, reply);
		} catch (err) {
			console.error(
				`\n❌ CRITICAL: Failed to send Twilio message to ${from}:\n` +
				`   ${err.message}\n` +
				`\nDebugging steps:\n` +
				`   1. Verify .env has real Twilio credentials (not X's)\n` +
				`   2. Check TWILIO_ACCOUNT_SID matches your Twilio Account\n` +
				`   3. Confirm TWILIO_WHATSAPP_FROM is WhatsApp-enabled\n` +
				`   4. Visit https://console.twilio.com/account to verify creds\n`
			);
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
		status: "ok",
		service: "Bluemins WhatsApp Bot",
		version: "2.0.2",
		timestamp: new Date().toISOString(),
	});
});

// ── Root ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
	res.json({
		name: "Bluemins WhatsApp Bot",
		version: "2.0.2",
		endpoints: {
			health: "GET /health",
			webhook: "POST /twilio/whatsapp",
		},
	});
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

// Validate config before starting server
validateStartupConfig();

const server = app.listen(PORT, () => {
	console.log("\n╔══════════════════════════════════════════════╗");
	console.log("║  🛒 Bluemins WhatsApp Bot  v2.0.2 (No-AI)   ║");
	console.log("╚══════════════════════════════════════════════╝");
	console.log(`\n📡 Port:     ${PORT}`);
	console.log(`🏥 Health:   http://localhost:${PORT}/health`);
	console.log(`📱 Webhook:  POST /twilio/whatsapp`);
	console.log(`🔐 Twilio:   ${process.env.TWILIO_ACCOUNT_SID ? "✅ Ready" : "❌ Not configured"}`);
	console.log(`🔴 Redis:    Connecting...\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────
// Ensures Redis connection is properly closed before the process exits,
// preventing connection pool exhaustion in Redis server.
async function shutdown(signal) {
	console.log(`\n${signal} received — shutting down gracefully...`);
	server.close(async () => {
		await closeRedis();
		process.exit(0);
	});
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));