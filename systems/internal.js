const { validatePIN } = require("./systemA");
const { applyInternalIssuerLedger } = require("../store/issuerLedgerStore");

async function handleInternal(txn) {
  console.log("🏦 Internal system processing");

  // Balance inquiry reads directly from the issuer ledger and skips PIN.
  if (txn.type === "BALANCE_INQUIRY") {
    return applyInternalIssuerLedger(txn);
  }

  const pinResult = validatePIN(txn);

  if (pinResult.status === "DECLINED") {
    return pinResult;
  }

  const ledgerResult = await applyInternalIssuerLedger(txn);

  if (ledgerResult.status === "DECLINED") {
    return ledgerResult;
  }

  // Special transaction types
  if (txn.type === "REVERSAL") {
    return ledgerResult;
  }

  if (txn.type === "CASH_WITHDRAWAL") {
    return {
      status: "SUCCESS",
      system: "ATM_CASH_SYSTEM",
      details: "Cash withdrawal approved"
    };
  }

  return {
    status: "SUCCESS",
    system: "PURCHASE_SYSTEM",
    details: "Purchase approved"
  };
}

module.exports = { handleInternal };
