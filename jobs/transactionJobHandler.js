const crypto = require("crypto");
const { logEvent } = require("../infrastructure/observability/logger");
const { routeTransaction } = require("../broker/router");
const { processTransaction } = require("../processor/processor");
const { handleInternal } = require("../systems/internal");
const { handleExternal } = require("../systems/external");
const { createProcessTransaction } = require("../application/processTransaction");
const { sanitizePayload } = require("../utils/sensitiveData");
const { TransactionStatus } = require("../domain/transactionConstants");
const {
  FINAL_TRANSACTION_STATUSES,
  isFinalTransactionStatus,
} = require("../domain/transactionState");
const {
  finalizeTransactionProcessing,
  getTransaction,
  renewTransactionProcessingLease,
  saveSettlementRecord,
  startTransactionProcessing,
} = require("../infrastructure/persistence/transactionRepository");

const FINAL_STATUSES = new Set(FINAL_TRANSACTION_STATUSES);
const PROCESSING_LEASE_MS =
  Number(process.env.TRANSACTION_PROCESSING_LEASE_MS) || 120000;
const PROCESSING_HEARTBEAT_INTERVAL_MS =
  Number(process.env.TRANSACTION_HEARTBEAT_INTERVAL_MS) || 30000;

const processClaimedTransaction = createProcessTransaction({
  finalizeTransactionProcessing,
  handleExternal,
  handleInternal,
  now: () => new Date().toISOString(),
  processTransaction,
  routeTransaction,
  saveSettlementRecord,
});

async function handleTransactionJob(job, processorInstanceId) {
  const txn = sanitizePayload(job.data);
  const workerId = processorInstanceId || `worker-${crypto.randomUUID()}`;

  const existingTxn = await getTransaction(txn.id);

  if (!existingTxn) {
    throw new Error(`Transaction not found: ${txn.id}`);
  }

  if (isFinalTransactionStatus(existingTxn.status)) {
    logEvent("worker", "DUPLICATE_JOB_IGNORED", txn.id, {
      workerId,
      jobId: job.id,
      status: existingTxn.status,
    });
    return { skipped: true, reason: "Transaction already finalized" };
  }

  if (existingTxn.status !== TransactionStatus.ACCEPTED) {
    logEvent("worker", "DUPLICATE_JOB_IGNORED", txn.id, {
      workerId,
      jobId: job.id,
      status: existingTxn.status,
    });
    return { skipped: true, reason: `Transaction is ${existingTxn.status}` };
  }

  const processingTimeline = [
    ...(existingTxn.processing_timeline || txn.processingTimeline || []),
    {
      status: TransactionStatus.PROCESSING,
      timestamp: new Date().toISOString(),
      message: "BullMQ worker started processing",
    },
  ];

  const processingTxn = await startTransactionProcessing(
    txn.id,
    workerId,
    processingTimeline,
    PROCESSING_LEASE_MS
  );

  if (!processingTxn) {
    const latestTxn = await getTransaction(txn.id);
    logEvent("worker", "DUPLICATE_JOB_IGNORED", txn.id, {
      workerId,
      jobId: job.id,
      status: latestTxn ? latestTxn.status : "UNKNOWN",
    });
    return { skipped: true, reason: "Transaction claim lost" };
  }

  logEvent("worker", "PROCESSING_STARTED", txn.id, {
    workerId,
    jobId: job.id,
  });

  let heartbeatRunning = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning) {
      return;
    }

    heartbeatRunning = true;
    try {
      const renewed = await renewTransactionProcessingLease(
        txn.id,
        workerId,
        PROCESSING_LEASE_MS
      );
      if (!renewed) {
        clearInterval(heartbeat);
        logEvent("worker", "PROCESSING_LEASE_LOST", txn.id, { workerId });
      }
    } catch (error) {
      logEvent("worker", "PROCESSING_HEARTBEAT_FAILED", txn.id, {
        workerId,
        error: error.message,
      });
    } finally {
      heartbeatRunning = false;
    }
  }, PROCESSING_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    return await processClaimedTransaction({
      transaction: txn,
      workerId,
      processingTimeline,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = {
  FINAL_STATUSES,
  PROCESSING_HEARTBEAT_INTERVAL_MS,
  PROCESSING_LEASE_MS,
  handleTransactionJob,
};
