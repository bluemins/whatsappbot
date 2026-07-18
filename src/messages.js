/**
 * messages.js
 * ─────────────────────────────────────────────────────────────
 * Single source of truth for every outbound message string.
 * Edit wording here; never scatter strings across logic files.
 *
 * Template tokens:  {{KEY}}  are replaced by formatMsg() below.
 * ─────────────────────────────────────────────────────────────
 */

// ── Product catalogue (prices in ₹) ──────────────────────────
export const PRODUCTS = {
  "1":     { label: "1L",    price: 100, sku: "BM-1L"  },
  "2":     { label: "500ml", price: 150, sku: "BM-500" },
  "3":     { label: "250ml", price: 160, sku: "BM-250" },
  // Also accept the label itself as a key for direct text input
  "1l":    { label: "1L",    price: 100, sku: "BM-1L"  },
  "500ml": { label: "500ml", price: 150, sku: "BM-500" },
  "250ml": { label: "250ml", price: 160, sku: "BM-250" },
};

// ── Message templates ─────────────────────────────────────────
export const MSG = {
  // ── Greeting / fallback ──────────────────────────────────
  WELCOME:
    "👋 Welcome to *Bluemins*!\n\n" +
    "What would you like to do?\n" +
    "• Type *order* or *buy* to place an order\n" +
    "• Type *price* to see our products\n" +
    "• Type *help* for more options",

  FALLBACK:
    "Sorry, I didn't quite get that. 🤔\n" +
    "Type *order* to buy, *price* to see products, or *help* for options.",

  // ── Order flow ────────────────────────────────────────────
 // src/messages.js — updated strings for multi-item support
  ORDER_START:
    "Great! Let's place your order. 🛒\n\n" +
    "Which size(s) would you like?\n" +
    "Reply with *numbers* or *sizes* — you can pick multiple!\n\n" +
    "1️⃣  1L     — ₹100\n" +
    "2️⃣  500ml  — ₹150\n" +
    "3️⃣  250ml  — ₹160\n\n" +
    "Examples: *1* or *1 and 2* or *1L and 500ml*",

  SIZE_INVALID:
    "Please pick one or more sizes:\n\n" +
    "1️⃣  1L     — ₹100\n" +
    "2️⃣  500ml  — ₹150\n" +
    "3️⃣  250ml  — ₹160\n\n" +
    "Try: *1*, *1 and 3*, or *1L, 250ml*",

  // {{ITEMS_SUMMARY}} is e.g. "1L × 2 + 500ml × 1"
  ASK_QTY:
    "You chose: *{{ITEMS_SUMMARY}}* ✅\n\n" +
    "How many boxes would you like? (e.g. *2*)\n" +
    "Same qty for all, or specify: *2 of 1L and 3 of 500ml*",

  QTY_INVALID:
    "Please enter valid quantities (numbers between 1–100).\n" +
    "Example: *2* (applies to all) or *2 of 1L and 3 of 500ml*",

  // {{QTY_SUMMARY}} e.g. "1L × 2, 500ml × 3"
  ASK_NAME:
    "Got it — *{{QTY_SUMMARY}}*. 👍\n\n" +
    "What is your *full name* for the order?",

  CONFIRM:
    "📦 *Order Summary*\n\n" +
    "{{ITEMS_TABLE}}" +
    "• Name:    {{NAME}}\n" +
    "• Phone:   {{PHONE}}\n" +
    "• Address: {{ADDRESS}}\n" +
    "• Notes:   {{NOTES}}\n" +
    "• *Total:  ₹{{TOTAL}}*\n\n" +
    "Reply *yes* to confirm or *no* to cancel.",

  CONFIRMED:
    "✅ *Order Confirmed!*\n\n" +
    "Your order ID is *{{ORDER_ID}}*.\n" +
    "We will deliver to {{ADDRESS}} soon.\n" +
    "You'll receive updates on {{PHONE}}.\n\n" +
    "Thank you for choosing *Bluemins*! 💙",

  CANCELLED:
    "Order cancelled. No problem! 😊\n" +
    "Type *order* any time to start a new order.",

  // ── FAQ replies ───────────────────────────────────────────
  PRICE_LIST:
    "*Bluemins Pricing* 💰\n\n" +
    "• 1L     — ₹100\n" +
    "• 500ml  — ₹150\n" +
    "• 250ml  — ₹160\n\n" +
    "Best value? The *1L box*!\n" +
    "Type *order* to buy.",

  DELIVERY_INFO:
    "*Delivery Info* 🚚\n\n" +
    "• Standard: 1–2 business days\n" +
    "• Free delivery on orders above ₹300\n" +
    "• SMS tracking updates\n\n" +
    "Type *order* to place an order.",

  HELP:
    "*Bluemins Help Menu* 🤖\n\n" +
    "• *order* / *buy*  — Place a new order\n" +
    "• *price*          — See product prices\n" +
    "• *delivery*       — Delivery information\n" +
    "• *cancel*         — Cancel current order\n" +
    "• *status*         — Check order status\n" +
    "• *contact*        — Speak to our team",

  CONTACT:
    "*Contact Bluemins* 📞\n\n" +
    "Phone: {{BRAND_PHONE}}\n" +
    "WhatsApp: This chat\n" +
    "Hours: Mon–Sat 9 AM – 9 PM\n\n" +
    "A team member will respond shortly.",

  OUT_OF_HOURS:
    "We're currently *closed* 🕐\n\n" +
    "Business hours: Mon–Sat 9 AM – 9 PM (IST)\n\n" +
    "You can still place an order and we will process it when we open!",
};

/**
 * formatMsg(template, vars)
 * Replace all {{KEY}} tokens in a template string with values from vars.
 *
 * @param {string} template - A string from MSG containing {{TOKEN}} placeholders
 * @param {Object} vars     - Map of token → replacement value
 * @returns {string}        - Fully resolved message string
 *
 * Example:
 *   formatMsg(MSG.ASK_QTY, { SIZE: "1L", PRICE: "100" })
 *   // → "You chose *1L* (₹100 each). ✅\n\nHow many boxes..."
 */
export function formatMsg(template, vars = {}) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    // Return the replacement if present, else leave the token intact for debugging
    return vars[key] !== undefined ? vars[key] : `{{${key}}}`;
  });
}