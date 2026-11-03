process.env.API_KEYS = "sensitive-client:sensitive-key";
process.env.ADMIN_API_KEYS = "sensitive-admin-key";
process.env.CARD_FINGERPRINT_SECRET = "sensitive-test-secret";

const crypto = require("crypto");
const { app } = require("../app");
const pool = require("../db/connection");
const {
  saveDeadLetterJob,
  saveTransactionWithOutbox,
} = require("../store/store");

const fullCardNumber = "4111111111111111";
const pin = "1234";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNoSensitiveValue(value, message) {
  const serialized = JSON.stringify(value);

  assert(!serialized.includes(pin), `${message}: found PIN`);
  assert(!serialized.includes(fullCardNumber), `${message}: found full card number`);
  assert(!serialized.includes("cardNumber"), `${message}: found cardNumber key`);
  assert(!serialized.includes("card_number"), `${message}: found card_number key`);
}

async function ensureSchema() {
  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(4),
    ADD COLUMN IF NOT EXISTS card_fingerprint VARCHAR(128),
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(100)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_events_txn_id_unique
    ON outbox_events (txn_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dead_letter_jobs (
      id SERIAL PRIMARY KEY,
      job_id VARCHAR(100) UNIQUE NOT NULL,
      txn_id VARCHAR(50),
      queue_name VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      failed_reason TEXT NOT NULL,
      attempts_made INTEGER NOT NULL,
      failed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function fetchStatus(port, txnId) {
  const response = await fetch(`http://127.0.0.1:${port}/status/${txnId}`, {
    headers: {
      "x-api-key": "sensitive-key",
    },
  });

  return {
    statusCode: response.status,
    body: await response.json(),
  };
}

async function main() {
  await ensureSchema();

  const txnId = `sensitive-${crypto.randomUUID()}`;
  const idempotencyKey = `sensitive-idem-${crypto.randomUUID()}`;
  const jobId = `sensitive-job-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const txn = {
    id: txnId,
    clientId: "sensitive-client",
    idempotencyKey,
    requestHash: crypto.createHash("sha256").update(idempotencyKey).digest("hex"),
    amount: 500,
    fromAccount: "A123",
    toAccount: "B456",
    type: "PURCHASE",
    channel: "DOMESTIC_POS",
    issuerType: "INTERNAL",
    pin,
    pinVerified: true,
    cardNumber: fullCardNumber,
    status: "ACCEPTED",
    retryCount: 0,
    processingTimeline: [
      {
        status: "ACCEPTED",
        timestamp: now,
        message: "Transaction accepted by sensitive data test",
      },
    ],
  };

  await saveTransactionWithOutbox(txn);

  const transactionResult = await pool.query(
    `
    SELECT card_number, card_last4, card_fingerprint
    FROM transactions
    WHERE txn_id = $1
    `,
    [txnId]
  );
  const transaction = transactionResult.rows[0];

  assert(transaction.card_number === null, "expected plaintext card_number not to be stored");
  assert(transaction.card_last4 === "1111", "expected card_last4 to be stored");
  assert(transaction.card_fingerprint, "expected card_fingerprint to be stored");
  assert(transaction.card_fingerprint !== fullCardNumber, "expected fingerprint not to equal full card");

  const outboxResult = await pool.query(
    "SELECT payload FROM outbox_events WHERE txn_id = $1",
    [txnId]
  );
  assertNoSensitiveValue(outboxResult.rows[0].payload, "outbox payload should be sanitized");

  await saveDeadLetterJob(
    {
      id: jobId,
      queueName: "transaction-processing",
      attemptsMade: 3,
      data: txn,
    },
    new Error(`Sensitive data test failure cardNumber=${fullCardNumber} pin=${pin}`)
  );
  const deadLetterResult = await pool.query(
    "SELECT payload, failed_reason FROM dead_letter_jobs WHERE job_id = $1",
    [jobId]
  );
  assertNoSensitiveValue(
    deadLetterResult.rows[0].payload,
    "dead-letter payload should be sanitized"
  );
  assertNoSensitiveValue(
    deadLetterResult.rows[0].failed_reason,
    "dead-letter failed_reason should be sanitized"
  );

  const server = app.listen(0);
  const port = server.address().port;
  const statusResponse = await fetchStatus(port, txnId);
  server.close();

  assert(statusResponse.statusCode === 200, "expected status response to succeed");
  assertNoSensitiveValue(statusResponse.body, "status response should be sanitized");
  assert(
    !JSON.stringify(statusResponse.body).includes("card_fingerprint"),
    "status response should not include card_fingerprint"
  );

  await pool.query("DELETE FROM dead_letter_jobs WHERE job_id = $1", [jobId]);
  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [txnId]);
  await pool.query("DELETE FROM transactions WHERE txn_id = $1", [txnId]);
  await pool.end();

  console.log("PASS sensitive data is not stored in plaintext or returned by status");
}

main().catch(async (error) => {
  console.error("FAIL", error.stack || error.message || error);
  await pool.end();
  process.exit(1);
});
