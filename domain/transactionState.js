const { TransactionStatus } = require("./transactionConstants");

const FINAL_TRANSACTION_STATUSES = Object.freeze([
  TransactionStatus.COMPLETED,
  TransactionStatus.DECLINED,
  TransactionStatus.FAILED,
]);

const ALLOWED_TRANSACTION_TRANSITIONS = Object.freeze({
  [TransactionStatus.ACCEPTED]: Object.freeze([
    TransactionStatus.PROCESSING,
  ]),
  [TransactionStatus.PROCESSING]: Object.freeze([
    TransactionStatus.ACCEPTED,
    TransactionStatus.COMPLETED,
    TransactionStatus.DECLINED,
    TransactionStatus.FAILED,
  ]),
  [TransactionStatus.COMPLETED]: Object.freeze([]),
  [TransactionStatus.DECLINED]: Object.freeze([]),
  [TransactionStatus.FAILED]: Object.freeze([]),
});

function isFinalTransactionStatus(status) {
  return FINAL_TRANSACTION_STATUSES.includes(status);
}

function canTransitionTransaction(fromStatus, toStatus) {
  return (ALLOWED_TRANSACTION_TRANSITIONS[fromStatus] || []).includes(toStatus);
}

module.exports = {
  ALLOWED_TRANSACTION_TRANSITIONS,
  FINAL_TRANSACTION_STATUSES,
  canTransitionTransaction,
  isFinalTransactionStatus,
};
