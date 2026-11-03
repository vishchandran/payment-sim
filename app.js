const express = require("express");
const crypto = require("crypto");
const helmet = require("helmet");
const cors = require("cors");
const {
  adminApiKeyAuth,
  apiKeyAuth,
  apiKeyOrAdminAuth,
} = require("./middleware/apiKeyAuth");
const { buildCorsOptions } = require("./middleware/corsConfig");
const { canAccessTransactionStatus } = require("./middleware/statusAuthorization");
const { apiRateLimiter, pingRateLimiter } = require("./middleware/rateLimiter");
const { recordHttpMetrics, renderMetrics } = require("./observability/metrics");
const pool = require("./db/connection");

const app = express();

const { evaluateRisk } = require("./risk/riskEngine");
const { verifyPin } = require("./domain/paymentAuthorization");
const { maskSensitiveData } = require("./utils/mask");
const {
  sanitizeTransactionForPersistence,
  serializeTransactionResponse,
} = require("./utils/sensitiveData");
const { logEvent } = require("./logger/logger");
const { createRequestHash } = require("./utils/requestHash");
const { validateTransaction } = require("./validation/validator");

const {
  saveTransactionWithOutbox,
  getTransaction,
  getDeadLetterJobs,
} = require("./store/store");

console.log("APP STARTING...");

app.use(helmet());
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: "10kb" }));
app.use(recordHttpMetrics);
app.use(apiRateLimiter);

/* ROUTES */

app.get("/", (req, res) => {
  res.json({
    status: "UP",
    service: "payment-sim",
    message: "Payment simulator is running",
  });
});

app.get("/health/live", (req, res) => {
  res.json({ status: "UP" });
});

app.get("/health/ready", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await pingRateLimiter();
    return res.json({ status: "READY" });
  } catch (error) {
    console.error("READINESS_CHECK_FAILED:", error.message);
    return res.status(503).json({ status: "NOT_READY" });
  }
});

app.get("/metrics", adminApiKeyAuth, async (req, res) => {
  res.type("text/plain; version=0.0.4").send(await renderMetrics(pool));
});

app.get("/info", adminApiKeyAuth, (req, res) => {
  res.json({
    service: "payment-sim",
    architecture: "BullMQ-backed async payment processing simulator",
    features: [
      "validation",
      "risk engine",
      "BullMQ queue",
      "Redis-backed worker processing",
      "PostgreSQL transaction lifecycle persistence",
      "retry logic",
      "dead letter queue",
      "structured logging",
      "internal systems",
      "external network routing",
    ],
  });
});

app.get("/status/:id", apiKeyOrAdminAuth, async (req, res) => {
  const txnId = req.params.id;

  const txn = await getTransaction(txnId);

  if (!txn) {
    return res.status(404).json({
      error: "Transaction not found",
    });
  }

  if (!canAccessTransactionStatus(req.auth, txn)) {
    return res.status(403).json({
      status: "REJECTED",
      reason: "Forbidden transaction access",
    });
  }

  return res.json(serializeTransactionResponse(txn));
});

app.get("/dead-letter", adminApiKeyAuth, (req, res) => {
  getDeadLetterJobs()
    .then((jobs) => {
      res.json({
        count: jobs.length,
        jobs,
      });
    })
    .catch((error) => {
      console.error("DEAD_LETTER_FETCH_ERROR:", error);
      res.status(500).json({
        status: "ERROR",
        reason: "Unable to fetch dead-letter jobs",
      });
    });
});

app.post("/pay", apiKeyAuth, async (req, res) => {
  try {
    const txn = req.body;
    const idempotencyKey = req.header("x-idempotency-key");

    if (!idempotencyKey) {
      return res.status(400).json({
        status: "DECLINED",
        reason: "Missing x-idempotency-key header",
      });
    }

    const requestHash = createRequestHash(txn);

    logEvent("api", "RAW_TRANSACTION_RECEIVED", "N/A", maskSensitiveData(txn));

    const validation = validateTransaction(txn);

    if (!validation.valid) {
      return res.status(400).json({
        status: "DECLINED",
        reason: validation.reason,
      });
    }

    const validatedTxn = validation.transaction;
    const risk = evaluateRisk(validatedTxn);

    if (risk.decision === "REJECT") {
      return res.status(403).json({
        status: "REJECTED",
        reason: risk.reason,
      });
    }

    if (risk.decision === "REVIEW") {
      return res.status(202).json({
        status: "MANUAL_REVIEW",
        reason: risk.reason,
      });
    }

    const txnId = crypto.randomUUID();
    const now = new Date().toISOString();
    const pinVerified = verifyPin(validatedTxn, "TEST_PIN");

    const fullTxn = sanitizeTransactionForPersistence({
      id: txnId,
      clientId: req.auth.clientId,
      idempotencyKey,
      requestHash,
      ...validatedTxn,
      pinVerified,
      status: "ACCEPTED",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      processingTimeline: [
        {
          status: "ACCEPTED",
          timestamp: now,
          message: "Transaction accepted by API",
        },
      ],
    });

    logEvent(
      "api",
      "TRANSACTION_RECEIVED",
      fullTxn.id,
      maskSensitiveData(fullTxn)
    );

    const saveResult = await saveTransactionWithOutbox(fullTxn);

    if (!saveResult.inserted) {
      if (saveResult.conflict) {
        return res.status(409).json({
          status: "REJECTED",
          reason: "Idempotency key already used with different request payload",
        });
      }

      return res.status(200).json({
        status: saveResult.transaction.status,
        transactionId: saveResult.transaction.txn_id,
        message: "Duplicate request detected. Returning original transaction.",
      });
    }

    return res.status(202).json({
      status: "ACCEPTED",
      transactionId: txnId,
      message: "Transaction accepted for processing",
    });
  } catch (error) {
    console.error("PAYMENT_ACCEPTANCE_ERROR:", error);

    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    });
  }
});

module.exports = { app };
