/**
 * router.js
 * ─────────────────────────────────────────────────────────────
 * Deterministic intent dispatcher. Zero AI.
 *
 * Decision priority (highest → lowest):
 *   1. Active order session  → advanceOrder()
 *   2. Order-intent keywords → startOrder()
 *   3. FAQ regex patterns    → matchFaq()
 *   4. Fallback              → MSG.FALLBACK
 *
 * Returns: { reply: string, newSession: Object }
 * Caller (server.js) is responsible for persisting newSession to Redis.
 * ─────────────────────────────────────────────────────────────
 */

import { startOrder, advanceOrder } from "./orderFlow.js";
import { loadFaq, matchFaq }         from "./faq.js";
import { MSG, formatMsg }            from "./messages.js";
import { isWithinBusinessHours }     from "./bizHours.js";

// ── Intent patterns ───────────────────────────────────────────
// Each entry: { regex, handler }
// Tested in order against the lowercased, trimmed message.
// First match wins.

const INTENT_PATTERNS = [
  // ── Order intent ────────────────────────────────────────
  {
    // Matches: "order", "buy", "I want to buy", "place order", "i'd like to order"
    regex: /\b(order|buy|purchase|I want|place.?order|book)\b/i,
    intent: "ORDER",
  },

  // ── Price / product info ─────────────────────────────────
  {
    regex: /\b(price|cost|how much|pricing|rate|₹|rupee|rs\.?)\b/i,
    intent: "PRICE",
  },

  // ── Delivery info ────────────────────────────────────────
  {
    regex: /\b(deliver(y)?|ship(ping)?|how long|when.*arrive|dispatch)\b/i,
    intent: "DELIVERY",
  },

  // ── Help ─────────────────────────────────────────────────
  {
    regex: /\b(help|menu|options|what can|commands)\b/i,
    intent: "HELP",
  },

  // ── Contact / human handoff ──────────────────────────────
  {
    regex: /\b(contact|call|speak|human|agent|support|team|manager)\b/i,
    intent: "CONTACT",
  },

  // ── Cancel (outside an active order) ────────────────────
  {
    regex: /\b(cancel|stop|quit|exit)\b/i,
    intent: "CANCEL",
  },

  // ── Greeting ─────────────────────────────────────────────
  {
    regex: /^(hi|hello|hey|hii|helo|good morning|good evening|namaste|namaskar|hola)\b/i,
    intent: "GREETING",
  },
];

/**
 * matchIntent(text)
 * Find the first matching intent pattern or return null.
 *
 * @param {string} text - Raw message text
 * @returns {string | null} intent string or null
 */
function matchIntent(text) {
  for (const { regex, intent } of INTENT_PATTERNS) {
    if (regex.test(text)) return intent;
  }
  return null;
}

/**
 * handleIntent(intent, session)
 * Map an intent string to a reply message.
 * Business-hours check is applied to ORDER intent only.
 *
 * @param {string} intent
 * @param {Object} session
 * @returns {{ reply: string, newSession: Object }}
 */
function handleIntent(intent, session) {
  switch (intent) {
    case "ORDER": {
      const { reply, session: newSession } = startOrder(session);
      return { reply, newSession };
    }

    case "PRICE":
      return { reply: MSG.PRICE_LIST, newSession: session };

    case "DELIVERY":
      return { reply: MSG.DELIVERY_INFO, newSession: session };

    case "HELP":
    case "GREETING":
      return { reply: MSG.WELCOME, newSession: session };

    case "CONTACT": {
      const phone = process.env.BRAND_PHONE || "our support number";
      return {
        reply: formatMsg(MSG.CONTACT, { BRAND_PHONE: phone }),
        newSession: session,
      };
    }

    case "CANCEL":
      // Cancel outside of an order flow — just acknowledge
      return {
        reply: "No active order to cancel. Type *order* to start one! 😊",
        newSession: session,
      };

    default:
      return { reply: MSG.FALLBACK, newSession: session };
  }
}

/**
 * route(text, session, from)
 * Main entry point called by server.js on every inbound message.
 *
 * Priority:
 *  1. Active order session stage  → advanceOrder() (state machine)
 *  2. Keyword/regex intent match  → handleIntent()
 *  3. FAQ pattern match           → faq.js (existing, unchanged)
 *  4. Fallback
 *
 * @param {string} text    - Inbound message body from Twilio
 * @param {Object} session - Current session fetched from Redis
 * @param {string} from    - Twilio sender ID (for writeOrder audit trail)
 * @returns {Promise<{ reply: string, newSession: Object }>}
 */
export async function route(text, session, from) {
  const trimmed = (text || "").trim();
  console.warn("route ---------- stage   --- " , session.stage);
  console.warn("route ---------- trimmed   --- " );
  if (!trimmed) {
    return { reply: MSG.FALLBACK, newSession: session };
  }

  // ── Priority 1: Active order flow ─────────────────────────
  // If the customer is mid-order, every message goes to the state machine.
  // No keyword matching — the state machine owns the conversation.
  if (session.stage !== null) {
    console.warn("route ---------- advanceOrder   --- " );
    const { reply, session: newSession } = await advanceOrder(trimmed, session, from);
    return { reply, newSession };
  }

  // ── Priority 2: Intent matching ───────────────────────────
  const intent = matchIntent(trimmed);
  if (intent) {
    return handleIntent(intent, session);
  }

  // ── Priority 3: FAQ regex matching ───────────────────────
  // Uses existing faq.js + data/faq.json unchanged
  try {
    const faq    = loadFaq();
    const answer = matchFaq(faq, trimmed);
    if (answer) {
      return { reply: answer, newSession: session };
    }
  } catch (err) {
    // FAQ load failure must not crash the bot
    console.error("FAQ error:", err.message);
  }

  // ── Priority 4: Fallback ──────────────────────────────────
  return { reply: MSG.FALLBACK, newSession: session };
}