const { IssuerType, PaymentNetwork } = require("./transactionConstants");

const TransactionRoute = Object.freeze({
  INTERNAL: "INTERNAL",
  EXTERNAL: "EXTERNAL",
  EXTERNAL_PROCESSOR: PaymentNetwork.EXTERNAL_PROCESSOR,
  CARD_NETWORK: PaymentNetwork.CARD_NETWORK,
  UNKNOWN: "UNKNOWN",
});

function routeTransaction(transaction) {
  if (transaction.issuerType === IssuerType.INTERNAL) {
    return TransactionRoute.INTERNAL;
  }

  if (transaction.network === PaymentNetwork.EXTERNAL_PROCESSOR) {
    return TransactionRoute.EXTERNAL_PROCESSOR;
  }

  if (transaction.network === PaymentNetwork.CARD_NETWORK) {
    return TransactionRoute.CARD_NETWORK;
  }

  if (transaction.issuerType === IssuerType.EXTERNAL) {
    return TransactionRoute.EXTERNAL;
  }

  return TransactionRoute.UNKNOWN;
}

module.exports = {
  TransactionRoute,
  routeTransaction,
};
