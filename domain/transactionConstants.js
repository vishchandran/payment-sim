const TransactionType = Object.freeze({
  PURCHASE: "PURCHASE",
  CASH_WITHDRAWAL: "CASH_WITHDRAWAL",
  BALANCE_INQUIRY: "BALANCE_INQUIRY",
  REVERSAL: "REVERSAL",
});

const TransactionChannel = Object.freeze({
  DOMESTIC_ATM: "DOMESTIC_ATM",
  INTERNATIONAL_ATM: "INTERNATIONAL_ATM",
  DOMESTIC_POS: "DOMESTIC_POS",
  INTERNATIONAL_POS: "INTERNATIONAL_POS",
  ECOM: "ECOM",
});

const IssuerType = Object.freeze({
  INTERNAL: "INTERNAL",
  EXTERNAL: "EXTERNAL",
});

const PaymentNetwork = Object.freeze({
  EXTERNAL_PROCESSOR: "EXTERNAL_PROCESSOR",
  CARD_NETWORK: "CARD_NETWORK",
});

const TransactionStatus = Object.freeze({
  ACCEPTED: "ACCEPTED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  DECLINED: "DECLINED",
  FAILED: "FAILED",
});

const SUPPORTED_TRANSACTION_TYPES = Object.freeze(Object.values(TransactionType));
const SUPPORTED_TRANSACTION_CHANNELS = Object.freeze(Object.values(TransactionChannel));
const SUPPORTED_ISSUER_TYPES = Object.freeze(Object.values(IssuerType));
const SUPPORTED_PAYMENT_NETWORKS = Object.freeze(Object.values(PaymentNetwork));

module.exports = {
  IssuerType,
  PaymentNetwork,
  TransactionChannel,
  TransactionStatus,
  TransactionType,
  SUPPORTED_ISSUER_TYPES,
  SUPPORTED_PAYMENT_NETWORKS,
  SUPPORTED_TRANSACTION_CHANNELS,
  SUPPORTED_TRANSACTION_TYPES,
};
