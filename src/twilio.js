import twilio from "twilio";

/**
 * getTwilioClient()
 * Creates and returns an authenticated Twilio REST client.
 * Validates that all required credentials are present.
 *
 * @returns {twilio.Twilio} Authenticated Twilio client
 * @throws {Error} If TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN are missing
 */
export function getTwilioClient() {
	const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
	console.log(`TWILIO_ACCOUNT_SID:  `,process.env.TWILIO_ACCOUNT_SID);
	console.log(`TWILIO_AUTH_TOKEN:  `,process.env.TWILIO_AUTH_TOKEN);
	// Validate credentials are real (not placeholder X's)
	if (TWILIO_ACCOUNT_SID.includes("X") || TWILIO_AUTH_TOKEN.includes("X")) {
		throw new Error(
			"❌ Missing Twilio credentials. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env"
		);
	}

	// Warn if credentials look like placeholders (safety check)
	if (TWILIO_ACCOUNT_SID.includes("X") || TWILIO_AUTH_TOKEN.includes("X")) {
		console.error(
			"⚠️  CRITICAL: Twilio credentials appear to be placeholders (contain 'X'). ");
	}

	return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * validateTwilioWebhook()
 * Validates incoming Twilio webhook signatures to prevent replay attacks.
 * Call this at the start of your webhook handler.
 *
 * @param {Object} params
 * @param {express.Request} params.req - Express request object
 * @param {string} params.publicUrl - Public URL of your webhook (scheme/host/path)
 * @returns {boolean} true if signature is valid, false otherwise
 */
export function validateTwilioWebhook({ req, publicUrl }) {
	const signature = req.headers["x-twilio-signature"];
	if (!signature) return false;

	const authToken = process.env.TWILIO_AUTH_TOKEN;
	return twilio.validateRequest(authToken, signature, publicUrl, req.body);
}

/**
 * sendWhatsAppMessage()
 * Sends a WhatsApp message via Twilio REST API.
 * Handles auth errors with actionable error messages.
 *
 * @param {Object} params
 * @param {string} params.to - Recipient WhatsApp ID (e.g., "whatsapp:+91XXXXXXXXXX")
 * @param {string} params.body - Message body (max 1600 chars for WhatsApp)
 * @returns {Promise<Object>} Twilio message response with SID and status
 * @throws {Error} If Twilio rejects the request (auth, rate limit, invalid format, etc.)
 */
export async function sendWhatsAppMessage({ to, body }) {
	const client = getTwilioClient();
	const from = process.env.TWILIO_WHATSAPP_FROM;

	// Validate required fields
	if (!from) {
		throw new Error("Missing TWILIO_WHATSAPP_FROM in environment variables");
	}
	if (!to || typeof to !== "string") {
		throw new Error(`Invalid recipient: ${to}. Expected 'whatsapp:+XXXXXXXXXX' format`);
	}
	if (!body || typeof body !== "string") {
		throw new Error("Message body is empty or not a string");
	}

	try {
		// Send the message via Twilio REST API
		const message = await client.messages.create({
			from,      // Must be a Twilio WhatsApp-enabled number
			to,        // Recipient's WhatsApp ID
			body       // Message content
		});

		// Log successful send with message SID (useful for tracking)
		console.log(`✅ Twilio message sent — SID: ${message.sid}, status: ${message.status}`);
		return message;

	} catch (err) {
		// Intercept and re-throw with more context
		const errorMsg = err.message || String(err);

		// Common error patterns with solutions
		if (errorMsg.includes("Authenticate")) {
			throw new Error(
				"❌ Twilio Authentication Failed. " +
				"Check that TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are correct. " +
				"Get them from: https://console.twilio.com/account " +
				`(Original error: ${errorMsg})`
			);
		}

		if (errorMsg.includes("Invalid phone number")) {
			throw new Error(
				`❌ Invalid phone number format: ${to}. ` +
				`Expected format: whatsapp:+XXXXXXXXXX (Original error: ${errorMsg})`
			);
		}

		if (errorMsg.includes("Not authorized")) {
			throw new Error(
				"❌ Twilio account not authorized for WhatsApp. " +
				"Ensure your Twilio number is WhatsApp-enabled. " +
				`(Original error: ${errorMsg})`
			);
		}

		// Re-throw with original stack trace preserved
		err.message = `Twilio API Error: ${errorMsg}`;
		throw err;
	}
}
