/**
 * tools.js - Order and customer interaction stubs
 * Replace these with real database/API calls as needed
 */

import { v4 as uuidv4 } from "uuid";
import { loadFaq ,matchFaq} from "./faq.js";
/**
 * Create an order in the system
 * @param {Object} params - { from, draft }
 * @returns {Object} order confirmation with ID
 */
export async function createOrderStub({ from, draft }) {
	// In production: Save to database, trigger order fulfillment, send SMS/email
	const orderId = `ORD-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

	const order = {
		orderId,
		from,
		items: draft.items,
		quantity: draft.quantity,
		name: draft.name,
		phone: draft.phone,
		address: draft.address,
		notes: draft.notes || "",
		createdAt: new Date().toISOString(),
		status: "PENDING"
	};

	// TODO: Save to DB
	// await db.orders.insert(order);
	// TODO: Send confirmation SMS
	// await sms.send(draft.phone, `Your order ${orderId} has been received!`);
	// TODO: Notify fulfillment team
	// await notifyFulfillmentTeam(order);

	console.log("📦 New order:", order);
//======================================================================
	// Data object matching the keys expected by your Apps Script
const dataToSend = {
		orderId,
		name: draft.name,
		phone: draft.phone,
		address: draft.address,
		items: draft.items,
		quantity: draft.quantity,
		notes: draft.notes
};

// Replace with your copied Google Apps Script Web App URL
//const webAppUrl = "https://script.google.com/macros/s/AKfycbyjEWGmgvpuYvyu22npLrG8cBViUp60N9LikTm78nh0g4zVrlvPptlypfdiynVGXaI/exec";
const webAppUrl = "https://script.google.com/macros/s/AKfycbzpNW1dShUoeziURo80lQMhvhuusJk-AxrzIUA1w9mxO0QGbAfvWgqpYrpVEBlah1-g/exec";
// Send the POST request
const res = await fetch(webAppUrl, {
  method: "POST",
  mode: "cors", // Changed from "no-cors"
  redirect: "follow", // Crucial for Google Apps Script redirects
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(dataToSend),
})
.then(() => {
  console.log("Data successfully sent to Google Sheets!");
})
.catch((error) => {
  console.error("Error sending data:", error);
});

//======================================================================

	return {
		orderId,
		name: draft.name,
		phone: draft.phone,
		address: draft.address,
		items: draft.items,
		quantity: draft.quantity,
		notes: draft.notes
	};
}

export async function lookupProductInfo1({ query }) {
	try {
		const faq = loadFaq();
		const answer = matchFaq(faq, query);
		return answer || null;
	} catch (error) {
		console.error("FAQ lookup error:", error);
		return null;
	}
}

/**
 * Look up product or FAQ information
 * @param {Object} params - { query }
 * @returns {string|null} Answer or null
 */
export async function lookupProductInfo({ query }) {
	const lower = query.toLowerCase();

	// Product information
	if (
		lower.includes("1l") ||
		lower.includes("one liter") ||
		lower.includes("largest")
	) {
		return (
			"**1L Bluemins Box** 📦\n" +
			"Perfect for families or bulk orders!\n" +
			"• Price: ₹100\n" +
			"• Best for: Home use, offices, events\n" +
			"• Fresh, premium quality\n\n" +
			"Would you like to order?"
		);
	}

	if (lower.includes("500ml") || lower.includes("medium")) {
		return (
			"**500ml Bluemins Box** 📦\n" +
			"Great for daily use or small gatherings.\n" +
			"• Price: ₹150\n" +
			"• Best for: Individuals, small groups\n" +
			"• Pure, refreshing taste\n\n" +
			"Ready to place an order?"
		);
	}

	if (lower.includes("250ml") || lower.includes("small")) {
		return (
			"**250ml Bluemins Box** 📦\n" +
			"Portable and convenient!\n" +
			"• Price: ₹160\n" +
			"• Best for: On-the-go, tasting, single servings\n" +
			"• Perfect travel companion\n\n" +
			"Want to try it?"
		);
	}

	// Pricing/comparison
	if (lower.includes("price") || lower.includes("cost")) {
		return (
			"**Bluemins Pricing** 💰\n" +
			"• 250ml: ₹160\n" +
			"• 500ml: ₹150\n" +
			"• 1L: ₹100\n\n" +
			"Best value? The 1L box! Which size interests you?"
		);
	}

	// Delivery
	if (lower.includes("deliver") || lower.includes("shipping")) {
		return (
			"**Delivery Info** 🚚\n" +
			"• Standard delivery: 1-2 business days\n" +
			"• We cover your area for free delivery on orders above ₹300\n" +
			"• You can track your order via SMS\n\n" +
			"Want to place an order?"
		);
	}

	// Quality/freshness
	if (
		lower.includes("fresh") ||
		lower.includes("quality") ||
		lower.includes("safe")
	) {
		return (
			"**Quality Assurance** ✅\n" +
			"• 100% pure and premium\n" +
			"• Tested for freshness and safety\n" +
			"• Packed in sealed, hygienic boxes\n" +
			"• Non-GMO & naturally sourced\n\n" +
			"Ready to experience Bluemins?"
		);
	}

	// Refund/return policy
	if (lower.includes("return") || lower.includes("refund")) {
		return (
			"**Returns & Refunds** 🔄\n" +
			"• Full refund if damaged upon delivery\n" +
			"• 7-day satisfaction guarantee\n" +
			"• No questions asked return policy\n\n" +
			"We stand behind our product quality!"
		);
	}

	// Generic product inquiry
	if (
		lower.includes("bluemins") ||
		lower.includes("product") ||
		lower.includes("what")
	) {
		return (
			"**Bluemins** — Premium Refreshment 💙\n" +
			"We offer three sizes:\n" +
			"• 250ml (₹160) — On-the-go\n" +
			"• 500ml (₹150) — Daily use\n" +
			"• 1L (₹100) — Family packs\n\n" +
			"Which size are you interested in?"
		);
	}

	return null;
}

/**
 * Initiate handoff to human agent
 * @param {Object} params - { from, summary }
 * @returns {Object} handoff details
 */
export async function handoffToHumanStub({ from, summary }) {
	const handoffId = `HO-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

	// TODO: Create support ticket
	// await supportSystem.createTicket({
	//   from,
	//   summary,
	//   channel: 'whatsapp',
	//   priority: 'normal'
	// });

	const available = true; // Check against business hours in real impl

	console.log("🤝 Handoff initiated:", { from, summary, handoffId });

	return {
		handoffId,
		available,
		message: available
			? "A team member will help you shortly"
			: "We'll get back to you during business hours"
	};
}
