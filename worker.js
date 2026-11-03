const { validateRuntimeConfiguration } = require("./config/config");

validateRuntimeConfiguration();

const pool = require("./db/connection");
const worker = require("./jobs/transactionWorker");
const {
  transactionQueue,
} = require("./infrastructure/queue/transactionQueue");

console.log("Transaction worker started");

async function shutdown(signal) {
  console.log(`WORKER_SHUTDOWN_STARTED: signal=${signal}`);

  try {
    await worker.close();
    await transactionQueue.close();
    await pool.end();
    console.log("WORKER_SHUTDOWN_COMPLETE");
    process.exit(0);
  } catch (error) {
    console.error("WORKER_SHUTDOWN_ERROR:", error.message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
