
const bot = require('../whatsapp-agent-bluemins'); // assumed entry point

// Mock all external services used by the bot
jest.mock('src/orders');
//jest.mock('src/payments');
//jest.mock('src/inventory');
jest.mock('src/sessions');
jest.mock('src/messaging');

const orders = require('src/orders');
//const payments = require('src/payments');
//const inventory = require('src/inventory');
const sessions = require('src/sessions');
const messaging = require('src/messaging');

beforeEach(() => {
  jest.clearAllMocks();
});

// Helper to build a simple message object the bot expects
function msg(text) {
  return { from: 'user123', body: text, id: 'msg-id' };
}

test('1) Creates a new order when user says "I want to order 2 pizzas"', async () => {
  inventory.checkAndReserve.mockResolvedValue({ ok: true, reservationId: 'res-1' });
  orders.createOrder.mockResolvedValue({ id: 'order-1', status: 'pending' });
  sessions.getSession.mockResolvedValue({});
  sessions.saveSession.mockResolvedValue(true);
  messaging.sendMessage.mockResolvedValue({ ok: true });

  const response = await bot.processIncomingMessage('session-1', msg('I want to order 2 pizzas'));

  expect(inventory.checkAndReserve).toHaveBeenCalled();
  expect(orders.createOrder).toHaveBeenCalledWith(expect.objectContaining({
    items: expect.any(Array)
  }));
  expect(response.text).toMatch(/order|confirm/i);
});

test('2) Rejects invalid quantity (zero) with validation message', async () => {
  sessions.getSession.mockResolvedValue({});
  const response = await bot.processIncomingMessage('session-2', msg('Order 0 pizzas'));

  // Should not call order creation or inventory check
  expect(inventory.checkAndReserve).not.toHaveBeenCalled();
  expect(orders.createOrder).not.toHaveBeenCalled();
  expect(response.text).toMatch(/invalid|please specify.*quantity|can't order 0/i);
});

test('3) Handles out-of-stock: suggests alternatives or notifies user', async () => {
  inventory.checkAndReserve.mockResolvedValue({ ok: false, reason: 'out_of_stock', available: ['calzone', 'garlic bread'] });
  sessions.getSession.mockResolvedValue({});
  const response = await bot.processIncomingMessage('session-3', msg('I want 5 sushi rolls'));

  expect(inventory.checkAndReserve).toHaveBeenCalled();
  expect(response.text).toMatch(/out of stock|available alternatives|calzone|garlic bread/i);
});

test('4) Confirms order after successful payment', async () => {
  inventory.checkAndReserve.mockResolvedValue({ ok: true, reservationId: 'res-2' });
  orders.createOrder.mockResolvedValue({ id: 'order-2', status: 'pending' });
  payments.processPayment.mockResolvedValue({ success: true, paymentId: 'pay-1' });
  sessions.getSession.mockResolvedValue({});
  messaging.sendMessage.mockResolvedValue({ ok: true });

  // simulate two-step dialog: user places order then "pay"
  await bot.processIncomingMessage('session-4', msg('Order 1 burger'));
  const paymentResponse = await bot.processIncomingMessage('session-4', msg('pay'));

  expect(payments.processPayment).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-2' }));
  expect(paymentResponse.text).toMatch(/thank you|confirmed|order.*confirmed/i);
});

test('5) Prompts for retry on payment failure', async () => {
  inventory.checkAndReserve.mockResolvedValue({ ok: true, reservationId: 'res-3' });
  orders.createOrder.mockResolvedValue({ id: 'order-3', status: 'pending' });
  payments.processPayment.mockResolvedValue({ success: false, error: 'card_declined' });
  sessions.getSession.mockResolvedValue({});
  messaging.sendMessage.mockResolvedValue({ ok: true });

  await bot.processIncomingMessage('session-5', msg('Order 1 sandwich'));
  const paymentResponse = await bot.processIncomingMessage('session-5', msg('pay'));

  expect(paymentResponse.text).toMatch(/payment failed|card declined|please try again/i);
});

test('6) Maintains session across messages (item selection then address)', async () => {
  sessions.getSession.mockResolvedValueOnce({}); // first message no session
  sessions.saveSession.mockResolvedValue(true);
  inventory.checkAndReserve.mockResolvedValue({ ok: true, reservationId: 'res-4' });
  orders.createOrder.mockResolvedValue({ id: 'order-4', status: 'pending' });

  // User picks item
  await bot.processIncomingMessage('session-6', msg('I want a salad'));
  // User provides address next
  const response2 = await bot.processIncomingMessage('session-6', msg('My address is 123 Main St'));

  // Expect session to have been saved/updated and order creation to proceed or move to next step
  expect(sessions.saveSession).toHaveBeenCalled();
  expect(response2.text).toMatch(/address.*received|thanks.*address|confirm/i);
});

test('7) Cancels order before payment on user cancel command', async () => {
  // Simulate an existing pending order in session
  sessions.getSession.mockResolvedValue({ currentOrderId: 'order-5' });
  orders.cancelOrder.mockResolvedValue({ id: 'order-5', status: 'cancelled' });
  const response = await bot.processIncomingMessage('session-7', msg('cancel my order'));

  expect(orders.cancelOrder).toHaveBeenCalledWith('order-5');
  expect(response.text).toMatch(/cancelled|order has been cancelled/i);
});

test('8) Retries or logs when external messaging API fails', async () => {
  inventory.checkAndReserve.mockResolvedValue({ ok: true, reservationId: 'res-5' });
  orders.createOrder.mockResolvedValue({ id: 'order-6', status: 'pending' });
  sessions.getSession.mockResolvedValue({});
  // Simulate messaging.sendMessage failure
  messaging.sendMessage.mockRejectedValue(new Error('Network error'));

  const response = await bot.processIncomingMessage('session-8', msg('Order 1 fries'));

  // Bot should catch the error and return a fallback response
  expect(messaging.sendMessage).toHaveBeenCalled();
  expect(response.text).toMatch(/could not send message|we encountered an error|try again later/i);
});

test('9) Handles concurrent reservation attempts for low-stock item', async () => {
  // inventory.checkAndReserve will allow first call, reject second
  inventory.checkAndReserve
    .mockResolvedValueOnce({ ok: true, reservationId: 'res-6' })
    .mockResolvedValueOnce({ ok: false, reason: 'out_of_stock' });

  orders.createOrder.mockResolvedValue({ id: 'order-7', status: 'pending' });
  sessions.getSession.mockResolvedValue({});

  // Simulate two parallel calls
  const p1 = bot.processIncomingMessage('session-9a', msg('Order 1 uniqueSpecial'));
  const p2 = bot.processIncomingMessage('session-9b', msg('Order 1 uniqueSpecial'));

  const [r1, r2] = await Promise.all([p1, p2]);

  expect(inventory.checkAndReserve).toHaveBeenCalledTimes(2);
  // One should succeed, the other should indicate out of stock
  const texts = [r1.text, r2.text].join(' ');
  expect(texts).toMatch(/order|confirmed/);
  expect(texts).toMatch(/out of stock|not available/);
});

test('10) Response includes expected formatting (text + quick-reply buttons)', async () => {
  inventory.checkAndReserve.mockResolvedValue({ ok: true, reservationId: 'res-7' });
  orders.createOrder.mockResolvedValue({ id: 'order-8', status: 'pending' });
  sessions.getSession.mockResolvedValue({});
  messaging.sendMessage.mockResolvedValue({ ok: true });

  const response = await bot.processIncomingMessage('session-10', msg('I want a drink'));

  // Expect structured response fields presence
  expect(response).toHaveProperty('text');
  // If bot supports quick replies, they should be an array
  if (response.buttons) {
    expect(Array.isArray(response.buttons)).toBe(true);
    expect(response.buttons.length).toBeGreaterThan(0);
    expect(response.buttons[0]).toEqual(expect.objectContaining({ id: expect.any(String), title: expect.any(String) }));
  }
});
