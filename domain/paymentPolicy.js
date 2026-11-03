const DEFAULT_TRANSACTION_LIMIT = 10000;

const DEFAULT_RISK_RULES = Object.freeze({
  internationalAtmLimit: 1000,
  ecommerceReviewLimit: 5000,
  internationalPosReviewLimit: 3000,
});

module.exports = {
  DEFAULT_RISK_RULES,
  DEFAULT_TRANSACTION_LIMIT,
};
