const assert = require("node:assert/strict");
const {
  LedgerEntryType,
  LedgerOperation,
  createIssuerLedgerResult,
  planIssuerLedgerTransaction,
} = require("../domain/issuerLedgerPolicy");

function transaction(overrides = {}) {
  return {
    id: "txn-123",
    amount: 125,
    fromAccount: "A123",
    toAccount: "B456",
    type: "PURCHASE",
    ...overrides,
  };
}

function account(overrides = {}) {
  return {
    availableBalance: 500,
    currency: "USD",
    status: "ACTIVE",
    ...overrides,
  };
}

function testAccountEligibility() {
  assert.deepEqual(planIssuerLedgerTransaction(transaction(), null), {
    approved: false,
    result: { status: "DECLINED", reason: "Issuer account not found" },
  });
  assert.deepEqual(
    planIssuerLedgerTransaction(transaction(), account({ status: "BLOCKED" })),
    {
      approved: false,
      result: { status: "DECLINED", reason: "Issuer account is not active" },
    }
  );
}

function testPurchasePlan() {
  const plan = planIssuerLedgerTransaction(transaction(), account());

  assert.equal(plan.approved, true);
  assert.equal(plan.operation, LedgerOperation.DEBIT);
  assert.equal(plan.sourceEntry.entryType, LedgerEntryType.PURCHASE_DEBIT);
  assert.equal(plan.destinationEntry.entryType, LedgerEntryType.PURCHASE_CREDIT);
  assert.equal(plan.sourceEntry.amount, 125);
}

function testInsufficientFunds() {
  assert.deepEqual(
    planIssuerLedgerTransaction(transaction(), account({ availableBalance: 100 })),
    {
      approved: false,
      result: { status: "DECLINED", reason: "Insufficient funds" },
    }
  );
}

function testSpecialTransactionPlans() {
  const balancePlan = planIssuerLedgerTransaction(
    transaction({ type: "BALANCE_INQUIRY", amount: 0 }),
    account()
  );
  assert.equal(balancePlan.operation, LedgerOperation.BALANCE_INQUIRY);

  const reversalPlan = planIssuerLedgerTransaction(
    transaction({ type: "REVERSAL" }),
    account({ availableBalance: 0 })
  );
  assert.equal(reversalPlan.operation, LedgerOperation.REVERSAL_CREDIT);
  assert.equal(reversalPlan.sourceEntry.entryType, LedgerEntryType.REVERSAL_CREDIT);

  const withdrawalPlan = planIssuerLedgerTransaction(
    transaction({ type: "CASH_WITHDRAWAL", toAccount: null }),
    account()
  );
  assert.equal(
    withdrawalPlan.sourceEntry.entryType,
    LedgerEntryType.CASH_WITHDRAWAL_DEBIT
  );
  assert.equal(withdrawalPlan.destinationEntry, null);
}

function testLedgerResults() {
  assert.deepEqual(createIssuerLedgerResult("PURCHASE", 375, "USD"), {
    status: "APPROVED",
    system: "ISSUER_LEDGER",
    balance: 375,
    currency: "USD",
  });
  assert.deepEqual(createIssuerLedgerResult("REVERSAL", 500, "USD"), {
    status: "SUCCESS",
    system: "ISSUER_LEDGER",
    details: "Previous transaction reversed",
    balance: 500,
    currency: "USD",
  });
}

function main() {
  testAccountEligibility();
  testPurchasePlan();
  testInsufficientFunds();
  testSpecialTransactionPlans();
  testLedgerResults();
  console.log("PASS issuer ledger domain policy");
}

main();
