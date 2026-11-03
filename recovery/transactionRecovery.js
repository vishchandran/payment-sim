const {
  recoverStaleProcessingTransactions,
} = require("../infrastructure/persistence/transactionRepository");

const DEFAULT_RECOVERY_INTERVAL_MS =
  Number(process.env.TRANSACTION_RECOVERY_INTERVAL_MS) || 30000;
const DEFAULT_PROCESSING_STALE_TIMEOUT_MS =
  Number(process.env.TRANSACTION_PROCESSING_STALE_TIMEOUT_MS) || 120000;

async function runTransactionRecoveryOnce(
  staleTimeoutMs = DEFAULT_PROCESSING_STALE_TIMEOUT_MS
) {
  return recoverStaleProcessingTransactions(staleTimeoutMs);
}

function startTransactionRecoveryScheduler({
  intervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
  staleTimeoutMs = DEFAULT_PROCESSING_STALE_TIMEOUT_MS,
} = {}) {
  let running = false;

  console.log(
    `Transaction recovery scheduler started intervalMs=${intervalMs} staleTimeoutMs=${staleTimeoutMs}`
  );

  return setInterval(async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await runTransactionRecoveryOnce(staleTimeoutMs);
    } catch (error) {
      console.error("TRANSACTION_RECOVERY_ERROR:", error.message);
    } finally {
      running = false;
    }
  }, intervalMs);
}

module.exports = {
  runTransactionRecoveryOnce,
  startTransactionRecoveryScheduler,
};
