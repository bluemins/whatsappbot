/**
 * server.js - Express server with WhatsApp (Twilio) integration
 * Run: node server.js
 */

import express from "express";
import twilio from "twilio";
import { runAgent } from "./agent.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

// Simple in-memory session store
// TODO: Replace with Redis or database in production
const sessions = {};

function getOrCreateSession(from) {
	if (!sessions[from]) {
		sessions[from] = {
			flow: null,
			orderDraft: {},
			history: []
		};
	}
	return sessions[from];
}

// Webhook endpoint for WhatsApp messages
app.post("/twilio/whatsapp", async (req, res) => {
	const { Body: userText, From: from } = req.body;

	console.log(`📱 Message from ${from}: ${userText}`);

	// Validate request
	if (!userText || !from) {
		return res.sendStatus(400);
	}

	let session = getOrCreateSession(from);

	try {
		// Run the BlueMins agent
		const { reply, newSession } = await runAgent({ from, userText, session });

		// Update session for next message
		sessions[from] = newSession;

		// Send response back to user
		const client = twilio(
			process.env.WHATSAPP_ACCOUNT_SID,
			process.env.WHATSAPP_AUTH_TOKEN
		);

		await client.messages.create({
			from: process.env.WHATSAPP_FROM_NUMBER,
			to: from,
			body: reply
		});

		console.log(`✅ Reply sent to ${from}`);
		res.sendStatus(200);
	} catch (error) {
		console.error("❌ Error:", error.message);

		// Send fallback message to user
		try {
			const client = twilio(
				process.env.WHATSAPP_ACCOUNT_SID,
				process.env.WHATSAPP_AUTH_TOKEN
			);

			await client.messages.create({
				from: process.env.WHATSAPP_FROM_NUMBER,
				to: from,
				body: 
					"Sorry, something went wrong. Please try again in a moment, " +
					"or a team member will reach out shortly! 🙌"
			});
		} catch (fallbackError) {
			console.error("Failed to send fallback message:", fallbackError);
		}

		res.sendStatus(500);
	}
});

// Health check endpoint
app.get("/health", (req, res) => {
	res.json({
		status: "ok",
		message: "Bluemins WhatsApp bot is running",
		timestamp: new Date().toISOString()
	});
});

// Root endpoint
app.get("/", (req, res) => {
	res.json({
		name: "Bluemins WhatsApp Bot",
		version: "1.0.0",
		status: "running",
		endpoints: {
			health: "GET /health",
			webhook: "POST /whatsapp"
		}
	});
});

// Error handler
app.use((err, req, res, next) => {
	console.error("Server error:", err);
	res.status(500).json({
		error: "Internal server error",
		message: process.env.NODE_ENV === "development" ? err.message : undefined
	});
});

// 404 handler
app.use((req, res) => {
	res.status(404).json({
		error: "Not found",
		path: req.path
	});
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log("╔════════════════════════════════════════╗");
	console.log("║    🤖 Bluemins WhatsApp Bot Started     ║");
	console.log("╚════════════════════════════════════════╝");
	console.log(`\n📡 Listening on port ${PORT}`);
	console.log(`🏥 Health check: http://localhost:${PORT}/health`);
	console.log(`📱 WhatsApp webhook: http://localhost:${PORT}/whatsapp`);
	console.log("\n✨ Configure webhook in Twilio console!");
	console.log("💡 See SETUP_GUIDE.md for full instructions\n");
});

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\n🛑 Shutting down gracefully...");
	process.exit(0);
});
