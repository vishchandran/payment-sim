const assert = require("node:assert/strict");
const { createAcceptPayment } = require("../application/acceptPayment");

function createHarness(overrides = {}) {
  const saved = [];
  const dependencies = {
    createRequestHash: () => "request-hash",
    createTransactionId: () => "txn-123",
    evaluateRisk: () => ({ decision: "APPROVE" }),
    expectedPin: "TEST_PIN",
    logEvent: () => {},
    maskSensitiveData: (value) => value,
    now: () => "2026-11-03T12:00:00.000Z",
    sanitizeTransactionForPersistence: (value) => value,
    saveTransactionWithOutbox: async (transaction) => {
      saved.push(transaction);
      return { inserted: true, transaction };
    },
    validateTransaction: (transaction) => ({ valid: true, transaction }),
    ...overrides,
  };

  return {
    acceptPayment: createAcceptPayment(dependencies),
    saved,
  };
}

function payment(overrides = {}) {
  return {
    amount: 500,
    fromAccount: "A123",
    toAccount: "B456",
    type: "PURCHASE",
    channel: "DOMESTIC_POS",
    issuerType: "INTERNAL",
    pin: "TEST_PIN",
    ...overrides,
  };
}

async function testMissingIdempotencyKey() {
  const { acceptPayment, saved } = createHarness();
  const result = await acceptPayment({ clientId: "merchant-a", transaction: payment() });

  assert.deepEqual(result, {
    statusCode: 400,
    body: {
      status: "DECLINED",
      reason: "Missing x-idempotency-key header",
    },
  });
  assert.equal(saved.length, 0);
}

async function testAcceptedPayment() {
  const { acceptPayment, saved } = createHarness();
  const result = await acceptPayment({
    clientId: "merchant-a",
    idempotencyKey: "idem-1",
    transaction: payment(),
  });

  assert.deepEqual(result, {
    statusCode: 202,
    body: {
      status: "ACCEPTED",
      transactionId: "txn-123",
      message: "Transaction accepted for processing",
    },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].clientId, "merchant-a");
  assert.equal(saved[0].pinVerified, true);
  assert.equal(saved[0].status, "ACCEPTED");
}

async function testRiskRejection() {
  const { acceptPayment, saved } = createHarness({
    evaluateRisk: () => ({ decision: "REJECT", reason: "Risk rule" }),
  });
  const result = await acceptPayment({
    clientId: "merchant-a",
    idempotencyKey: "idem-2",
    transaction: payment(),
  });

  assert.deepEqual(result, {
    statusCode: 403,
    body: { status: "REJECTED", reason: "Risk rule" },
  });
  assert.equal(saved.length, 0);
}

async function testIdempotencyConflict() {
  const { acceptPayment } = createHarness({
    saveTransactionWithOutbox: async () => ({ inserted: false, conflict: true }),
  });
  const result = await acceptPayment({
    clientId: "merchant-a",
    idempotencyKey: "idem-3",
    transaction: payment(),
  });

  assert.deepEqual(result, {
    statusCode: 409,
    body: {
      status: "REJECTED",
      reason: "Idempotency key already used with different request payload",
    },
  });
}

async function main() {
  await testMissingIdempotencyKey();
  await testAcceptedPayment();
  await testRiskRejection();
  await testIdempotencyConflict();
  console.log("PASS payment acceptance use case");
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
