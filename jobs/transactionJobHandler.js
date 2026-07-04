const crypto = require("crypto");
const { logEvent } = require("../logger/logger");
const { routeTransaction } = require("../broker/router");
const { processTransaction } = require("../processor/processor");
const { handleInternal } = require("../systems/internal");
const { handleExternal } = require("../systems/external");
const { sanitizePayload } = require("../utils/sensitiveData");
const {
  finalizeTransactionProcessing,
  getTransaction,
  renewTransactionProcessingLease,
  saveSettlementRecord,
  startTransactionProcessing,
} = require("../store/store");

const FINAL_STATUSES = new Set(["COMPLETED", "DECLINED", "FAILED"]);
const PROCESSING_LEASE_MS =
  Number(process.env.TRANSACTION_PROCESSING_LEASE_MS) || 120000;
const PROCESSING_HEARTBEAT_INTERVAL_MS =
  Number(process.env.TRANSACTION_HEARTBEAT_INTERVAL_MS) || 30000;

function appendTimeline(processingTimeline, status, message) {
  return [
    ...processingTimeline,
    {
      status,
      timestamp: new Date().toISOString(),
      message,
    },
  ];
}

async function handleTransactionJob(job, processorInstanceId) {
  const txn = sanitizePayload(job.data);
  const workerId = processorInstanceId || `worker-${crypto.randomUUID()}`;

  const existingTxn = await getTransaction(txn.id);

  if (!existingTxn) {
    throw new Error(`Transaction not found: ${txn.id}`);
  }

  if (FINAL_STATUSES.has(existingTxn.status)) {
    logEvent("worker", "DUPLICATE_JOB_IGNORED", txn.id, {
      workerId,
      jobId: job.id,
      status: existingTxn.status,
    });
    return { skipped: true, reason: "Transaction already finalized" };
  }

  if (existingTxn.status !== "ACCEPTED") {
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
      status: "PROCESSING",
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
    return await processClaimedTransaction(
      txn,
      workerId,
      processingTimeline
    );
  } finally {
    clearInterval(heartbeat);
  }
}

async function processClaimedTransaction(txn, workerId, processingTimeline) {
  const result = processTransaction(txn);

  if (result.status === "FAILED") {
    throw new Error(result.reason || "Transaction processor failed");
  }

  if (result.status === "DECLINED") {
    const finalizedTxn = await finalizeTransactionProcessing(txn.id, workerId, {
      status: "DECLINED",
      reason: result.reason,
      workerId: 1,
      processingTimeline: appendTimeline(
        processingTimeline,
        "DECLINED",
        `Transaction declined by processor: ${result.reason}`
      ),
    });

    if (!finalizedTxn) {
      return { skipped: true, reason: "Transaction finalization lost" };
    }

    return { skipped: false, status: "DECLINED" };
  }

  const route = routeTransaction(txn);

  let finalResult;

  if (route === "INTERNAL") {
    finalResult = await handleInternal(txn);
  } else if (route === "EXTERNAL_PROCESSOR" || route === "CARD_NETWORK") {
    finalResult = handleExternal(txn);
  } else {
    finalResult = {
      status: "DECLINED",
      reason: "Unsupported route",
    };
  }

  if (finalResult.status === "DECLINED") {
    const finalizedTxn = await finalizeTransactionProcessing(txn.id, workerId, {
      status: "DECLINED",
      route,
      reason: finalResult.reason,
      workerId: 1,
      processingTimeline: appendTimeline(
        processingTimeline,
        "DECLINED",
        `Transaction declined by routed system: ${finalResult.reason}`
      ),
    });

    if (!finalizedTxn) {
      return { skipped: true, reason: "Transaction finalization lost" };
    }

    return { skipped: false, status: "DECLINED" };
  }

  if (route === "EXTERNAL_PROCESSOR" || route === "CARD_NETWORK") {
    await saveSettlementRecord(txn, finalResult.status);
  }

  const finalizedTxn = await finalizeTransactionProcessing(txn.id, workerId, {
    status: "COMPLETED",
    route,
    result: finalResult,
    workerId: 1,
    processingTimeline: appendTimeline(
      appendTimeline(
        processingTimeline,
        "PROCESSING",
        "BullMQ worker processed transaction"
      ),
      "COMPLETED",
      "Transaction processed successfully"
    ),
  });

  if (!finalizedTxn) {
    return { skipped: true, reason: "Transaction finalization lost" };
  }

  return { skipped: false, status: "COMPLETED" };
}

module.exports = {
  FINAL_STATUSES,
  PROCESSING_HEARTBEAT_INTERVAL_MS,
  PROCESSING_LEASE_MS,
  handleTransactionJob,
};
