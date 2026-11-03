const {
  IssuerType,
  TransactionType,
} = require("./transactionConstants");

const AuthorizationResult = Object.freeze({
  APPROVED: "APPROVED",
  DECLINED: "DECLINED",
});

function requiresPin(transaction) {
  return (
    transaction.issuerType === IssuerType.INTERNAL &&
    transaction.type !== TransactionType.BALANCE_INQUIRY
  );
}

function verifyPin(transaction, expectedPin) {
  return !requiresPin(transaction) || transaction.pin === expectedPin;
}

function authorizePin(transaction) {
  if (transaction.pinVerified !== true) {
    return {
      status: AuthorizationResult.DECLINED,
      reason: "Invalid PIN",
    };
  }

  return {
    status: AuthorizationResult.APPROVED,
  };
}

function canAccessTransactionStatus(auth, transaction) {
  if (!auth || !transaction) {
    return false;
  }

  if (auth.type === "admin") {
    return true;
  }

  return auth.type === "client" && transaction.client_id === auth.clientId;
}

module.exports = {
  AuthorizationResult,
  authorizePin,
  canAccessTransactionStatus,
  requiresPin,
  verifyPin,
};
