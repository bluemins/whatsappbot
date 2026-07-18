**Bluemins WhatsApp Bot - Repository Overview**

_What this is_
A deterministic WhatsApp order-taking bot for Bluemins (a beverage/product business) built with Node.js and Express. It takes customer orders through WhatsApp via Twilio, collects delivery details through a guided state machine conversation, and writes confirmed orders to Google Sheets. No AI involved — all logic is regex-based intent matching and predefined conversation flows.

_Stack_

Language: JavaScript (Node.js v18+)
Framework / runtime: Express.js (HTTP server) + Twilio SDK (WhatsApp integration)
Notable libraries:
ioredis — session state persistence (30-min TTL)
twilio — WhatsApp messaging & webhook signature validation
dotenv — environment configuration

_How it's organized_

Code
src/
  server.js       Express app, Twilio webhook handler, message deduplication
  router.js       Intent dispatcher (ORDER, PRICE, DELIVERY, HELP, CONTACT, CANCEL)
  orderFlow.js    8-stage state machine (ASK_SIZE → ASK_QTY → ASK_NAME → ... → CONFIRM)
  session.js      Redis session store (get/set/clear per WhatsApp number)
  messages.js     Centralized message templates + product catalog (prices in ₹)
  sheets.js       Google Sheets webhook integration (writes confirmed orders)
  faq.js          FAQ regex loader + pattern matcher (loads from data/faq.json)
  twilio.js       Twilio client init + webhook signature validation
  bizHours.js     Business hours check (timezone-aware, per-day ranges)

data/
  faq.json        17 FAQ entries (products, pricing, delivery, allergens, etc.)

package.json      Dependencies: express, ioredis, twilio, morgan, dotenv, uuid

_How it fits together:_

Request arrival: Twilio POSTs to /twilio/whatsapp with message body, sender ID, and signature.
Validation & dedup: Server validates Twilio signature, checks if this MessageSid was already processed (in-memory Set of 1000 recent), and fetches the user's session from Redis.
Routing: router.js dispatches based on priority:
Active order session (stage ≠ null) → advanceOrder() drives the state machine
Intent match (regex patterns for "order", "price", "delivery", etc.) → handleIntent()
FAQ match (pattern regex from faq.json) → return FAQ answer
Fallback → generic error message
State machine: Each stage (ASK_SIZE, ASK_QTY, etc.) validates input, advances the session, or loops on invalid input.
Order persistence: On confirmation, writeOrder() POSTs the order payload to a Google Apps Script webhook, which appends it to a Google Sheet. Order ID is generated at write time (ORD-<timestamp>-<uuid>).
Session save: Updated session is written back to Redis with a 30-minute TTL, refreshed on every message.
Reply send: Bot sends the reply text back via Twilio REST API.

_How to run it_

bash
# Install dependencies
npm install

# Set environment variables (create a .env file):
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
PUBLIC_WEBHOOK_URL=https://YOUR_NGROK_URL
REDIS_URL=redis://localhost:6379
GOOGLE_SHEETS_WEBHOOK_URL=https://script.google.com/macros/d/.../usercontent

# Optional variables (defaults shown):
PORT=3000
BRAND_TIMEZONE=Asia/Kolkata
BIZ_HOURS_MON_FRI=11:00-21:00
BIZ_HOURS_SAT=12:00-22:00
BIZ_HOURS_SUN=12:00-20:00

# Development (hot reload)
npm run dev

# Production
npm start

# Health check
curl http://localhost:3000/health
Key requirements:

_Redis running (default localhost:6379)_
Twilio account with WhatsApp sandbox or production sender
Google Apps Script webhook URL for order writes
ngrok or similar to expose localhost:3000 to the public internet for Twilio webhooks
What the files and functions do
File	Purpose
server.js	Express server + Twilio webhook handler. Validates signatures, deduplicates messages, fetches/saves Redis sessions, calls route(), sends replies.
router.js	Intent matcher using regex patterns. Priority dispatch: active order → intent match → FAQ → fallback. Returns { reply, newSession }.
orderFlow.js	8-stage state machine. startOrder() begins flow; advanceOrder() dispatches to stage handler (parseSize, parseQty, parsePhone, parseAddress, etc.). Handlers validate input and advance stage.
session.js	Redis wrapper. getSession(from) fetches user session; setSession(from, session) persists with 30-min TTL; clearSession() deletes on completion.
messages.js	Template strings for every bot message + product catalog (1L=₹100, 500ml=₹150, 250ml=₹160). formatMsg() substitutes {{TOKEN}} placeholders.
sheets.js	writeOrder(draft, from) POSTs confirmed order to Google Sheets webhook. Retries once on network failure. Generates order ID as ORD-<timestamp>-<uuid>.
faq.js	loadFaq() reads & caches data/faq.json, compiles regex patterns, interpolates env var templates. matchFaq(faq, query) returns first matching answer.
twilio.js	Twilio client factory. validateTwilioWebhook() checks X-Twilio-Signature header against auth token.
bizHours.js	isWithinBusinessHours() checks current time in BRAND_TIMEZONE against per-day ranges (Mon–Fri, Sat, Sun). Used to block orders outside hours.


## Decision flow

A visual diagram of the bot's decision and message flow (order flow, LLM planning, FAQ/handoff paths).

![Decision flow diagram](assets/decision-flow.svg)
