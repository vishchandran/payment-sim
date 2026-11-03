const { DEFAULT_TRANSACTION_LIMIT } = require("./paymentPolicy");
const {
  IssuerType,
  TransactionType,
  SUPPORTED_ISSUER_TYPES,
  SUPPORTED_PAYMENT_NETWORKS,
  SUPPORTED_TRANSACTION_CHANNELS,
  SUPPORTED_TRANSACTION_TYPES,
} = require("./transactionConstants");

const REQUIRED_TRANSACTION_FIELDS = Object.freeze([
  "amount",
  "fromAccount",
  "toAccount",
  "type",
  "channel",
  "issuerType",
]);

function validateTransaction(
  transaction,
  {
    transactionLimit = DEFAULT_TRANSACTION_LIMIT,
    supportedTransactionTypes = SUPPORTED_TRANSACTION_TYPES,
    supportedIssuerTypes = SUPPORTED_ISSUER_TYPES,
    supportedChannels = SUPPORTED_TRANSACTION_CHANNELS,
    supportedNetworks = SUPPORTED_PAYMENT_NETWORKS,
  } = {}
) {
  const missingFields = REQUIRED_TRANSACTION_FIELDS.filter(
    (field) =>
      transaction[field] === undefined ||
      transaction[field] === null ||
      transaction[field] === ""
  );

  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: `Missing required fields: ${missingFields.join(", ")}`,
    };
  }

  if (!Number.isFinite(Number(transaction.amount))) {
    return { valid: false, reason: "Amount must be a number" };
  }

  const amount = Number(transaction.amount);

  if (transaction.type !== TransactionType.BALANCE_INQUIRY && amount <= 0) {
    return { valid: false, reason: "Amount must be greater than 0" };
  }

  if (amount > transactionLimit) {
    return { valid: false, reason: "Amount exceeds transaction limit" };
  }

  if (!supportedTransactionTypes.includes(transaction.type)) {
    return { valid: false, reason: "Invalid transaction type" };
  }

  if (!supportedIssuerTypes.includes(transaction.issuerType)) {
    return { valid: false, reason: "Issuer type must be INTERNAL or EXTERNAL" };
  }

  if (!supportedChannels.includes(transaction.channel)) {
    return { valid: false, reason: "Invalid channel" };
  }

  if (transaction.issuerType === IssuerType.EXTERNAL && !transaction.network) {
    return { valid: false, reason: "Network is required for external issuer" };
  }

  if (transaction.network && !supportedNetworks.includes(transaction.network)) {
    return {
      valid: false,
      reason: "Network must be EXTERNAL_PROCESSOR or CARD_NETWORK",
    };
  }

  if (transaction.cardNumber && String(transaction.cardNumber).length < 4) {
    return { valid: false, reason: "Card number is too short" };
  }

  return {
    valid: true,
    transaction: {
      ...transaction,
      amount,
      type: transaction.type,
    },
  };
}

module.exports = {
  REQUIRED_TRANSACTION_FIELDS,
  validateTransaction,
};
