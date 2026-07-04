const crypto = require("crypto");
const pool = require("../db/connection");
const {
  claimOutboxEvents,
  recoverStaleOutboxEvents,
} = require("../outbox/outboxProcessor");
const { transactionQueue } = require("../jobs/transactionQueue");
const { handleTransactionJob } = require("../jobs/transactionJobHandler");
const {
  getTransaction,
  recoverStaleProcessingTransactions,
  saveTransactionWithOutbox,
} = require("../store/store");

const apiBaseUrl = process.env.API_BASE_URL || "http://localhost:3000";
const apiKey = process.env.API_KEY || "dev-api-key";

function buildPayment(overrides = {}) {
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

async function postPayment(idempotencyKey, payload) {
  const response = await fetch(`${apiBaseUrl}/pay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  return {
    statusCode: response.status,
    body: await response.json(),
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function testDuplicateSamePayload() {
  const idempotencyKey = `reliability-same-${crypto.randomUUID()}`;
  const payload = buildPayment();

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => postPayment(idempotencyKey, payload))
  );

  const accepted = responses.filter((response) => response.statusCode === 202);
  const duplicates = responses.filter((response) => response.statusCode === 200);
  const serverErrors = responses.filter((response) => response.statusCode >= 500);

  assert(accepted.length === 1, `expected one accepted request, got ${accepted.length}`);
  assert(duplicates.length === 4, `expected four duplicate responses, got ${duplicates.length}`);
  assert(serverErrors.length === 0, `expected zero 500 responses, got ${serverErrors.length}`);
  assert(
    responses.every(
      (response) => response.body.transactionId === accepted[0].body.transactionId
    ),
    "all same-payload concurrent requests should return original transaction id"
  );

  const transactionRows = await pool.query(
    "SELECT txn_id FROM transactions WHERE idempotency_key = $1",
    [idempotencyKey]
  );
  assert(
    transactionRows.rowCount === 1,
    `expected one transaction row, got ${transactionRows.rowCount}`
  );

  const outboxRows = await pool.query(
    "SELECT id FROM outbox_events WHERE txn_id = $1",
    [accepted[0].body.transactionId]
  );
  assert(outboxRows.rowCount === 1, `expected one outbox row, got ${outboxRows.rowCount}`);

  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [
    accepted[0].body.transactionId,
  ]);
  await pool.query("DELETE FROM transactions WHERE txn_id = $1", [
    accepted[0].body.transactionId,
  ]);

  console.log("PASS concurrent duplicate idempotency key with same payload");
}

async function testDuplicateDifferentPayload() {
  const idempotencyKey = `reliability-different-${crypto.randomUUID()}`;

  const responses = await Promise.all([
    postPayment(idempotencyKey, buildPayment({ amount: 500 })),
    postPayment(idempotencyKey, buildPayment({ amount: 700 })),
    postPayment(idempotencyKey, buildPayment({ amount: 900 })),
  ]);

  const accepted = responses.filter((response) => response.statusCode === 202);
  const conflicts = responses.filter((response) => response.statusCode === 409);

  assert(accepted.length === 1, `expected one accepted request, got ${accepted.length}`);
  assert(conflicts.length === 2, `expected two conflicts, got ${conflicts.length}`);

  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [
    accepted[0].body.transactionId,
  ]);
  await pool.query("DELETE FROM transactions WHERE txn_id = $1", [
    accepted[0].body.transactionId,
  ]);

  console.log("PASS concurrent duplicate idempotency key with different payloads");
}

async function testStaleOutboxRecovery() {
  const txnId = `rel-stale-${crypto.randomUUID()}`;

  await pool.query(
    `
    INSERT INTO outbox_events
    (
      txn_id,
      event_type,
      payload,
      status,
      claimed_at,
      locked_by,
      claim_count
    )
    VALUES ($1,$2,$3,'PROCESSING',CURRENT_TIMESTAMP - INTERVAL '10 minutes',$4,1)
    `,
    [
      txnId,
      "TRANSACTION_ACCEPTED",
      JSON.stringify({ id: txnId }),
      "test-processor",
    ]
  );

  const recovered = await recoverStaleOutboxEvents(1000, 3, [txnId]);
  const row = await pool.query(
    "SELECT status, claimed_at, locked_by FROM outbox_events WHERE txn_id = $1",
    [txnId]
  );

  assert(
    recovered.some((event) => event.txn_id === txnId),
    "stale event should be returned by recovery"
  );
  assert(row.rows[0].status === "PENDING", "stale event should reset to PENDING");
  assert(row.rows[0].claimed_at === null, "stale event should clear claimed_at");
  assert(row.rows[0].locked_by === null, "stale event should clear locked_by");

  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [txnId]);

  console.log("PASS stale outbox recovery");
}

async function testConcurrentOutboxProcessors() {
  const prefix = `rel-con-${crypto.randomUUID().slice(0, 30)}`;
  const txnIds = Array.from({ length: 6 }, (_, index) => `${prefix}-${index}`);

  for (const txnId of txnIds) {
    await pool.query(
      `
      INSERT INTO outbox_events (txn_id, event_type, payload, status)
      VALUES ($1,$2,$3,'PENDING')
      `,
      [txnId, "TRANSACTION_ACCEPTED", JSON.stringify({ id: txnId })]
    );
  }

  const [firstClaim, secondClaim] = await Promise.all([
    claimOutboxEvents(4, "test-processor-a", txnIds),
    claimOutboxEvents(4, "test-processor-b", txnIds),
  ]);

  const claimedIds = [...firstClaim, ...secondClaim].map((event) => event.txn_id);
  const uniqueClaimedIds = new Set(claimedIds);

  assert(claimedIds.length === uniqueClaimedIds.size, "claims should not overlap");

  const rows = await pool.query(
    `
    SELECT txn_id, status, locked_by
    FROM outbox_events
    WHERE txn_id = ANY($1)
    `,
    [txnIds]
  );

  const processingRows = rows.rows.filter((row) => row.status === "PROCESSING");
  assert(processingRows.length === 6, "all test events should be claimed exactly once");

  await pool.query("DELETE FROM outbox_events WHERE txn_id = ANY($1)", [txnIds]);

  console.log("PASS concurrent outbox processors");
}

async function testDuplicateBullMqJobIgnored() {
  const txnId = `rel-worker-${crypto.randomUUID()}`;
  const fromAccount = `acct-worker-from-${crypto.randomUUID().slice(0, 11)}`;
  const toAccount = `acct-worker-to-${crypto.randomUUID().slice(0, 11)}`;
  const now = new Date().toISOString();
  const fullTxn = {
    id: txnId,
    idempotencyKey: `worker-${txnId}`,
    requestHash: crypto.createHash("sha256").update(txnId).digest("hex"),
    amount: 500,
    fromAccount,
    toAccount,
    type: "PURCHASE",
    channel: "DOMESTIC_POS",
    issuerType: "INTERNAL",
    pinVerified: true,
    status: "ACCEPTED",
    retryCount: 0,
    processingTimeline: [
      {
        status: "ACCEPTED",
        timestamp: now,
        message: "Transaction accepted by reliability test",
      },
    ],
  };

  await pool.query(
    `
    INSERT INTO issuer_accounts (account_id, available_balance, currency, status)
    VALUES ($1, 1000, 'USD', 'ACTIVE'), ($2, 100, 'USD', 'ACTIVE')
    `,
    [fromAccount, toAccount]
  );
  await saveTransactionWithOutbox(fullTxn);

  const first = await handleTransactionJob(
    { id: `job-${txnId}-1`, data: fullTxn },
    "test-worker-a"
  );
  const second = await handleTransactionJob(
    { id: `job-${txnId}-2`, data: fullTxn },
    "test-worker-b"
  );
  const row = await getTransaction(txnId);

  assert(first.status === "COMPLETED", "first job should complete the transaction");
  assert(second.skipped === true, "duplicate job should be skipped");
  assert(row.status === "COMPLETED", "transaction should remain completed");

  await pool.query("DELETE FROM issuer_ledger_entries WHERE txn_id = $1", [txnId]);
  await pool.query("DELETE FROM issuer_accounts WHERE account_id = ANY($1)", [[fromAccount, toAccount]]);
  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [txnId]);
  await pool.query("DELETE FROM transactions WHERE txn_id = $1", [txnId]);

  console.log("PASS duplicate BullMQ job ignored after final status");
}

async function testStaleProcessingTransactionRecovery() {
  const txnId = `rel-proc-${crypto.randomUUID()}`;

  await pool.query(
    `
    INSERT INTO transactions
    (
      txn_id,
      correlation_id,
      idempotency_key,
      request_hash,
      amount,
      channel,
      status,
      from_account,
      to_account,
      type,
      retry_count,
      processing_started_at,
      processor_instance_id,
      processing_timeline
    )
    VALUES ($1,'N/A',$2,$3,500,'DOMESTIC_POS','PROCESSING','A123','B456','PURCHASE',0,CURRENT_TIMESTAMP - INTERVAL '10 minutes',$4,'[]')
    `,
    [
      txnId,
      `processing-${txnId}`,
      crypto.createHash("sha256").update(txnId).digest("hex"),
      "test-worker",
    ]
  );

  const recovered = await recoverStaleProcessingTransactions(1000);
  const row = await getTransaction(txnId);

  assert(
    recovered.some((transaction) => transaction.txn_id === txnId),
    "stale PROCESSING transaction should be returned by recovery"
  );
  assert(row.status === "ACCEPTED", "stale PROCESSING transaction should reset to ACCEPTED");
  assert(row.processing_started_at === null, "transaction recovery should clear processing_started_at");
  assert(row.processor_instance_id === null, "transaction recovery should clear processor_instance_id");

  await pool.query("DELETE FROM transactions WHERE txn_id = $1", [txnId]);

  console.log("PASS stale PROCESSING transaction recovery");
}

async function testOutboxMaxRecoveryFailure() {
  const txnId = `rel-failed-${crypto.randomUUID()}`;

  await pool.query(
    `
    INSERT INTO outbox_events
    (
      txn_id,
      event_type,
      payload,
      status,
      claimed_at,
      locked_by,
      claim_count,
      recovery_count
    )
    VALUES ($1,$2,$3,'PROCESSING',CURRENT_TIMESTAMP - INTERVAL '10 minutes',$4,1,2)
    `,
    [
      txnId,
      "TRANSACTION_ACCEPTED",
      JSON.stringify({ id: txnId }),
      "test-processor",
    ]
  );

  const recovered = await recoverStaleOutboxEvents(1000, 3, [txnId]);
  const row = await pool.query(
    "SELECT status, recovery_count, claimed_at, locked_by FROM outbox_events WHERE txn_id = $1",
    [txnId]
  );

  assert(
    recovered.some((event) => event.txn_id === txnId && event.status === "OUTBOX_FAILED"),
    "outbox event should be returned as OUTBOX_FAILED"
  );
  assert(row.rows[0].status === "OUTBOX_FAILED", "outbox event should move to OUTBOX_FAILED");
  assert(Number(row.rows[0].recovery_count) === 3, "outbox recovery count should reach max");
  assert(row.rows[0].claimed_at === null, "failed outbox event should clear claimed_at");
  assert(row.rows[0].locked_by === null, "failed outbox event should clear locked_by");

  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [txnId]);

  console.log("PASS outbox max recovery moves event to OUTBOX_FAILED");
}

async function testInternalIssuerLedgerDebitCredit() {
  const txnId = `rel-ledger-${crypto.randomUUID()}`;
  const fromAccount = `acct-from-${crypto.randomUUID().slice(0, 18)}`;
  const toAccount = `acct-to-${crypto.randomUUID().slice(0, 18)}`;
  const now = new Date().toISOString();
  const fullTxn = {
    id: txnId,
    idempotencyKey: `ledger-${txnId}`,
    requestHash: crypto.createHash("sha256").update(txnId).digest("hex"),
    amount: 125,
    fromAccount,
    toAccount,
    type: "PURCHASE",
    channel: "DOMESTIC_POS",
    issuerType: "INTERNAL",
    pinVerified: true,
    status: "ACCEPTED",
    retryCount: 0,
    processingTimeline: [
      {
        status: "ACCEPTED",
        timestamp: now,
        message: "Transaction accepted by issuer ledger test",
      },
    ],
  };

  await pool.query(
    `
    INSERT INTO issuer_accounts (account_id, available_balance, currency, status)
    VALUES ($1, 500, 'USD', 'ACTIVE'), ($2, 50, 'USD', 'ACTIVE')
    `,
    [fromAccount, toAccount]
  );
  await saveTransactionWithOutbox(fullTxn);

  const result = await handleTransactionJob(
    { id: `job-${txnId}`, data: fullTxn },
    "test-ledger-worker"
  );

  const balances = await pool.query(
    `
    SELECT account_id, available_balance
    FROM issuer_accounts
    WHERE account_id = ANY($1)
    ORDER BY account_id
    `,
    [[fromAccount, toAccount]]
  );
  const entries = await pool.query(
    "SELECT entry_type FROM issuer_ledger_entries WHERE txn_id = $1 ORDER BY entry_type",
    [txnId]
  );

  const fromBalance = balances.rows.find((row) => row.account_id === fromAccount);
  const toBalance = balances.rows.find((row) => row.account_id === toAccount);

  assert(result.status === "COMPLETED", "issuer ledger transaction should complete");
  assert(Number(fromBalance.available_balance) === 375, "from account should be debited");
  assert(Number(toBalance.available_balance) === 175, "to account should be credited");
  assert(entries.rowCount === 2, "purchase should create debit and credit ledger entries");

  await pool.query("DELETE FROM issuer_ledger_entries WHERE txn_id = $1", [txnId]);
  await pool.query("DELETE FROM issuer_accounts WHERE account_id = ANY($1)", [[fromAccount, toAccount]]);
  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [txnId]);
  await pool.query("DELETE FROM transactions WHERE txn_id = $1", [txnId]);

  console.log("PASS internal issuer ledger debit and credit");
}

async function testExternalSettlementRecordCreated() {
  const txnId = `rel-settle-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const fullTxn = {
    id: txnId,
    idempotencyKey: `settlement-${txnId}`,
    requestHash: crypto.createHash("sha256").update(txnId).digest("hex"),
    amount: 225,
    fromAccount: "A123",
    toAccount: "B456",
    type: "PURCHASE",
    channel: "DOMESTIC_POS",
    issuerType: "EXTERNAL",
    network: "EXTERNAL_PROCESSOR",
    status: "ACCEPTED",
    retryCount: 0,
    processingTimeline: [
      {
        status: "ACCEPTED",
        timestamp: now,
        message: "Transaction accepted by settlement test",
      },
    ],
  };

  await saveTransactionWithOutbox(fullTxn);

  const result = await handleTransactionJob(
    { id: `job-${txnId}`, data: fullTxn },
    "test-settlement-worker"
  );
  const settlement = await pool.query(
    `
    SELECT network, authorization_status, settlement_status
    FROM settlement_records
    WHERE txn_id = $1
    `,
    [txnId]
  );

  assert(result.status === "COMPLETED", "external transaction should complete");
  assert(settlement.rowCount === 1, "external transaction should create settlement record");
  assert(
    settlement.rows[0].network === "EXTERNAL_PROCESSOR",
    "settlement record should retain external network"
  );
  assert(
    settlement.rows[0].authorization_status === "SUCCESS",
    "settlement record should store authorization outcome"
  );
  assert(
    settlement.rows[0].settlement_status === "PENDING",
    "settlement should start pending"
  );

  await pool.query("DELETE FROM settlement_records WHERE txn_id = $1", [txnId]);
  await pool.query("DELETE FROM outbox_events WHERE txn_id = $1", [txnId]);
  await pool.query("DELETE FROM transactions WHERE txn_id = $1", [txnId]);

  console.log("PASS external settlement record created");
}

async function main() {
  const testName = process.argv[2] || "all";

  const tests = {
    "idempotency-same": testDuplicateSamePayload,
    "idempotency-different": testDuplicateDifferentPayload,
    "stale-outbox-recovery": testStaleOutboxRecovery,
    "concurrent-outbox-processors": testConcurrentOutboxProcessors,
    "duplicate-worker-job": testDuplicateBullMqJobIgnored,
    "stale-processing-transaction": testStaleProcessingTransactionRecovery,
    "outbox-max-recovery": testOutboxMaxRecoveryFailure,
    "internal-issuer-ledger": testInternalIssuerLedgerDebitCredit,
    "external-settlement-record": testExternalSettlementRecordCreated,
  };

  if (testName === "all") {
    for (const test of Object.values(tests)) {
      await test();
    }
  } else if (tests[testName]) {
    await tests[testName]();
  } else {
    throw new Error(`Unknown reliability test: ${testName}`);
  }

  await transactionQueue.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error("FAIL", error.message);
  await transactionQueue.close();
  await pool.end();
  process.exit(1);
});
