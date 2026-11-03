const { config } = require("../config/config");
const {
  evaluateRisk: evaluateDomainRisk,
} = require("../domain/riskAssessment");

function evaluateRisk(transaction) {
  return evaluateDomainRisk(transaction, config.riskRules);
}

module.exports = { evaluateRisk };
