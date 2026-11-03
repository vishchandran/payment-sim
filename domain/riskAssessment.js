const { DEFAULT_RISK_RULES } = require("./paymentPolicy");
const { TransactionChannel } = require("./transactionConstants");

const RiskDecision = Object.freeze({
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  REVIEW: "REVIEW",
});

function evaluateRisk(transaction, riskRules = DEFAULT_RISK_RULES) {
  if (
    transaction.channel === TransactionChannel.INTERNATIONAL_ATM &&
    transaction.amount > riskRules.internationalAtmLimit
  ) {
    return {
      decision: RiskDecision.REJECT,
      reason: "High-risk international ATM withdrawal",
    };
  }

  if (
    transaction.channel === TransactionChannel.ECOM &&
    transaction.amount > riskRules.ecommerceReviewLimit
  ) {
    return {
      decision: RiskDecision.REVIEW,
      reason: "High-value e-commerce transaction",
    };
  }

  if (
    transaction.channel === TransactionChannel.INTERNATIONAL_POS &&
    transaction.amount > riskRules.internationalPosReviewLimit
  ) {
    return {
      decision: RiskDecision.REVIEW,
      reason: "High-value international POS transaction",
    };
  }

  return {
    decision: RiskDecision.APPROVE,
  };
}

module.exports = {
  RiskDecision,
  evaluateRisk,
};
