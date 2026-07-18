/**
 * orderFlow.js
 * ─────────────────────────────────────────────────────────────
 * Deterministic order-taking state machine.
 * Zero AI involvement — every transition is a regex or keyword check.
 *
 * Stage progression (linear, one direction):
 *
 *   null → ASK_SIZE → ASK_QTY → ASK_NAME → ASK_PHONE
 *       → ASK_ADDRESS → ASK_NOTES → CONFIRM → [DONE / cancel]
 *
 * Each exported function receives (userText, session) and returns:
 *   { reply: string, session: updatedSession }
 *
 * The caller (router.js) is responsible for persisting the session.
 * ─────────────────────────────────────────────────────────────
 */

import { PRODUCTS, MSG, formatMsg } from "./messages.js";
import { writeOrder }                from "./sheets.js";

// ── Stage constants ───────────────────────────────────────────
// Exported so router.js can check session.stage without string literals
export const STAGES = {
  ASK_SIZE:    "ASK_SIZE",
  ASK_QTY:     "ASK_QTY",
  ASK_NAME:    "ASK_NAME",
  ASK_PHONE:   "ASK_PHONE",
  ASK_ADDRESS: "ASK_ADDRESS",
  ASK_NOTES:   "ASK_NOTES",
  CONFIRM:     "CONFIRM",
};

// ── Field parsers ─────────────────────────────────────────────
// Each parser returns the extracted value or null on failure.
// Kept small and testable — no side effects.

/**
 * parseSize(text)
 * Accept:
 *   • Digit reply from the menu (1, 2, 3)
 *   • Direct size label (1l, 500ml, 250ml) — case-insensitive
 *
 * @param {string} text
 * @returns {{ label, price, sku } | null}
 */
function parseSize(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  return PRODUCTS[t] || null;
}

/**
 * parseQty(text)
 * Extract the first integer from the message.
 * Accepts: "2", "two boxes", "order 3", "I want 5 please"
 * Rejects anything > 100 (sanity limit) or < 1.
 *
 * @param {string} text
 * @returns {number | null}
 */
function parseQty(text) {
  // Written numbers map for single-digit convenience
  const wordMap = {
    one:1, two:2, three:3, four:4, five:5,
    six:6, seven:7, eight:8, nine:9, ten:10,
  };

  const lower = text.toLowerCase();

  // Check word numbers first
  for (const [word, num] of Object.entries(wordMap)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return num;
  }

  // Extract first digit sequence
  const match = text.match(/\d+/);
  if (!match) return null;

  const n = parseInt(match[0], 10);
  if (n < 1 || n > 100) return null;
  return n;
}

/**
 * parsePhone(text)
 * Extracts a 10-digit Indian mobile number.
 * Accepts: "+91 9876543210", "09876543210", "9876543210"
 *
 * @param {string} text
 * @returns {string | null}  Normalised 10-digit string or null
 */
function parsePhone(text) {
  // Strip spaces, dashes, dots, parens
  const digits = text.replace(/[\s\-().+]/g, "");

  // Strip country code if present (91 prefix followed by 10 digits)
  const stripped = digits.replace(/^(0091|91|0)/, "");

  if (/^\d{10}$/.test(stripped)) return stripped;
  return null;
}

/**
 * isCancelIntent(text)
 * Detect cancel/stop/no keywords anywhere in the message.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isCancelIntent(text) {
  return /\b(cancel|stop|quit|no|nope|nahi|band|done|exit)\b/i.test(text);
}

/**
 * isConfirmIntent(text)
 * Detect yes/confirm keywords.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isConfirmIntent(text) {
  return /\b(yes|yeah|yep|confirm|ok|okay|haan|ha|sure|correct)\b/i.test(text);
}

// ── Stage handlers ────────────────────────────────────────────
// Each handler is a pure function:  (text, session, from) → { reply, session }
// The session object is treated as immutable — always spread before mutating.

/**
 * handleAskSize
 * Validate the customer's size choice and advance to ASK_QTY.
 */
function handleAskSize(text, session) {
  // Allow cancel at any stage
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  const product = parseSize(text);

  if (!product) {
    // Re-prompt with the menu
    return { reply: MSG.SIZE_INVALID, session };
  }

  // Advance stage, persist chosen product fields in draft
  return {
    reply: formatMsg(MSG.ASK_QTY, { SIZE: product.label, PRICE: product.price }),
    session: {
      ...session,
      stage: STAGES.ASK_QTY,
      draft: { ...session.draft, size: product.label, price: product.price, sku: product.sku },
    },
  };
}

/**
 * handleAskQty
 * Parse quantity and advance to ASK_NAME.
 */
function handleAskQty(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  const qty = parseQty(text);

  if (!qty) {
    return { reply: MSG.QTY_INVALID, session };
  }

  return {
    reply: formatMsg(MSG.ASK_NAME, { QTY: qty, SIZE: session.draft.size }),
    session: {
      ...session,
      stage: STAGES.ASK_NAME,
      draft: { ...session.draft, quantity: qty },
    },
  };
}

/**
 * handleAskName
 * Capture free-text name. Minimal validation: at least 2 chars, no digits.
 */
function handleAskName(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  const name = text.trim();

  if (name.length < 2 || /^\d+$/.test(name)) {
    return {
      reply: "Please enter your full name (letters only).",
      session,
    };
  }

  return {
    reply: formatMsg(MSG.ASK_PHONE, { NAME: name }),
    session: {
      ...session,
      stage: STAGES.ASK_PHONE,
      draft: { ...session.draft, name },
    },
  };
}

/**
 * handleAskPhone
 * Validate 10-digit mobile number and advance to ASK_ADDRESS.
 */
function handleAskPhone(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  const phone = parsePhone(text);

  if (!phone) {
    return { reply: MSG.PHONE_INVALID, session };
  }

  return {
    reply: MSG.ASK_ADDRESS,
    session: {
      ...session,
      stage: STAGES.ASK_ADDRESS,
      draft: { ...session.draft, phone },
    },
  };
}

/**
 * handleAskAddress
 * Capture delivery address (free text, min 10 chars).
 */
function handleAskAddress(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  const address = text.trim();

  if (address.length < 10) {
    return {
      reply: "Please provide a more complete address (street, area, city).",
      session,
    };
  }

  const { size, quantity, name, phone } = session.draft;
  const total = session.draft.price * quantity;

  return {
    reply: formatMsg(MSG.ASK_NOTES, { SIZE: size, QTY: quantity, NAME: name, PHONE: phone, ADDRESS: address, TOTAL: total }),
    session: {
      ...session,
      stage: STAGES.ASK_NOTES,
      draft: { ...session.draft, address },
    },
  };
}

/**
 * handleAskNotes
 * Capture optional special notes. "skip" / "no" / "none" → empty string.
 * Then advance to CONFIRM and show the full order summary.
 */
function handleAskNotes(text, session) {
  if (isCancelIntent(text) && !text.trim().toLowerCase().startsWith("no note")) {
    // "no" here might mean "no notes" rather than cancel — check context
    // If the raw text is just "no", treat as skip, not cancel
    if (/^(cancel|stop|quit|exit)\b/i.test(text.trim())) {
      return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
    }
  }

  const SKIP_PATTERNS = /^(skip|no|none|nil|nahi|nothing|n\/a|-)$/i;
  const notes = SKIP_PATTERNS.test(text.trim()) ? "None" : text.trim();

  const { size, quantity, name, phone, address, price } = session.draft;
  const total = price * quantity;

  return {
    reply: formatMsg(MSG.CONFIRM, { SIZE: size, QTY: quantity, NAME: name, PHONE: phone, ADDRESS: address, NOTES: notes, TOTAL: total }),
    session: {
      ...session,
      stage: STAGES.CONFIRM,
      draft: { ...session.draft, notes },
    },
  };
}

/**
 * handleConfirm
 * Customer replies yes/no to the summary.
 * On "yes": write to Sheets, clear session, send confirmation.
 * On "no": cancel, clear session.
 *
 * This is the only async handler because it calls writeOrder().
 *
 * @param {string} text
 * @param {Object} session
 * @param {string} from    - WhatsApp sender ID (passed to writeOrder for audit)
 * @returns {Promise<{ reply: string, session: Object }>}
 */
async function handleConfirm(text, session, from) {
  if (isCancelIntent(text) && !isConfirmIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  if (!isConfirmIntent(text)) {
    // Neither yes nor no — re-show the prompt
    return {
      reply: "Please reply *yes* to confirm your order or *no* to cancel.",
      session,
    };
  }

  // ── Write to Google Sheets ────────────────────────────────
  try {
    const { orderId, total } = await writeOrder(session.draft, from);

    return {
      reply: formatMsg(MSG.CONFIRMED, {
        ORDER_ID: orderId,
        ADDRESS:  session.draft.address,
        PHONE:    session.draft.phone,
        TOTAL:    total,
      }),
      session: { stage: null, draft: {} }, // clear session on success
    };

  } catch (err) {
    // Sheets write failed — don't lose the order, ask customer to retry
    console.error("Order write failed:", err.message);
    return {
      reply:
        "Sorry, there was a problem saving your order. Please reply *yes* to try again " +
        "or contact us directly at " + (process.env.BRAND_PHONE || "our support number") + ".",
      session, // keep session intact so customer can retry
    };
  }
}

// ── Stage dispatch table ──────────────────────────────────────
// Maps stage name → handler function.
// Sync handlers are wrapped to return a resolved promise for uniform interface.

const HANDLERS = {
  [STAGES.ASK_SIZE]:    (text, session, from) => Promise.resolve(handleAskSize(text, session)),
  [STAGES.ASK_QTY]:     (text, session, from) => Promise.resolve(handleAskQty(text, session)),
  [STAGES.ASK_NAME]:    (text, session, from) => Promise.resolve(handleAskName(text, session)),
  [STAGES.ASK_PHONE]:   (text, session, from) => Promise.resolve(handleAskPhone(text, session)),
  [STAGES.ASK_ADDRESS]: (text, session, from) => Promise.resolve(handleAskAddress(text, session)),
  [STAGES.ASK_NOTES]:   (text, session, from) => Promise.resolve(handleAskNotes(text, session)),
  [STAGES.CONFIRM]:     handleConfirm,  // already returns a Promise
};

/**
 * startOrder(session)
 * Called by router.js when the customer sends an order-intent message.
 * Sets stage to ASK_SIZE and returns the size-selection menu.
 *
 * @param {Object} session - Current session (may be empty)
 * @returns {{ reply: string, session: Object }}
 */
export function startOrder(session) {
  return {
    reply: MSG.ORDER_START,
    session: { stage: STAGES.ASK_SIZE, draft: {} },
  };
}

/**
 * advanceOrder(text, session, from)
 * Main entry point called by router.js when session.stage is not null.
 * Dispatches to the appropriate stage handler.
 *
 * @param {string} text    - Raw message text from customer
 * @param {Object} session - Current session from Redis
 * @param {string} from    - WhatsApp sender ID
 * @returns {Promise<{ reply: string, session: Object }>}
 */
export async function advanceOrder(text, session, from) {
  const handler = HANDLERS[session.stage];

  if (!handler) {
    // Unknown stage — reset and let router handle as fresh message
    console.warn(`Unknown session stage: ${session.stage} — resetting`);
    return {
      reply: MSG.FALLBACK,
      session: { stage: null, draft: {} },
    };
  }

  return handler(text, session, from);
}