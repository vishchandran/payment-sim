const { TransactionStatus } = require("../domain/transactionConstants");
const { TransactionRoute } = require("../domain/transactionRouting");

function appendTimeline(processingTimeline, status, message, timestamp) {
  return [
    ...processingTimeline,
    {
      status,
      timestamp,
      message,
    },
  ];
}

function createProcessTransaction({
  finalizeTransactionProcessing,
  handleExternal,
  handleInternal,
  now,
  processTransaction,
  routeTransaction,
  saveSettlementRecord,
}) {
  return async function processClaimedTransaction({
    processingTimeline,
    transaction,
    workerId,
  }) {
    const processorResult = processTransaction(transaction);

    if (processorResult.status === TransactionStatus.FAILED) {
      throw new Error(processorResult.reason || "Transaction processor failed");
    }

    if (processorResult.status === TransactionStatus.DECLINED) {
      const finalizedTransaction = await finalizeTransactionProcessing(
        transaction.id,
        workerId,
        {
          status: TransactionStatus.DECLINED,
          reason: processorResult.reason,
          workerId: 1,
          processingTimeline: appendTimeline(
            processingTimeline,
            TransactionStatus.DECLINED,
            `Transaction declined by processor: ${processorResult.reason}`,
            now()
          ),
        }
      );

      if (!finalizedTransaction) {
        return { skipped: true, reason: "Transaction finalization lost" };
      }

      return { skipped: false, status: TransactionStatus.DECLINED };
    }

    const route = routeTransaction(transaction);
    let finalResult;

    if (route === TransactionRoute.INTERNAL) {
      finalResult = await handleInternal(transaction);
    } else if (
      route === TransactionRoute.EXTERNAL_PROCESSOR ||
      route === TransactionRoute.CARD_NETWORK
    ) {
      finalResult = handleExternal(transaction);
    } else {
      finalResult = {
        status: TransactionStatus.DECLINED,
        reason: "Unsupported route",
      };
    }

    if (finalResult.status === TransactionStatus.DECLINED) {
      const finalizedTransaction = await finalizeTransactionProcessing(
        transaction.id,
        workerId,
        {
          status: TransactionStatus.DECLINED,
          route,
          reason: finalResult.reason,
          workerId: 1,
          processingTimeline: appendTimeline(
            processingTimeline,
            TransactionStatus.DECLINED,
            `Transaction declined by routed system: ${finalResult.reason}`,
            now()
          ),
        }
      );

      if (!finalizedTransaction) {
        return { skipped: true, reason: "Transaction finalization lost" };
      }

      return { skipped: false, status: TransactionStatus.DECLINED };
    }

    if (
      route === TransactionRoute.EXTERNAL_PROCESSOR ||
      route === TransactionRoute.CARD_NETWORK
    ) {
      await saveSettlementRecord(transaction, finalResult.status);
    }

    const processedTimeline = appendTimeline(
      processingTimeline,
      TransactionStatus.PROCESSING,
      "BullMQ worker processed transaction",
      now()
    );
    const completedTimeline = appendTimeline(
      processedTimeline,
      TransactionStatus.COMPLETED,
      "Transaction processed successfully",
      now()
    );
    const finalizedTransaction = await finalizeTransactionProcessing(
      transaction.id,
      workerId,
      {
        status: TransactionStatus.COMPLETED,
        route,
        result: finalResult,
        workerId: 1,
        processingTimeline: completedTimeline,
      }
    );

    if (!finalizedTransaction) {
      return { skipped: true, reason: "Transaction finalization lost" };
    }

    return { skipped: false, status: TransactionStatus.COMPLETED };
  };
}

module.exports = {
  appendTimeline,
  createProcessTransaction,
};
