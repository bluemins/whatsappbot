import twilio from "twilio";

export function getTwilioClient() {
	const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
	if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
		throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
	}
	return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Validate Twilio webhook signature to prevent spoofed requests.
 * publicUrl must match EXACTLY what Twilio calls (scheme/host/path).
 */
export function validateTwilioWebhook({ req, publicUrl }) {
	const signature = req.headers["x-twilio-signature"];
	if (!signature) return false;

	const authToken = process.env.TWILIO_AUTH_TOKEN;
	return twilio.validateRequest(authToken, signature, publicUrl, req.body);
}

/**
 * Send a WhatsApp message via Twilio REST API.
 */
export async function sendWhatsAppMessage({ to, body }) {
	const client = getTwilioClient();
	const from = process.env.WHATSAPP_FROM_NUMBER;
	if (!from) throw new Error("Missing TWILIO_WHATSAPP_FROM");

	return client.messages.create({
		from,
		to,
		body
	});
}
