const crypto = require("crypto");
const pool = require("../db/connection");
const {
  transactionQueue,
} = require("../infrastructure/queue/transactionQueue");
const { sanitizeText } = require("../utils/sensitiveData");

const DEFAULT_STALE_TIMEOUT_MS = Number(process.env.OUTBOX_STALE_TIMEOUT_MS) || 60000;
const DEFAULT_MAX_RECOVERIES = Number(process.env.OUTBOX_MAX_RECOVERIES) || 3;
const PROCESSOR_INSTANCE_ID =
  process.env.OUTBOX_PROCESSOR_ID || `outbox-${crypto.randomUUID()}`;

async function recoverStaleOutboxEvents(
  staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS,
  maxRecoveries = DEFAULT_MAX_RECOVERIES,
  eligibleTxnIds = null
) {
  const result = await pool.query(
    `
    WITH recovered AS (
      SELECT id, txn_id, locked_by, recovery_count + 1 AS next_recovery_count
      FROM outbox_events
      WHERE status = 'PROCESSING'
        AND claimed_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 millisecond')
        AND ($3::text[] IS NULL OR txn_id = ANY($3))
    )
    UPDATE outbox_events
    SET status = CASE
          WHEN recovered.next_recovery_count >= $2 THEN 'OUTBOX_FAILED'
          ELSE 'PENDING'
        END,
        claimed_at = NULL,
        locked_by = NULL,
        recovery_count = recovered.next_recovery_count,
        last_error = CASE
          WHEN recovered.next_recovery_count >= $2 THEN 'Outbox event exceeded max stale recoveries'
          ELSE last_error
        END,
        updated_at = CURRENT_TIMESTAMP
    FROM recovered
    WHERE outbox_events.id = recovered.id
      AND outbox_events.status = 'PROCESSING'
      AND outbox_events.claimed_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 millisecond')
      AND ($3::text[] IS NULL OR outbox_events.txn_id = ANY($3))
    RETURNING
      outbox_events.id,
      outbox_events.txn_id,
      outbox_events.status,
      outbox_events.recovery_count,
      recovered.locked_by
    `,
    [staleTimeoutMs, maxRecoveries, eligibleTxnIds]
  );

  for (const event of result.rows) {
    if (event.status === "OUTBOX_FAILED") {
      console.error(
        `OUTBOX_EVENT_RECOVERY_LIMIT_EXCEEDED: txn=${event.txn_id} event=${event.id} recoveries=${event.recovery_count} previousLock=${event.locked_by}`
      );
    } else {
      console.log(
        `OUTBOX_STALE_EVENT_RECOVERED: txn=${event.txn_id} event=${event.id} recoveries=${event.recovery_count} previousLock=${event.locked_by}`
      );
    }
  }

  return result.rows;
}

async function claimOutboxEvents(
  limit = 10,
  processorId = PROCESSOR_INSTANCE_ID,
  eligibleTxnIds = null
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT id, txn_id, payload
      FROM outbox_events
      WHERE status = 'PENDING'
        AND ($2::text[] IS NULL OR txn_id = ANY($2))
      ORDER BY id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
      `,
      [limit, eligibleTxnIds]
    );

    const eventIds = result.rows.map((event) => event.id);

    if (eventIds.length > 0) {
      await client.query(
        `
        UPDATE outbox_events
        SET status = 'PROCESSING',
            claimed_at = CURRENT_TIMESTAMP,
            locked_by = $2,
            claim_count = claim_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($1)
        `,
        [eventIds, processorId]
      );
    }

    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function processOutboxEvents() {
  await recoverStaleOutboxEvents();
  const events = await claimOutboxEvents(10);

  for (const event of events) {
    try {
      await transactionQueue.add(
        "process-transaction",
        event.payload,
        {
          jobId: event.txn_id,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        }
      );

      await pool.query(
        `
        UPDATE outbox_events
        SET status = 'SENT',
            attempts = attempts + 1,
            claimed_at = NULL,
            locked_by = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [event.id]
      );

      console.log(`OUTBOX_EVENT_SENT: ${event.txn_id}`);
    } catch (error) {
      const safeError = sanitizeText(error.message);

      await pool.query(
        `
        UPDATE outbox_events
        SET status = 'PENDING',
            attempts = attempts + 1,
            claimed_at = NULL,
            locked_by = NULL,
            last_error = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [safeError, event.id]
      );

      console.error(`OUTBOX_EVENT_FAILED: ${event.txn_id}`, safeError);
    }
  }
}

function startOutboxProcessor() {
  let running = false;

  return setInterval(async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await processOutboxEvents();
    } catch (error) {
      console.error("OUTBOX_PROCESSOR_ERROR:", error.message);
    } finally {
      running = false;
    }
  }, 5000);
}

module.exports = {
  claimOutboxEvents,
  processOutboxEvents,
  recoverStaleOutboxEvents,
  startOutboxProcessor,
};
