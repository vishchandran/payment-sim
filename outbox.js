const { validateRuntimeConfiguration } = require("./config/config");

validateRuntimeConfiguration();

const pool = require("./db/connection");
const {
  transactionQueue,
} = require("./infrastructure/queue/transactionQueue");
const { startOutboxProcessor } = require("./outbox/outboxProcessor");
const { startTransactionRecoveryScheduler } = require("./recovery/transactionRecovery");

const outboxInterval = startOutboxProcessor();
const recoveryInterval = startTransactionRecoveryScheduler();

console.log("Outbox processor started");

async function shutdown(signal) {
  console.log(`OUTBOX_SHUTDOWN_STARTED: signal=${signal}`);
  clearInterval(outboxInterval);
  clearInterval(recoveryInterval);

  try {
    await transactionQueue.close();
    await pool.end();
    console.log("OUTBOX_SHUTDOWN_COMPLETE");
    process.exit(0);
  } catch (error) {
    console.error("OUTBOX_SHUTDOWN_ERROR:", error.message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
