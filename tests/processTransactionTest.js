const assert = require("node:assert/strict");
const { createProcessTransaction } = require("../application/processTransaction");

function createHarness(overrides = {}) {
  const finalized = [];
  const settlements = [];
  const dependencies = {
    finalizeTransactionProcessing: async (id, workerId, updates) => {
      finalized.push({ id, workerId, updates });
      return { txn_id: id, ...updates };
    },
    handleExternal: () => ({ status: "SUCCESS", system: "CARD_NETWORK" }),
    handleInternal: async () => ({ status: "SUCCESS", system: "ISSUER_LEDGER" }),
    now: () => "2026-11-03T12:00:00.000Z",
    processTransaction: () => ({ status: "APPROVED" }),
    routeTransaction: () => "INTERNAL",
    saveSettlementRecord: async (transaction, status) => {
      settlements.push({ transaction, status });
    },
    ...overrides,
  };

  return {
    finalized,
    processClaimedTransaction: createProcessTransaction(dependencies),
    settlements,
  };
}

function input() {
  return {
    processingTimeline: [],
    transaction: { id: "txn-123", amount: 500 },
    workerId: "worker-1",
  };
}

async function testInternalCompletion() {
  const { finalized, processClaimedTransaction } = createHarness();
  const result = await processClaimedTransaction(input());

  assert.deepEqual(result, { skipped: false, status: "COMPLETED" });
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].updates.route, "INTERNAL");
  assert.equal(finalized[0].updates.status, "COMPLETED");
  assert.equal(finalized[0].updates.processingTimeline.length, 2);
}

async function testProcessorDecline() {
  const { finalized, processClaimedTransaction } = createHarness({
    processTransaction: () => ({ status: "DECLINED", reason: "Invalid amount" }),
  });
  const result = await processClaimedTransaction(input());

  assert.deepEqual(result, { skipped: false, status: "DECLINED" });
  assert.equal(finalized[0].updates.reason, "Invalid amount");
}

async function testProcessorFailureIsRetriedByWorker() {
  const { processClaimedTransaction } = createHarness({
    processTransaction: () => ({ status: "FAILED", reason: "Processor unavailable" }),
  });

  await assert.rejects(
    () => processClaimedTransaction(input()),
    /Processor unavailable/
  );
}

async function testExternalSettlement() {
  const { processClaimedTransaction, settlements } = createHarness({
    routeTransaction: () => "CARD_NETWORK",
  });
  const result = await processClaimedTransaction(input());

  assert.equal(result.status, "COMPLETED");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "SUCCESS");
}

async function main() {
  await testInternalCompletion();
  await testProcessorDecline();
  await testProcessorFailureIsRetriedByWorker();
  await testExternalSettlement();
  console.log("PASS transaction processing use case");
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
