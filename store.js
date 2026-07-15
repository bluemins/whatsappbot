const processedMessageSids = new Set();
const sessionState = new Map();

/**
 * Session schema per WhatsApp user:
 * {
 *   history: OpenAI chat messages (rolling window),
 *   flow: null | "RESERVATION",
 *   reservationDraft: {
 *     name?: string,
 *     date?: string,  // YYYY-MM-DD
 *     time?: string,  // HH:mm
 *     partySize?: number,
 *     notes?: string
 *     // phone intentionally omitted for demo; see createReservationStub
 *   }
 * }
 */

export function hasProcessed(messageSid) {
	return processedMessageSids.has(messageSid);
}

export function markProcessed(messageSid) {
	processedMessageSids.add(messageSid);
}

export function getSession(userId) {
	return (
		sessionState.get(userId) ?? {
			history: [],
			flow: null,
			reservationDraft: {}
		}
	);
}

export function setSession(userId, session) {
	sessionState.set(userId, session);
}
