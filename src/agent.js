import Anthropic from "@anthropic-ai/sdk";
import { lookupProductInfo1,createOrderStub, lookupProductInfo, handoffToHumanStub } from "./tools.js";
import { isWithinBusinessHours } from "./bizHours.js";

const client = new Anthropic({
	apiKey: process.env.ANTHROPIC_API_KEY || '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'

});

function mustHaveEnv(name) {
	if (!process.env[name]) throw new Error(`Missing ${name}`);
}

function brandContext() {
	return {
		name: process.env.BRAND_NAME || "Bluemins",
		phone: process.env.BRAND_PHONE || "N/A",
		address: process.env.BRAND_ADDRESS || "N/A",
		tz: process.env.BRAND_TIMEZONE || "Asia/Kolkata"
	};
}

const PRODUCTS = {
	"1L": { size: "1L", price: 150, sku: "BM-1L" },
	"500ml": { size: "500ml", price: 100, sku: "BM-500" },
	"250ml": { size: "250ml", price: 60, sku: "BM-250" }
};

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
	const field = missing[0];

	switch (field) {
		case "items":
			return "Great! Which Bluemins size interests you? We have:\n• 1L (₹100)\n• 500ml (₹150)\n• 250ml (₹160)\n\nWhich one would you like?";
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

async function extractOrderFields({ userText }) {
	const productSizes = Object.keys(PRODUCTS).join(", ");

	const extractorSystem = `
Extract reservation details from the user's message.
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
- If user mentions box sizes, extract them into items array. Valid sizes: ${productSizes}.
- If user says "cancel", "stop", or "never mind", set cancel=true.
- Parse quantities like "2 boxes of 1L" or "3 x 500ml".
- Extract phone numbers (10 digits, with or without country code).
- If no value present, use null.
- Keep notes for special requests (e.g., "deliver in morning").
`;

	try {
		const response = await client.messages.create({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 500,
			system: extractorSystem.trim(),
			messages: [
				{ role: "user", content: userText }
			]
		});

		const content = response.content[0];
		if (content.type === "text") {
			// Extract JSON from response (Claude might wrap it in ```json blocks)
			const jsonMatch = content.text.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
		}
		return {};
	} catch (error) {
		console.error("Extract order fields error:", error);
		return {};
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
	if (draft.items && Array.isArray(draft.items)) {
		draft.items.forEach(size => {
			if (PRODUCTS[size]) {
				total += PRODUCTS[size].price * (draft.quantity || 1);
			}
		});
	}
	return total;
}

function formatOrderSummary(result, info) {
	const itemsList = result.items
		.map(size => `${size} × ${result.quantity}`)
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

export async function runAgent({ from, userText, session }) {
	mustHaveEnv("ANTHROPIC_API_KEY");
	const info = brandContext();

	// --- Order flow mode ---
	if (session.flow === "ORDER") {
		const parsed = await extractOrderFields({ userText });

		if (parsed.cancel) {
			session.flow = null;
			session.orderDraft = {};
			return {
				reply: "No problem! Your order has been cancelled. Feel free to reach out anytime. 😊",
				newSession: session
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

		const msg = formatOrderSummary(result, info);

		return { reply: msg, newSession: session };
	}

	// --- Normal mode: plan what to do ---
	const withinHours = isWithinBusinessHours();
	const history = session.history.slice(-10);

	const system = `
You are the WhatsApp assistant for "${info.name}" — a premium beverage brand.
Our products:
• 1L Bluemins Box - ₹100
• 500ml Bluemins Box - ₹150
• 250ml Bluemins Box - ₹160

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
}

Business hours: ${withinHours ? "OPEN" : "CLOSED"}.
`;

	try {
		const decision = await client.messages.create({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 1000,
			system: system.trim(),
			messages: [
				...history,
				{ role: "user", content: userText }
			]
		});

		let plan;
		try {
			const content = decision.content[0];
			if (content.type === "text") {
				// Extract JSON from response
				const jsonMatch = content.text.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					plan = JSON.parse(jsonMatch[0]);
				} else {
					throw new Error("No JSON found in response");
				}
			}
		} catch {
			plan = {
				intent: "GENERAL",
				startOrder: false,
				startHandoff: false,
				reply: "Could you tell me a bit more? I'm here to help! 😊"
			};
		}

		// Answer product info if relevant
		if (plan.intent === "PRODUCT_INFO" || plan.question) {
			console.log("Customer intent PRODUCT_INFO ");
			const answer = await lookupProductInfo({ query: plan.question || userText });
			if (answer) {
				session.history = [
					...history,
					{ role: "user", content: userText },
					{ role: "assistant", content: answer }
				];
				return { reply: answer, newSession: session };
			}
		}

		// Start order flow
		if (plan.startOrder || plan.intent === "ORDER") {
			console.log("Customer intent ORDER ");
			session.flow = "ORDER";

			const initialParsed = await extractOrderFields({ userText });
			if (initialParsed.cancel) {
				session.flow = null;
				session.orderDraft = {};
				const msg = "All good! No order placed. Let me know if you change your mind. 🙌";
				session.history = [...history, { role: "user", content: userText }, { role: "assistant", content: msg }];
				return { reply: msg, newSession: session };
			}

			session.orderDraft = mergeDraft({}, initialParsed);

			const missing = missingOrderFields(session.orderDraft);
			const reply = missing.length > 0
				? nextOrderQuestion(missing)
				: "Perfect! Let me confirm — which size box would you like?";

			session.history = [
				...history,
				{ role: "user", content: userText },
				{ role: "assistant", content: reply }
			];

			// Auto-confirm if all fields are complete
			if (missing.length === 0 && session.orderDraft.items && session.orderDraft.quantity) {
				const result = await createOrderStub({ from, draft: session.orderDraft });

				session.flow = null;
				session.orderDraft = {};

				const msg = formatOrderSummary(result, info);

				session.history = [...history, { role: "user", content: userText }, { role: "assistant", content: msg }];
				return { reply: msg, newSession: session };
			}

			return { reply, newSession: session };
		}

		// Start human handoff
		if (plan.startHandoff || plan.intent === "HANDOFF") {
			console.log("Customer intent HANDOFF ");
			const summary = plan.handoffSummary || userText;
			const result = await handoffToHumanStub({ from, summary });

			const reply = result.available
				? `Thanks for reaching out! A team member will respond shortly to help you. 🙌\nRef: ${result.handoffId}`
				: `We're currently closed, but we'll get back to you first thing during business hours.\nRef: ${result.handoffId}`;

			session.history = [
				...history,
				{ role: "user", content: userText },
				{ role: "assistant", content: reply }
			];

			return { reply, newSession: session };
		}

		// FAQ
		if (plan.question || plan.intent === "FAQ") {
			console.log("Customer intent FAQ ");
			const summary = userText;
			const result = await lookupProductInfo1({ from, summary });

			const reply = result.available
				? `Thanks for reaching out! A team member will respond shortly to help you. 🙌\nRef: ${result.handoffId}`
				: `We're currently closed, but we'll get back to you first thing during business hours.\nRef: ${result.handoffId}`;

			session.history = [
				...history,
				{ role: "user", content: userText },
				{ role: "assistant", content: reply }
			];

			return { reply, newSession: session };
		}
		// Default reply
		const reply =
			typeof plan.reply === "string" && plan.reply.trim()
				? plan.reply.trim()
				: `How can I help you with Bluemins today? 😊`;

		session.history = [
			...history,
			{ role: "user", content: userText },
			{ role: "assistant", content: reply }
		];

		return { reply, newSession: session };
	} catch (error) {
		console.error("Agent decision error:", error);

		// Fallback response
		const reply = "I'm having trouble processing that. Could you rephrase? 😊";
		session.history = [
			...history,
			{ role: "user", content: userText },
			{ role: "assistant", content: reply }
		];

		return { reply, newSession: session };
	}
}