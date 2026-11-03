const { config } = require("../config/config");
const {
  validateTransaction: validateDomainTransaction,
} = require("../domain/transactionValidation");

function validateTransaction(transaction) {
  return validateDomainTransaction(transaction, {
    transactionLimit: config.transactionLimit,
    supportedTransactionTypes: config.supportedTransactionTypes,
    supportedIssuerTypes: config.supportedIssuerTypes,
    supportedChannels: config.supportedChannels,
    supportedNetworks: config.supportedNetworks,
  });
}

module.exports = { validateTransaction };
