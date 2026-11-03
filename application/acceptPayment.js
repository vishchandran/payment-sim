const { verifyPin } = require("../domain/paymentAuthorization");
const { RiskDecision } = require("../domain/riskAssessment");
const { TransactionStatus } = require("../domain/transactionConstants");

function createAcceptPayment({
  createRequestHash,
  createTransactionId,
  evaluateRisk,
  expectedPin,
  logEvent,
  maskSensitiveData,
  now,
  sanitizeTransactionForPersistence,
  saveTransactionWithOutbox,
  validateTransaction,
}) {
  return async function acceptPayment({ clientId, idempotencyKey, transaction }) {
    if (!idempotencyKey) {
      return {
        statusCode: 400,
        body: {
          status: TransactionStatus.DECLINED,
          reason: "Missing x-idempotency-key header",
        },
      };
    }

    const requestHash = createRequestHash(transaction);

    logEvent(
      "api",
      "RAW_TRANSACTION_RECEIVED",
      "N/A",
      maskSensitiveData(transaction)
    );

    const validation = validateTransaction(transaction);

    if (!validation.valid) {
      return {
        statusCode: 400,
        body: {
          status: TransactionStatus.DECLINED,
          reason: validation.reason,
        },
      };
    }

    const validatedTransaction = validation.transaction;
    const risk = evaluateRisk(validatedTransaction);

    if (risk.decision === RiskDecision.REJECT) {
      return {
        statusCode: 403,
        body: { status: "REJECTED", reason: risk.reason },
      };
    }

    if (risk.decision === RiskDecision.REVIEW) {
      return {
        statusCode: 202,
        body: { status: "MANUAL_REVIEW", reason: risk.reason },
      };
    }

    const transactionId = createTransactionId();
    const timestamp = now();
    const pinVerified = verifyPin(validatedTransaction, expectedPin);

    const acceptedTransaction = sanitizeTransactionForPersistence({
      id: transactionId,
      clientId,
      idempotencyKey,
      requestHash,
      ...validatedTransaction,
      pinVerified,
      status: TransactionStatus.ACCEPTED,
      retryCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      processingTimeline: [
        {
          status: TransactionStatus.ACCEPTED,
          timestamp,
          message: "Transaction accepted by API",
        },
      ],
    });

    logEvent(
      "api",
      "TRANSACTION_RECEIVED",
      acceptedTransaction.id,
      maskSensitiveData(acceptedTransaction)
    );

    const saveResult = await saveTransactionWithOutbox(acceptedTransaction);

    if (!saveResult.inserted) {
      if (saveResult.conflict) {
        return {
          statusCode: 409,
          body: {
            status: "REJECTED",
            reason: "Idempotency key already used with different request payload",
          },
        };
      }

      return {
        statusCode: 200,
        body: {
          status: saveResult.transaction.status,
          transactionId: saveResult.transaction.txn_id,
          message: "Duplicate request detected. Returning original transaction.",
        },
      };
    }

    return {
      statusCode: 202,
      body: {
        status: TransactionStatus.ACCEPTED,
        transactionId,
        message: "Transaction accepted for processing",
      },
    };
  };
}

module.exports = { createAcceptPayment };
