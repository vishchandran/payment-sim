const pool = require("../db/connection");
const {
  sanitizePayload,
  sanitizeText,
  sanitizeTransactionForPersistence,
} = require("../utils/sensitiveData");

async function insertOutboxEvent(client, txn) {
  const safePayload = sanitizePayload(txn);
  const query = `
    INSERT INTO outbox_events
    (
      txn_id,
      event_type,
      payload,
      status
    )
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (txn_id) DO NOTHING
    RETURNING *;
  `;

  const values = [
    txn.id,
    "TRANSACTION_ACCEPTED",
    JSON.stringify(safePayload),
    "PENDING",
  ];

  const result = await client.query(query, values);
  return result.rows[0];
}

async function saveTransactionWithOutbox(txn) {
  const safeTxn = sanitizeTransactionForPersistence(txn);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const transactionQuery = `
      INSERT INTO transactions
      (
        txn_id,
        correlation_id,
        idempotency_key,
        request_hash,
        client_id,
        amount,
        channel,
        card_last4,
        card_fingerprint,
        status,
        from_account,
        to_account,
        type,
        retry_count,
        processing_timeline
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING *;
    `;

    const transactionValues = [
      safeTxn.id,
      safeTxn.correlationId || "N/A",
      safeTxn.idempotencyKey || null,
      safeTxn.requestHash || null,
      safeTxn.clientId || null,
      safeTxn.amount,
      safeTxn.channel,
      safeTxn.cardLast4 || null,
      safeTxn.cardFingerprint || null,
      safeTxn.status || "ACCEPTED",
      safeTxn.fromAccount || null,
      safeTxn.toAccount || null,
      safeTxn.type || null,
      safeTxn.retryCount || 0,
      JSON.stringify(safeTxn.processingTimeline || []),
    ];

    const transactionResult = await client.query(
      transactionQuery,
      transactionValues
    );

    if (transactionResult.rowCount === 0) {
      const existingResult = await client.query(
        `
        SELECT *
        FROM transactions
        WHERE idempotency_key = $1
        `,
        [txn.idempotencyKey]
      );

      await client.query("COMMIT");

      const existingTransaction = existingResult.rows[0];

      return {
        inserted: false,
        conflict:
          !existingTransaction ||
          existingTransaction.request_hash !== txn.requestHash,
        transaction: existingTransaction,
        outboxEvent: null,
      };
    }

    const outboxEvent = await insertOutboxEvent(client, safeTxn);

    await client.query("COMMIT");

    return {
      inserted: true,
      conflict: false,
      transaction: transactionResult.rows[0],
      outboxEvent,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function saveDeadLetterJob(job, error) {
  const txn = sanitizePayload(job.data || {});
  const query = `
    INSERT INTO dead_letter_jobs
    (
      job_id,
      txn_id,
      queue_name,
      payload,
      failed_reason,
      attempts_made
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (job_id) DO UPDATE
    SET
      failed_reason = EXCLUDED.failed_reason,
      attempts_made = EXCLUDED.attempts_made,
      payload = EXCLUDED.payload,
      failed_at = CURRENT_TIMESTAMP
    RETURNING *;
  `;

  const values = [
    job.id,
    txn.id || null,
    job.queueName,
    JSON.stringify(txn),
    sanitizeText(error.message),
    job.attemptsMade,
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

async function getDeadLetterJobs() {
  const query = `
    SELECT *
    FROM dead_letter_jobs
    ORDER BY failed_at DESC
    LIMIT 100;
  `;

  const result = await pool.query(query);
  return result.rows;
}

async function saveSettlementRecord(txn, authorizationStatus) {
  const query = `
    INSERT INTO settlement_records
    (
      txn_id,
      network,
      amount,
      authorization_status,
      settlement_status
    )
    VALUES ($1,$2,$3,$4,'PENDING')
    ON CONFLICT (txn_id) DO UPDATE
    SET
      authorization_status = EXCLUDED.authorization_status,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *;
  `;

  const values = [
    txn.id,
    txn.network,
    txn.amount,
    authorizationStatus,
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

async function updateTransaction(id, updates) {
  const query = `
    UPDATE transactions
    SET
      status = COALESCE($1, status),
      retry_count = COALESCE($2, retry_count),
      worker_id = COALESCE($3, worker_id),
      route = COALESCE($4, route),
      reason = COALESCE($5, reason),
      result = COALESCE($6, result),
      processing_timeline = COALESCE($7, processing_timeline),
      processing_started_at = CASE WHEN $8 THEN NULL ELSE COALESCE($9, processing_started_at) END,
      processor_instance_id = CASE WHEN $8 THEN NULL ELSE COALESCE($10, processor_instance_id) END,
      last_heartbeat_at = CASE WHEN $8 THEN NULL ELSE last_heartbeat_at END,
      lease_expires_at = CASE WHEN $8 THEN NULL ELSE lease_expires_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE txn_id = $11
    RETURNING *;
  `;

  const values = [
    updates.status || null,
    updates.retryCount ?? null,
    updates.workerId ?? null,
    updates.route || null,
    updates.reason || null,
    updates.result ? JSON.stringify(updates.result) : null,
    updates.processingTimeline ? JSON.stringify(updates.processingTimeline) : null,
    Boolean(updates.clearProcessing),
    updates.processingStartedAt ?? null,
    updates.processorInstanceId ?? null,
    id,
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

async function startTransactionProcessing(
  id,
  processorInstanceId,
  processingTimeline,
  leaseDurationMs
) {
  const query = `
    UPDATE transactions
    SET
      status = 'PROCESSING',
      processor_instance_id = $2,
      processing_started_at = CURRENT_TIMESTAMP,
      processing_timeline = COALESCE($3, processing_timeline),
      last_heartbeat_at = CURRENT_TIMESTAMP,
      lease_expires_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
      updated_at = CURRENT_TIMESTAMP
    WHERE txn_id = $1
      AND status = 'ACCEPTED'
    RETURNING *;
  `;

  const result = await pool.query(query, [
    id,
    processorInstanceId,
    processingTimeline ? JSON.stringify(processingTimeline) : null,
    leaseDurationMs,
  ]);

  return result.rows[0];
}

async function renewTransactionProcessingLease(id, processorInstanceId, leaseDurationMs) {
  const result = await pool.query(
    `
    UPDATE transactions
    SET last_heartbeat_at = CURRENT_TIMESTAMP,
        lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
        updated_at = CURRENT_TIMESTAMP
    WHERE txn_id = $1
      AND status = 'PROCESSING'
      AND processor_instance_id = $2
    RETURNING txn_id, lease_expires_at;
    `,
    [id, processorInstanceId, leaseDurationMs]
  );

  return result.rows[0];
}

async function finalizeTransactionProcessing(id, processorInstanceId, updates) {
  const query = `
    UPDATE transactions
    SET
      status = COALESCE($3, status),
      retry_count = COALESCE($4, retry_count),
      worker_id = COALESCE($5, worker_id),
      route = COALESCE($6, route),
      reason = COALESCE($7, reason),
      result = COALESCE($8, result),
      processing_timeline = COALESCE($9, processing_timeline),
      processing_started_at = NULL,
      processor_instance_id = NULL,
      last_heartbeat_at = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE txn_id = $1
      AND status = 'PROCESSING'
      AND processor_instance_id = $2
    RETURNING *;
  `;

  const values = [
    id,
    processorInstanceId,
    updates.status || null,
    updates.retryCount ?? null,
    updates.workerId ?? null,
    updates.route || null,
    updates.reason || null,
    updates.result ? JSON.stringify(updates.result) : null,
    updates.processingTimeline ? JSON.stringify(updates.processingTimeline) : null,
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

async function recoverStaleProcessingTransactions(staleTimeoutMs) {
  const result = await pool.query(
    `
    WITH recovered AS (
      SELECT txn_id, processor_instance_id
      FROM transactions
      WHERE status = 'PROCESSING'
        AND COALESCE(
          lease_expires_at,
          processing_started_at + ($1 * INTERVAL '1 millisecond')
        ) < CURRENT_TIMESTAMP
    )
    UPDATE transactions
    SET status = 'ACCEPTED',
        reason = 'Recovered stale PROCESSING transaction',
        processing_started_at = NULL,
        processor_instance_id = NULL,
        last_heartbeat_at = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    FROM recovered
    WHERE transactions.txn_id = recovered.txn_id
      AND transactions.status = 'PROCESSING'
      AND COALESCE(
        transactions.lease_expires_at,
        transactions.processing_started_at + ($1 * INTERVAL '1 millisecond')
      ) < CURRENT_TIMESTAMP
    RETURNING transactions.txn_id, recovered.processor_instance_id
    `,
    [staleTimeoutMs]
  );

  for (const txn of result.rows) {
    console.log(
      `TRANSACTION_STALE_PROCESSING_RECOVERED: txn=${txn.txn_id} previousProcessor=${txn.processor_instance_id}`
    );
  }

  return result.rows;
}

async function getTransaction(id) {
  const query = `
    SELECT *
    FROM transactions
    WHERE txn_id = $1;
  `;

  const result = await pool.query(query, [id]);
  return result.rows[0];
}

module.exports = {
  saveTransactionWithOutbox,
  updateTransaction,
  startTransactionProcessing,
  renewTransactionProcessingLease,
  finalizeTransactionProcessing,
  recoverStaleProcessingTransactions,
  getTransaction,
  saveDeadLetterJob,
  saveSettlementRecord,
  getDeadLetterJobs,
};
