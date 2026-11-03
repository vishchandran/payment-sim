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
const { createAcceptPayment } = require("./application/acceptPayment");
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

const acceptPayment = createAcceptPayment({
  createRequestHash,
  createTransactionId: () => crypto.randomUUID(),
  evaluateRisk,
  expectedPin: "TEST_PIN",
  logEvent,
  maskSensitiveData,
  now: () => new Date().toISOString(),
  sanitizeTransactionForPersistence,
  saveTransactionWithOutbox,
  validateTransaction,
});

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
    const result = await acceptPayment({
      clientId: req.auth.clientId,
      idempotencyKey: req.header("x-idempotency-key"),
      transaction: req.body,
    });
    return res.status(result.statusCode).json(result.body);
  } catch (error) {
    console.error("PAYMENT_ACCEPTANCE_ERROR:", error);

    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    });
  }
});

module.exports = { app };
