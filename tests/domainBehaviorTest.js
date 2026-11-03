const assert = require("node:assert/strict");

const { config } = require("../config/config");
const {
  IssuerType,
  PaymentNetwork,
  TransactionChannel,
  TransactionStatus,
  TransactionType,
  SUPPORTED_ISSUER_TYPES,
  SUPPORTED_PAYMENT_NETWORKS,
  SUPPORTED_TRANSACTION_CHANNELS,
  SUPPORTED_TRANSACTION_TYPES,
} = require("../domain/transactionConstants");
const {
  validateTransaction: validateDomainTransaction,
} = require("../domain/transactionValidation");
const {
  RiskDecision,
  evaluateRisk: evaluateDomainRisk,
} = require("../domain/riskAssessment");
const { routeTransaction } = require("../broker/router");
const { processTransaction } = require("../processor/processor");
const { evaluateRisk } = require("../risk/riskEngine");
const { handleExternal } = require("../systems/external");
const { validatePIN } = require("../systems/systemA");
const { validateTransaction } = require("../validation/validator");

function payment(overrides = {}) {
  return {
    amount: 500,
    fromAccount: "A123",
    toAccount: "B456",
    type: "PURCHASE",
    channel: "DOMESTIC_POS",
    issuerType: "INTERNAL",
    ...overrides,
  };
}

function testDomainVocabulary() {
  assert.equal(TransactionType.PURCHASE, "PURCHASE");
  assert.equal(TransactionType.BALANCE_INQUIRY, "BALANCE_INQUIRY");
  assert.equal(TransactionChannel.INTERNATIONAL_ATM, "INTERNATIONAL_ATM");
  assert.equal(IssuerType.INTERNAL, "INTERNAL");
  assert.equal(PaymentNetwork.CARD_NETWORK, "CARD_NETWORK");
  assert.equal(TransactionStatus.PROCESSING, "PROCESSING");

  assert.equal(config.supportedTransactionTypes, SUPPORTED_TRANSACTION_TYPES);
  assert.equal(config.supportedChannels, SUPPORTED_TRANSACTION_CHANNELS);
  assert.equal(config.supportedIssuerTypes, SUPPORTED_ISSUER_TYPES);
  assert.equal(config.supportedNetworks, SUPPORTED_PAYMENT_NETWORKS);
}

function testValidationRules() {
  const normalized = validateTransaction(payment({ amount: "500" }));
  assert.equal(normalized.valid, true);
  assert.equal(normalized.transaction.amount, 500);

  assert.deepEqual(validateTransaction(payment({ toAccount: "" })), {
    valid: false,
    reason: "Missing required fields: toAccount",
  });
  assert.deepEqual(validateTransaction(payment({ amount: "not-a-number" })), {
    valid: false,
    reason: "Amount must be a number",
  });
  assert.deepEqual(validateTransaction(payment({ amount: 0 })), {
    valid: false,
    reason: "Amount must be greater than 0",
  });
  assert.equal(
    validateTransaction(payment({ type: "BALANCE_INQUIRY", amount: 0 })).valid,
    true
  );
  assert.deepEqual(
    validateTransaction(payment({ amount: config.transactionLimit + 1 })),
    { valid: false, reason: "Amount exceeds transaction limit" }
  );
  assert.deepEqual(validateTransaction(payment({ type: "TRANSFER" })), {
    valid: false,
    reason: "Invalid transaction type",
  });
  assert.deepEqual(validateTransaction(payment({ issuerType: "PARTNER" })), {
    valid: false,
    reason: "Issuer type must be INTERNAL or EXTERNAL",
  });
  assert.deepEqual(validateTransaction(payment({ channel: "BRANCH" })), {
    valid: false,
    reason: "Invalid channel",
  });
  assert.deepEqual(validateTransaction(payment({ issuerType: "EXTERNAL" })), {
    valid: false,
    reason: "Network is required for external issuer",
  });
  assert.deepEqual(
    validateTransaction(
      payment({ issuerType: "EXTERNAL", network: "UNSUPPORTED_NETWORK" })
    ),
    {
      valid: false,
      reason: "Network must be EXTERNAL_PROCESSOR or CARD_NETWORK",
    }
  );

  assert.deepEqual(
    validateDomainTransaction(payment({ amount: 11 }), { transactionLimit: 10 }),
    { valid: false, reason: "Amount exceeds transaction limit" }
  );
}

function testRiskRulesAndBoundaries() {
  assert.equal(RiskDecision.APPROVE, "APPROVE");

  assert.deepEqual(
    evaluateRisk(
      payment({
        channel: "INTERNATIONAL_ATM",
        amount: config.riskRules.internationalAtmLimit,
      })
    ),
    { decision: "APPROVE" }
  );
  assert.deepEqual(
    evaluateRisk(
      payment({
        channel: "INTERNATIONAL_ATM",
        amount: config.riskRules.internationalAtmLimit + 1,
      })
    ),
    {
      decision: "REJECT",
      reason: "High-risk international ATM withdrawal",
    }
  );
  assert.deepEqual(
    evaluateRisk(
      payment({ channel: "ECOM", amount: config.riskRules.ecommerceReviewLimit + 1 })
    ),
    { decision: "REVIEW", reason: "High-value e-commerce transaction" }
  );
  assert.deepEqual(
    evaluateRisk(
      payment({
        channel: "INTERNATIONAL_POS",
        amount: config.riskRules.internationalPosReviewLimit + 1,
      })
    ),
    {
      decision: "REVIEW",
      reason: "High-value international POS transaction",
    }
  );

  assert.deepEqual(
    evaluateDomainRisk(payment({ channel: "ECOM", amount: 11 }), {
      internationalAtmLimit: 10,
      ecommerceReviewLimit: 10,
      internationalPosReviewLimit: 10,
    }),
    { decision: "REVIEW", reason: "High-value e-commerce transaction" }
  );
}

function testRoutingRules() {
  assert.equal(routeTransaction(payment()), "INTERNAL");
  assert.equal(
    routeTransaction(payment({ issuerType: "EXTERNAL", network: "EXTERNAL_PROCESSOR" })),
    "EXTERNAL_PROCESSOR"
  );
  assert.equal(
    routeTransaction(payment({ issuerType: "EXTERNAL", network: "CARD_NETWORK" })),
    "CARD_NETWORK"
  );
  assert.equal(routeTransaction(payment({ issuerType: "EXTERNAL" })), "EXTERNAL");
  assert.equal(routeTransaction(payment({ issuerType: "UNKNOWN" })), "UNKNOWN");
}

function testAuthorizationAndProcessorRules() {
  assert.deepEqual(validatePIN({ pinVerified: true }), { status: "APPROVED" });
  assert.deepEqual(validatePIN({ pinVerified: false }), {
    status: "DECLINED",
    reason: "Invalid PIN",
  });

  assert.deepEqual(processTransaction(payment({ id: "txn-1", amount: 0 })), {
    status: "DECLINED",
    reason: "Invalid amount",
  });
  assert.deepEqual(
    processTransaction(payment({ id: "txn-2", type: "BALANCE_INQUIRY", amount: 0 })),
    { status: "APPROVED" }
  );
  assert.deepEqual(processTransaction(payment({ id: "txn-3", amount: 999 })), {
    status: "FAILED",
    reason: "Simulated processor failure",
  });

  assert.equal(
    handleExternal({ network: "EXTERNAL_PROCESSOR" }).system,
    "EXTERNAL_PROCESSOR"
  );
  assert.equal(handleExternal({ network: "CARD_NETWORK" }).system, "CARD_NETWORK");
  assert.deepEqual(handleExternal({ network: "UNKNOWN" }), {
    status: "DECLINED",
    reason: "Unsupported external network",
  });
}

function main() {
  testDomainVocabulary();
  testValidationRules();
  testRiskRulesAndBoundaries();
  testRoutingRules();
  testAuthorizationAndProcessorRules();
  console.log("PASS current payment domain behavior characterization");
}

main();
