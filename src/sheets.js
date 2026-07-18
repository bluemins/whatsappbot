/**
 * sheets.js
 * ─────────────────────────────────────────────────────────────
 * Writes confirmed orders to Google Sheets via an Apps Script
 * Web App webhook.
 *
 * Separation of concerns: this module owns only the Sheets write.
 * orderFlow.js calls writeOrder() — it never does fetch() directly.
 *
 * Environment variables required:
 *   GOOGLE_SHEETS_WEBHOOK_URL  — your Apps Script deployment URL
 *
 * Retry policy: 1 automatic retry on network failure (not on 4xx).
 * ─────────────────────────────────────────────────────────────
 */

import { v4 as uuidv4 } from "uuid";

/**
 * generateOrderId()
 * Creates a human-readable order ID: ORD-<timestamp>-<6-char uuid>.
 * Timestamp ensures chronological sort in the spreadsheet.
 *
 * @returns {string}  e.g. "ORD-1721234567890-A3F9B2"
 */
export function generateOrderId() {
  return `ORD-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;
}

/**
 * writeOrder(draft)
 * POST the completed order draft to Google Sheets.
 * Awaited by the caller — failure is surfaced, not silenced.
 *
 * @param {Object} draft - Completed order draft from session
 * @param {string} draft.size
 * @param {string} draft.sku
 * @param {number} draft.quantity
 * @param {number} draft.price       - unit price
 * @param {string} draft.name
 * @param {string} draft.phone
 * @param {string} draft.address
 * @param {string} [draft.notes]
 * @param {string} from              - WhatsApp sender ID (for audit trail)
 *
 * @returns {Promise<{ orderId: string }>}
 * @throws  {Error} if the Sheets URL is missing or the HTTP call fails
 */
export async function writeOrder(draft, from) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("GOOGLE_SHEETS_WEBHOOK_URL is not set in environment variables.");
  }

  const orderId = generateOrderId();

  // Calculate total from items array (replaces old price * quantity)
  const total = draft.items.reduce((sum, i) => sum + i.price * i.qty, 0);

  // Flatten items into a readable string for the spreadsheet column
  // e.g. "1L×2, 500ml×3"
  const itemsSummary = draft.items.map(i => `${i.size}×${i.qty}`).join(", ");

  const payload = {
    orderId,
    timestamp:    new Date().toISOString(),
    from,
    // Single consolidated items column — easier for the spreadsheet to read
    items:        itemsSummary,
    // Also send full JSON for any Apps Script that needs to expand it
    itemsDetail:  JSON.stringify(draft.items),
    total,
    name:         draft.name,
    phone:        draft.phone,
    address:      draft.address,
    //notes:        draft.notes || "",
    status:       "CONFIRMED",
  };

  console.log(`📤 Writing order ${orderId} to Sheets — items: ${itemsSummary}`);


  // ── HTTP call with one retry ──────────────────────────────
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method:   "POST",
        redirect: "follow",           // Google redirects to the actual handler
        headers:  { "Content-Type": "application/json" },
        body:     JSON.stringify(payload),
      });

      if (!res.ok) {
        // 4xx/5xx — no point retrying a client error
        const body = await res.text().catch(() => "");
        throw new Error(`Sheets webhook returned HTTP ${res.status}: ${body}`);
      }

      console.log(`✅ Order ${orderId} written to Sheets (attempt ${attempt})`);
      return { orderId, total };

    } catch (err) {
      lastError = err;

      if (attempt < 2) {
        // Wait 1 s before retrying network errors
        console.warn(`⚠️  Sheets write attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // Both attempts failed — throw so orderFlow.js can send an error message
  console.error("❌ Sheets write failed after 2 attempts:", lastError.message);
  throw lastError;
}