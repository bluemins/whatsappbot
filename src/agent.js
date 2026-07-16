import Anthropic from "@anthropic-ai/sdk";
import {
  lookupProductInfo,
  lookupProductInfo1,
  createOrderStub,
  handoffToHumanStub,
} from "./tools.js";
import { isWithinBusinessHours } from "./bizHours.js";

// ─── Client ─────────────────────────────────────────────────────────────────
// SECURITY: Never hardcode API keys. Use environment variables only.
const client = new Anthropic(); // reads ANTHROPIC_API_KEY automatically

function mustHaveEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

// ─── Brand context ───────────────────────────────────────────────────────────
function brandContext() {
  return {
    name: process.env.BRAND_NAME || "Bluemins",
    phone: process.env.BRAND_PHONE || "N/A",
    address: process.env.BRAND_ADDRESS || "N/A",
    tz: process.env.BRAND_TIMEZONE || "Asia/Kolkata",
  };
}

// ─── Products ────────────────────────────────────────────────────────────────
const PRODUCTS = {
  "1L": { size: "1L", price: 150, sku: "BM-1L" },
  "500ml": { size: "500ml", price: 100, sku: "BM-500" },
  "250ml": { size: "250ml", price: 60, sku: "BM-250" },
};

// ─── Static cached system prompts ────────────────────────────────────────────
// These are built once per process and reused. The `cache_control` flag tells
// Anthropic to cache them server-side — cached input tokens cost ~90% less.

const EXTRACTOR_SYSTEM_BLOCKS = [
  {
    type: "text",
    text: `Extract reservation details from the user's message.
Return JSON only:
{
  "items": ["1L"|"500ml"|"250ml"]|null,
  "quantity": number|null,
  "name": string|null,
  "phone": string|null,
  "address": string|null,
  "notes": string|null,
  "cancel": boolean
}
Rules:
- If user mentions box sizes, extract them into items array. Valid sizes: ${Object.keys(PRODUCTS).join(", ")}.
- If user says "cancel", "stop", or "never mind", set cancel=true.
- Parse quantities like "2 boxes of 1L" or "3 x 500ml".
- Extract phone numbers (10 digits, with or without country code).
- If no value present, use null.
- Keep notes for special requests (e.g., "deliver in morning").`,
    cache_control: { type: "ephemeral" }, // cache this large static block
  },
];

function buildDecisionSystemBlocks(info, withinHours) {
  // The static brand/product section is cacheable; only the business-hours
  // line changes per request, so we split into two blocks.
  return [
    {
      type: "text",
      text: `You are the WhatsApp assistant for "${info.name}" — a premium beverage brand.
Our products:
• 1L Bluemins Box  - ₹${PRODUCTS["1L"].price}
• 500ml Bluemins Box - ₹${PRODUCTS["500ml"].price}
• 250ml Bluemins Box - ₹${PRODUCTS["250ml"].price}

You can:
1) Answer product questions (sizes, pricing, details, freshness).
2) Start an order flow (when user wants to buy).
3) Answer FAQs (delivery time, return policy, payment methods).
4) Start human handoff for special requests.

Communication style: Professional, friendly, warm, and concise.
Keep responses short. Ask one clear question at a time.

Return ONLY a valid JSON object with no markdown formatting:
{
  "intent": "PRODUCT_INFO"|"FAQ"|"ORDER"|"HANDOFF"|"GENERAL",
  "startOrder": boolean,
  "startHandoff": boolean,
  "question": string|null,
  "handoffSummary": string|null,
  "reply": string
}`,
      cache_control: { type: "ephemeral" }, // cache the large static block
    },
    {
      type: "text",
      // This tiny dynamic block is NOT cached — it changes every call
      text: `\nBusiness hours: ${withinHours ? "OPEN" : "CLOSED"}.`,
    },
  ];
}

// ─── Order helpers ────────────────────────────────────────────────────────────
function missingOrderFields(draft) {
  const missing = [];
  if (!draft.items || draft.items.length === 0) missing.push("items");
  if (!draft.quantity) missing.push("quantity");
  if (!draft.name) missing.push("name");
  if (!draft.phone) missing.push("phone");
  if (!draft.address) missing.push("address");
  return missing;
}

function nextOrderQuestion(missing) {
  switch (missing[0]) {
    case "items":
      // Prices match PRODUCTS constant
      return (
        `Great! Which Bluemins size interests you? We have:\n` +
        `• 1L (₹${PRODUCTS["1L"].price})\n` +
        `• 500ml (₹${PRODUCTS["500ml"].price})\n` +
        `• 250ml (₹${PRODUCTS["250ml"].price})\n\n` +
        `Which one would you like?`
      );
    case "quantity":
      return "Perfect! How many boxes would you like to order?";
    case "name":
      return "Thanks! What's your name, please?";
    case "phone":
      return "And your contact number?";
    case "address":
      return "Finally, what's your delivery address?";
    default:
      return "Got it — anything else you'd like to add?";
  }
}

function mergeDraft(draft, parsed) {
  const next = { ...draft };
  for (const key of ["items", "quantity", "name", "phone", "address", "notes"]) {
    const v = parsed?.[key];
    if (v !== null && v !== undefined && v !== "") {
      if (key === "items" && Array.isArray(v)) {
        next[key] = v;
      } else if (key !== "items") {
        next[key] = v;
      }
    }
  }
  return next;
}

function calculateOrderTotal(draft) {
  let total = 0;
  if (Array.isArray(draft.items)) {
    draft.items.forEach((size) => {
      if (PRODUCTS[size]) {
        total += PRODUCTS[size].price * (draft.quantity || 1);
      }
    });
  }
  return total;
}

function formatOrderSummary(result, info) {
  const itemsList = result.items
    .map((size) => `${size} × ${result.quantity}`)
    .join(", ");
  const total = calculateOrderTotal(result);

  return (
    `✅ **Order Confirmed!**\n\n` +
    `📦 **Order Details:**\n` +
    `Items: ${itemsList}\n` +
    `Total: ₹${total}\n` +
    `Name: ${result.name}\n` +
    `Phone: ${result.phone}\n` +
    `Address: ${result.address}\n` +
    `Order ID: ${result.orderId}\n\n` +
    `Thank you for choosing ${info.name}! We'll deliver your order soon.\n` +
    `You'll receive updates on your phone shortly.\n\n` +
    `Anything else I can help with?`
  );
}

// ─── Shared LLM call: extract order fields ────────────────────────────────────
async function extractOrderFields({ userText }) {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: EXTRACTOR_SYSTEM_BLOCKS, // cached static blocks
      messages: [{ role: "user", content: userText }],
    });

    const content = response.content[0];
    if (content.type === "text") {
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
    return {};
  } catch (error) {
    console.error("extractOrderFields error:", error);
    return {};
  }
}

// ─── Main agent ───────────────────────────────────────────────────────────────
export async function runAgent({ from, userText, session }) {
  mustHaveEnv("ANTHROPIC_API_KEY");
  const info = brandContext();

  // Keep last 10 turns; compute once and reuse throughout
  const history = session.history.slice(-10);

  // ── ORDER flow mode ──────────────────────────────────────────────────────
  if (session.flow === "ORDER") {
    const parsed = await extractOrderFields({ userText });

    if (parsed.cancel) {
      session.flow = null;
      session.orderDraft = {};
      return {
        reply: "No problem! Your order has been cancelled. Feel free to reach out anytime. 😊",
        newSession: session,
      };
    }

    session.orderDraft = mergeDraft(session.orderDraft, parsed);
    const missing = missingOrderFields(session.orderDraft);

    if (missing.length > 0) {
      return { reply: nextOrderQuestion(missing), newSession: session };
    }

    const result = await createOrderStub({ from, draft: session.orderDraft });
    session.flow = null;
    session.orderDraft = {};

    return { reply: formatOrderSummary(result, info), newSession: session };
  }

  // ── Normal mode: decide intent ───────────────────────────────────────────
  const withinHours = isWithinBusinessHours();
  const systemBlocks = buildDecisionSystemBlocks(info, withinHours);

  let plan;
  try {
    const decision = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: systemBlocks, // first block cached, second is tiny + dynamic
      messages: [
        ...history,
        { role: "user", content: userText },
      ],
    });

    const content = decision.content[0];
    if (content.type === "text") {
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) plan = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error("Agent decision error:", err);
  }

  // Fallback plan if parsing failed
  if (!plan) {
    plan = {
      intent: "GENERAL",
      startOrder: false,
      startHandoff: false,
      reply: "Could you tell me a bit more? I'm here to help! 😊",
    };
  }

  // Helper to update history and return
  const respond = (reply) => {
    session.history = [
      ...history,
      { role: "user", content: userText },
      { role: "assistant", content: reply },
    ];
    return { reply, newSession: session };
  };

  // ── PRODUCT_INFO ─────────────────────────────────────────────────────────
  if (plan.intent === "PRODUCT_INFO" || plan.question) {
    console.log("Customer intent: PRODUCT_INFO");
    const answer = await lookupProductInfo({ query: plan.question || userText });
    if (answer) return respond(answer);
  }

  // ── ORDER ────────────────────────────────────────────────────────────────
  if (plan.startOrder || plan.intent === "ORDER") {
    console.log("Customer intent: ORDER");
    session.flow = "ORDER";

    const initialParsed = await extractOrderFields({ userText });

    if (initialParsed.cancel) {
      session.flow = null;
      session.orderDraft = {};
      return respond("All good! No order placed. Let me know if you change your mind. 🙌");
    }

    session.orderDraft = mergeDraft({}, initialParsed);
    const missing = missingOrderFields(session.orderDraft);

    // All fields came in a single message — confirm immediately
    if (missing.length === 0) {
      const result = await createOrderStub({ from, draft: session.orderDraft });
      session.flow = null;
      session.orderDraft = {};
      return respond(formatOrderSummary(result, info));
    }

    return respond(nextOrderQuestion(missing));
  }

  // ── HANDOFF ──────────────────────────────────────────────────────────────
  if (plan.startHandoff || plan.intent === "HANDOFF") {
    console.log("Customer intent: HANDOFF");
    const summary = plan.handoffSummary || userText;
    const result = await handoffToHumanStub({ from, summary });

    const reply = result.available
      ? `Thanks for reaching out! A team member will respond shortly to help you. 🙌\nRef: ${result.handoffId}`
      : `We're currently closed, but we'll get back to you first thing during business hours.\nRef: ${result.handoffId}`;

    return respond(reply);
  }

  // ── FAQ ──────────────────────────────────────────────────────────────────
  if (plan.intent === "FAQ") {
    console.log("Customer intent: FAQ");
    // lookupProductInfo1 returns product/FAQ info, not a handoff result
    const answer = await lookupProductInfo1({ query: plan.question || userText });
    if (answer) return respond(answer);
  }

  // ── Default ──────────────────────────────────────────────────────────────
  const fallback =
    typeof plan.reply === "string" && plan.reply.trim()
      ? plan.reply.trim()
      : `How can I help you with ${info.name} today? 😊`;

  return respond(fallback);
}
