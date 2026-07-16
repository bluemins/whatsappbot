# Build a WhatsApp AI Agent with Twilio, Node.js, and OpenAI

A practical example of how to build a WhatsApp AI agent using Twilio’s Messaging API, Node.js, and OpenAI.

This project shows how to:

- Build an AI agent for WhatsApp
- Handle multi-turn conversations with state
- Answer FAQs from structured data
- Create a reservation or booking flow
- Escalate to a human (stubbed)
- Test locally using the Twilio WhatsApp Sandbox

If you're searching for **"how to build a WhatsApp AI agent"**, **"Twilio WhatsApp chatbot with OpenAI"**, or **"Node.js AI agent example"**, this repo provides a working implementation you can run and extend.

---

## What Is This?

This is a developer-focused WhatsApp AI agent built with:

- **Twilio WhatsApp API**
- **Node.js (Express)**
- **OpenAI (structured extraction + intent classification)**

It demonstrates how to design an agent that:

- Understands natural language
- Extracts structured information (party size, date, time)
- Maintains conversation context
- Separates AI interpretation from application logic

The demo uses a restaurant scenario, but the architecture applies to:

- Appointment scheduling
- Lead intake
- Customer support automation
- Service booking systems
- Internal tools

---

## Architecture Overview

High-level request flow:

User (WhatsApp)
↓
Twilio Webhook
↓
server.js
↓
runAgent() (agent.js)
↓
tools.js (FAQ / Reservation / Handoff)
↓
Twilio REST API → Reply to User

Core files:

- `src/server.js` — Twilio webhook handler
- `src/agent.js` — AI agent decision logic
- `src/tools.js` — Integrations + side effects
- `src/store.js` — Session state
- `src/bizHours.js` — Business hour checks
- `data/faq.json` — Editable FAQ knowledge base

---

## How This WhatsApp AI Agent Works

### 1. Message Handling (Twilio → Express)

Incoming WhatsApp messages are delivered via webhook.

```js
runAgent({ from, userText, session });
```

Twilio request signatures are validated before processing.

### 2. Conversation Context (Session State)

Each user gets a lightweight session:

```JSON
{
  history: [],
  flow: null,
  reservationDraft: {}
}
```

This allows:

- Multi-turn reservation flows
- Context-aware follow-ups
- Clean state resets

### 3. FAQ System (Deterministic Answers)

Before generating AI responses, the agent checks `faq.json`.

- Regex pattern matching
- Environment variable templating
- Consistent, controlled answers

Example:

```JSON
"Hours:\nMon–Fri: ${BIZ_HOURS_MON_FRI}"
```

### 4. Reservation Flow (Structured AI Extraction)

When a user says:

> "Can I make a reservation for 2 at 7pm tonight?"

The agent:

1. Extracts party size, date, and time immediately
2. Stores partial data in reservationDraft
3. Asks only for missing fields
4. Confirms the reservation (stubbed)

Phone collection is intentionally stubbed for demo simplicity.

### 5. Human Escalation

If a user asks to speak to a human:

- Business hours are checked
- Response is adjusted accordingly
- Escalation is stubbed for extension

**Requirements**

- Node.js 18+
- npm
- Twilio Account
- OpenAI API Key
- ngrok (or other HTTPS tunnel)

**Quick Start**
Clone the repository:

```bash
git clone https://github.com/YOUR_ORG/whatsapp-ai-agent-demo.git
cd whatsapp-ai-agent-demo
```

Install dependencies:

```bash
npm install
```

Create your environment file:

```bash
cp .env.example .env
```

Add your credentials:

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
OPENAI_API_KEY=sk-xxxxxxxx

PUBLIC_WEBHOOK_URL=https://YOUR_NGROK_URL/twilio/whatsapp
```

Start the server:

```bash
npm run dev
```

Expose it:

```bash
ngrok http 3000
```

## Using the Twilio WhatsApp Sandbox

You do not need a production WhatsApp sender.

1. Go to Twilio Console → Messaging → WhatsApp Sandbox
2. Send the join <code> message from your phone
3. Configure webhook:

```nginx
POST https://YOUR_NGROK_URL/twilio/whatsapp
```

Now message the sandbox number and test the AI agent.

## Customization Guide

### Change Business Details

Edit `.env`:

```env
RESTAURANT_NAME=Your Business
RESTAURANT_ADDRESS=Your Address
BIZ_HOURS_MON_FRI=09:00-17:00
```

### Update FAQ Answers

Modify:

```bash
data/faq.json
```

Add patterns and responses.

### Replace Reservation Stub

Replace `createReservationStub()` in:

```bash
src/tools.js
```

Integrate:

- OpenTable
- Calendly
- Custom booking APIs
- Database storage

### Persist Sessions

Swap in-memory session storage for:

- Redis
- PostgreSQL
- MongoDB

### Security Notes

- `.env` is excluded from Git
- OpenAI keys remain server-side
- Twilio signatures are validated
- AI output is constrained to structured JSON
- Code retains execution control

### Common Questions

**Why use Twilio for WhatsApp AI agents?**
Twilio handles WhatsApp infrastructure, compliance, and delivery while your code focuses on conversation logic.

**Can this be adapted for SMS?**
Yes. Replace the WhatsApp sender with SMS in Twilio and reuse the same agent architecture.

**Is this production-ready?**
It’s production-patterned. This is a demo repo and should not be considered production ready.

**Extend This Project**

- Add vector search for smarter FAQs
- Add Twilio Conversations for live agent handoff
- Add analytics for intent tracking
- Add authentication for user-specific workflows

**License**
MIT License
