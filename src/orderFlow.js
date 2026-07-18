/**
 * orderFlow.js — updated for multi-item support
 *
 * Key change: draft.items is now an array of { size, sku, price, qty }
 * instead of flat size/price/sku/quantity fields.
 *
 * draft = {
 *   items: [{ size: "1L", sku: "BM-1L", price: 100, qty: 2 },
 *           { size: "500ml", sku: "BM-500", price: 150, qty: 1 }],
 *   name, phone, address, notes
 * }
 */

import { PRODUCTS, MSG, formatMsg } from "./messages.js";
import { writeOrder }                from "./sheets.js";

export const STAGES = {
  ASK_SIZE:    "ASK_SIZE",
  ASK_QTY:     "ASK_QTY",
  ASK_NAME:    "ASK_NAME",
  ASK_PHONE:   "ASK_PHONE",
  ASK_ADDRESS: "ASK_ADDRESS",
  CONFIRM:     "CONFIRM",
};

/**
 * buildItemOrder(items)
 * Returns a readable list: "1L, 500ml, 250ml"
 * Used in error messages for positional quantity entry.
 *
 * @param {Array<{size}>} items
 * @returns {string}
 */
function buildItemOrder(items) {
  return items.map((i, idx) => `${idx + 1}. ${i.size}`).join(", ");
}

/**
 * buildItemsBreakdown(items)
 * Shows per-item line items with qty and price
 * Format: "• 1L × 2 (₹200)\n• 500ml × 3 (₹450)\n"
 *
 * @param {Array<{size,price,qty}>} items
 * @returns {string}
 */
function buildItemsBreakdown(items) {
  return items
    .map((i) => `• *${i.size}* × ${i.qty}  (₹${i.price * i.qty})\n`)
    .join("");
}

// ── Multi-item size parser ────────────────────────────────────
/**
* parseSizes(text)
 * Tokenizes by whitespace/comma/plus/ampersand/and-word.
 * Each token is looked up in PRODUCTS by digit key or size label.
 * Does NOT collapse whitespace — that was the bug.
 *
 * Examples:
 *   "1 and 2"  → [1L, 500ml]   ✅
 *   "1"        → [1L]          ✅
 *   "1, 3"     → [1L, 250ml]   ✅
 *   "1L"       → [1L]          ✅
 *   "all"      → [1L, 500ml, 250ml] ✅
 *
 * @param {string} text
 * @returns {Array<{label, price, sku}>}
 */
function parseSizes(text) {
  const lower = text.trim().toLowerCase();

  // "all" shortcut
  if (/\ball\b/.test(lower)) {
    return [PRODUCTS["1"], PRODUCTS["2"], PRODUCTS["3"]];
  }

  const found = [];
  const seen  = new Set(); // prevent duplicates e.g. "1 and 1"

  // Split on: whitespace, comma, plus, ampersand, or the word "and"
  // filter(Boolean) removes the empty strings that the split produces
  const tokens = lower.split(/[\s,+&]+|\band\b/).filter(Boolean);

  for (const token of tokens) {
    const product = PRODUCTS[token]; // matches "1","2","3","1l","500ml","250ml"
    if (product && !seen.has(product.sku)) {
      found.push(product);
      seen.add(product.sku);
    }
  }

  return found;
}

/**
 * buildItemsSummary(items)
 * "1L, 500ml" — used in the ASK_QTY prompt so customer knows what they picked.
 *
 * @param {Array<{size}>} items
 * @returns {string}
 */
function buildItemsSummary(items) {
  return items.map(i => i.size).join(", ");
}

// ── Multi-item quantity parser ────────────────────────────────
/**
 * parseQuantities(text, items)
 * ─────────────────────────────────────────────────────────────
 * Parse customer input and apply quantities to items.
 *
 * Handles three input patterns:
 *
 *   1. SINGLE: "2" or "5"
 *      → Apply qty to ALL items
 *      → 1L × 2, 500ml × 2, 250ml × 2
 *
 *   2. NAMED: "2 of 1L and 3 of 500ml"
 *            "2 1L, 3 500ml"
 *            "1L: 2, 500ml: 3"
 *      → Apply qty to NAMED items only
 *      → 1L × 2, 500ml × 3, 250ml × [undefined]
 *
 *   3. POSITIONAL: "2, 3, 1"
 *                  "2 3 1"
 *      → Apply by order items are listed
 *      → 1L × 2, 500ml × 3, 250ml × 1
 *
 * @param {string} text  - Customer input
 * @param {Array}  items - Draft items with size/sku/price
 * @returns {Object} { resolved, error, hint }
 *   resolved: null or array of {size,sku,price,qty}
 *   error: null or error message
 *   hint: null or suggestion for retry
 */
function parseQuantities(text, items) {
  const lower = text.toLowerCase().trim();

  // Guard: Reject empty input
  if (!text || !text.trim()) {
    return {
      resolved: null,
      error: "Please enter a quantity.",
      hint: "Try: 2 (for all) or 2 of 1L and 3 of 500ml"
    };
  }

  // ── PATTERN 1: Single number → apply to all items ──────────
  const singleMatch = text.match(/^\s*(\d+)\s*$/);
  if (singleMatch) {
    const qty = parseInt(singleMatch[1], 10);

    // Validate range
    if (qty < 1 || qty > 100) {
      return {
        resolved: null,
        error: `Invalid quantity: ${qty}. Must be 1–100.`,
        hint: null
      };
    }

    const resolved = items.map(item => ({ ...item, qty }));
    return { resolved, error: null, hint: null };
  }

  // ── PATTERN 2: Named quantities ────────────────────────────
  // Matches: "2 of 1L", "3 500ml", "1L: 2", etc.
  const result = new Map(
    items.map(i => [i.sku, { ...i, qty: null }])
  );

  // Regex for: "N of SIZE" or "N SIZE" or "SIZE: N"
  const namedPattern = /(\d+)\s*(?:of\s*)?(1l|500ml|250ml|1\s*liter|half\s*liter)|(\d+)(?:\s+of\s+)?(?:1l|500ml|250ml|1\s*liter|half\s*liter)/gi;
  let matchFound = false;
  let match;

  while ((match = namedPattern.exec(lower)) !== null) {
    const qty  = parseInt(match[1] || match[3], 10);
    let size   = (match[2] || "").toLowerCase();

    // Normalize size strings
    size = size
      .replace(/\s/g, "")
      .replace("1liter", "1l")
      .replace("halfliter", "500ml")
      .replace("liter", "l");

    const product = PRODUCTS[size];
    
    if (product && result.has(product.sku)) {
      // Validate qty range
      if (qty < 1 || qty > 100) {
        return {
          resolved: null,
          error: `Invalid quantity for ${size}: ${qty}. Must be 1–100.`,
          hint: null
        };
      }

      result.get(product.sku).qty = qty;
      matchFound = true;
    }
  }

  // If named pattern matched, check if all items got quantities
  if (matchFound) {
    const resolved = [...result.values()];
    const missingQty = resolved.filter(i => i.qty === null);

    if (missingQty.length > 0) {
      return {
        resolved: null,
        error: `Missing quantity for: ${missingQty.map(i => i.size).join(", ")}`,
        hint: `Try: 2 of 1L and 3 of 500ml and 1 of 250ml`
      };
    }

    return { resolved, error: null, hint: null };
  }

  // ── PATTERN 3: Positional quantities ──────────────────────
  // Matches: "2, 3, 1" or "2 3 1"
  const positional = [
    ...text.matchAll(/\b(\d+)\b/g)
  ].map(m => parseInt(m[1], 10));

  if (positional.length > 0) {
    // Validate: correct number of quantities for items
    if (positional.length !== items.length) {
      return {
        resolved: null,
        error: `Expected ${items.length} quantities, got ${positional.length}`,
        hint: buildItemOrder(items) + ` → Try: ${items.map(() => "2").join(", ")}`
      };
    }

    // Apply positional quantities
    const resolved = items.map((item, idx) => {
      const qty = positional[idx];
      
      if (qty < 1 || qty > 100) {
        throw new Error(`Invalid quantity at position ${idx + 1}: ${qty}`);
      }

      return { ...item, qty };
    });

    return { resolved, error: null, hint: null };
  }

  // ── No pattern matched ──────────────────────────────────────
  return {
    resolved: null,
    error: `I didn't understand: "${text}"`,
    hint: `Try: 2 (all items), 2 of 1L and 3 of 500ml, or 2, 3, 1`
  };
}

/**
 * buildQtySummary(items)
 * "1L × 2, 500ml × 3" — used in ASK_NAME prompt.
 */
function buildQtySummary(items) {
  return items.map(i => `${i.size} × ${i.qty}`).join(", ");
}

/**
 * buildItemsTable(items)
 * Bullet-list suitable for CONFIRM and ASK_NOTES messages.
 * "• Items:  1L × 2  (₹200)\n•         500ml × 3  (₹450)\n"
 */
function buildItemsTable(items) {
  return items.map(i => `• Items:  *${i.size} × ${i.qty}*  (₹${i.price * i.qty})\n`).join("");
}

/**
 * calcTotal(items)
 * Sum price × qty across all line items.
 *
 * @param {Array<{price, qty}>} items
 * @returns {number}
 */
function calcTotal(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

// ── Cancel / confirm helpers ──────────────────────────────────
function isCancelIntent(text) {
  return /\b(cancel|stop|quit|no|nope|nahi|band|done|exit)\b/i.test(text);
}
function isConfirmIntent(text) {
  return /\b(yes|yeah|yep|confirm|ok|okay|haan|ha|sure|correct)\b/i.test(text);
}

// ── Stage handlers ────────────────────────────────────────────

/**
 * handleAskSize — REPLACE the old single-item handler entirely
 * Stores items as array with qty:null (filled in ASK_QTY stage)
 */
function handleAskSize(text, session) {
  // Allow cancel at any stage
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  const products = parseSizes(text);
  console.log(`🔍 parseSizes("${text}") →`, products.map(p => p.sku));   // ← add this

  if (products.length === 0) {
    return { reply: MSG.SIZE_INVALID, session };
  }

  // Map to draft items — qty is null until ASK_QTY fills it in
  const items = products.map(p => ({ size: p.label, sku: p.sku, price: p.price, qty: null }));

  // Build a readable summary for the ASK_QTY prompt e.g. "1L, 500ml"
  const itemsSummary = items.map(i => i.size).join(", ");

  return {
    reply: formatMsg(MSG.ASK_QTY, { ITEMS_SUMMARY: itemsSummary }),
    session: {
      ...session,
      stage: STAGES.ASK_QTY,
      draft: { ...session.draft, items },
    },
  };
}

/**
 * handleAskQty — UPDATED with better error feedback
 */
function handleAskQty(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }

  const items = session.draft.items;
  const itemOrder = buildItemOrder(items);

  // Parse quantities with detailed error handling
  const { resolved, error, hint } = parseQuantities(text, items);

  if (error) {
    // Show error + hint for retry
    const hintLine = hint ? `\n💡 ${hint}` : "";
    return {
      reply: `❌ ${error}${hintLine}`,
      session
    };
  }

  // ✅ All quantities validated and applied
  const qtySummary = resolved
    .map(i => `${i.size} × ${i.qty}`)
    .join(", ");

  const itemsBreakdown = buildItemsBreakdown(resolved);
  const total = calcTotal(resolved);

  return {
    reply: formatMsg(MSG.QTY_CONFIRM, {
      ITEMS_BREAKDOWN: itemsBreakdown,
      TOTAL: total
    }),
    session: {
      ...session,
      stage: STAGES.ASK_NAME,
      draft: { ...session.draft, items: resolved }
    }
  };
}

/**
 * handleAskName — unchanged logic, uses items array for summary
 */
function handleAskName(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }
  const name = text.trim();
  if (name.length < 2 || /^\d+$/.test(name)) {
    return { reply: "Please enter your full name (letters only).", session };
  }
  return {
    reply: formatMsg(MSG.ASK_PHONE, { NAME: name }),
    session: { ...session, stage: STAGES.ASK_PHONE, draft: { ...session.draft, name } },
  };
}

/**
 * handleAskPhone — unchanged
 */
function handleAskPhone(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }
  const digits  = text.replace(/[\s\-().+]/g, "");
  const stripped = digits.replace(/^(0091|91|0)/, "");
  if (!/^\d{10}$/.test(stripped)) {
    return { reply: MSG.PHONE_INVALID, session };
  }
  return {
    reply: MSG.ASK_ADDRESS,
    session: { ...session, stage: STAGES.ASK_ADDRESS, draft: { ...session.draft, phone: stripped } },
  };
}

/**
 * handleAskAddress — now uses items array to build total
 */
function handleAskAddress(text, session) {
  if (isCancelIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }
  // const address = text.trim();
  // if (address.length < 10) {
  //   return { reply: "Please provide a more complete address (street, area, city).", session };
  // }
  const { items, name, phone } = session.draft;
  const total = calcTotal(items);
  const notes = session.draft.notes || "None";

  return {
    reply: formatMsg(MSG.CONFIRM, {
      ITEMS_TABLE: buildItemsTable(items),
      NAME: name,
      PHONE: phone,
      ADDRESS: text,
      TOTAL: total,
    }),
    session: {
      ...session,
      stage: STAGES.CONFIRM,
      draft: { ...session.draft, text, notes },
    },
  };
}

/**
 * handleAskNotes — uses items array
 */
function handleAskNotes(text, session) {
  if (/^(cancel|stop|quit|exit)\b/i.test(text.trim())) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }
  const SKIP = /^(skip|no|none|nil|nahi|nothing|n\/a|-)$/i;
  const notes = SKIP.test(text.trim()) ? "None" : text.trim();
  const { items, name, phone, address } = session.draft;
  const total = calcTotal(items);

  return {
    reply: formatMsg(MSG.CONFIRM, {
      ITEMS_TABLE: buildItemsTable(items),
      NAME: name, PHONE: phone, ADDRESS: address, NOTES: notes, TOTAL: total
    }),
    session: { ...session, stage: STAGES.CONFIRM, draft: { ...session.draft, notes } },
  };
}

/**
 * handleConfirm — writes multi-item order to Sheets
 */
async function handleConfirm(text, session, from) {
  if (isCancelIntent(text) && !isConfirmIntent(text)) {
    return { reply: MSG.CANCELLED, session: { stage: null, draft: {} } };
  }
  if (!isConfirmIntent(text)) {
    return { reply: "Please reply *yes* to confirm your order or *no* to cancel.", session };
  }

  try {
    const { orderId, total } = await writeOrder(session.draft, from);
    return {
      reply: formatMsg(MSG.CONFIRMED, {
        ORDER_ID: orderId,
        ADDRESS: session.draft.address,
        PHONE: session.draft.phone,
        TOTAL: total,
      }),
      session: { stage: null, draft: {} },
    };
  } catch (err) {
    console.error("Order write failed:", err.message);
    return {
      reply:
        "Sorry, there was a problem saving your order. Reply *yes* to retry or " +
        "contact us at " + (process.env.BRAND_PHONE || "our support number") + ".",
      session, // keep session intact for retry
    };
  }
}

// ── Stage dispatch table ──────────────────────────────────────
const HANDLERS = {
  [STAGES.ASK_SIZE]:    (t, s, f) => Promise.resolve(handleAskSize(t, s)),
  [STAGES.ASK_QTY]:     (t, s, f) => Promise.resolve(handleAskQty(t, s)),
  [STAGES.ASK_NAME]:    (t, s, f) => Promise.resolve(handleAskName(t, s)),
  [STAGES.ASK_PHONE]:   (t, s, f) => Promise.resolve(handleAskPhone(t, s)),
  [STAGES.ASK_ADDRESS]: (t, s, f) => Promise.resolve(handleAskAddress(t, s)),
  [STAGES.CONFIRM]:     handleConfirm
};

export function startOrder(session) {
  return {
    reply: MSG.ORDER_START,
    session: { stage: STAGES.ASK_SIZE, draft: { items: [] } },
  };
}

export async function advanceOrder(text, session, from) {

  const handler = HANDLERS[session.stage];
    console.warn("advanceOrder ---------- handler   --- ",handler );
  if (!handler) {
    console.warn(`Unknown session stage: ${session.stage} — resetting`);
    return { reply: MSG.FALLBACK, session: { stage: null, draft: {} } };
  }
  return handler(text, session, from);
}