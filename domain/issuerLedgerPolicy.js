const { TransactionType } = require("./transactionConstants");

const IssuerAccountStatus = Object.freeze({
  ACTIVE: "ACTIVE",
});

const LedgerOperation = Object.freeze({
  BALANCE_INQUIRY: "BALANCE_INQUIRY",
  DEBIT: "DEBIT",
  REVERSAL_CREDIT: "REVERSAL_CREDIT",
});

const LedgerEntryType = Object.freeze({
  CASH_WITHDRAWAL_DEBIT: "CASH_WITHDRAWAL_DEBIT",
  PURCHASE_CREDIT: "PURCHASE_CREDIT",
  PURCHASE_DEBIT: "PURCHASE_DEBIT",
  REVERSAL_CREDIT: "REVERSAL_CREDIT",
});

function decline(reason) {
  return { approved: false, result: { status: "DECLINED", reason } };
}

function planIssuerLedgerTransaction(transaction, account) {
  if (!account) {
    return decline("Issuer account not found");
  }

  if (account.status !== IssuerAccountStatus.ACTIVE) {
    return decline("Issuer account is not active");
  }

  if (transaction.type === TransactionType.BALANCE_INQUIRY) {
    return { approved: true, operation: LedgerOperation.BALANCE_INQUIRY };
  }

  const amount = Number(transaction.amount);

  if (transaction.type === TransactionType.REVERSAL) {
    return {
      approved: true,
      operation: LedgerOperation.REVERSAL_CREDIT,
      sourceEntry: {
        accountId: transaction.fromAccount,
        amount,
        entryType: LedgerEntryType.REVERSAL_CREDIT,
        description: "Issuer ledger reversal credit",
      },
    };
  }

  if (Number(account.availableBalance) < amount) {
    return decline("Insufficient funds");
  }

  const debitEntryType =
    transaction.type === TransactionType.CASH_WITHDRAWAL
      ? LedgerEntryType.CASH_WITHDRAWAL_DEBIT
      : LedgerEntryType.PURCHASE_DEBIT;
  const destinationEntry =
    transaction.type === TransactionType.PURCHASE && transaction.toAccount
      ? {
          accountId: transaction.toAccount,
          amount,
          entryType: LedgerEntryType.PURCHASE_CREDIT,
          description: "Issuer ledger purchase credit",
        }
      : null;

  return {
    approved: true,
    operation: LedgerOperation.DEBIT,
    sourceEntry: {
      accountId: transaction.fromAccount,
      amount,
      entryType: debitEntryType,
      description: `Issuer ledger ${transaction.type.toLowerCase()} debit`,
    },
    destinationEntry,
  };
}

function createIssuerLedgerResult(transactionType, balance, currency) {
  if (transactionType === TransactionType.BALANCE_INQUIRY) {
    return {
      status: "SUCCESS",
      system: "ISSUER_LEDGER",
      balance: Number(balance),
      currency,
    };
  }

  if (transactionType === TransactionType.REVERSAL) {
    return {
      status: "SUCCESS",
      system: "ISSUER_LEDGER",
      details: "Previous transaction reversed",
      balance: Number(balance),
      currency,
    };
  }

  return {
    status: "APPROVED",
    system: "ISSUER_LEDGER",
    balance: Number(balance),
    currency,
  };
}

module.exports = {
  IssuerAccountStatus,
  LedgerEntryType,
  LedgerOperation,
  createIssuerLedgerResult,
  planIssuerLedgerTransaction,
};
