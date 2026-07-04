const pool = require("../db/connection");

async function getIssuerAccount(accountId) {
  const result = await pool.query(
    `
    SELECT account_id, available_balance, currency, status
    FROM issuer_accounts
    WHERE account_id = $1
    `,
    [accountId]
  );

  return result.rows[0];
}

async function getIssuerBalance(accountId) {
  const account = await getIssuerAccount(accountId);

  if (!account) {
    return null;
  }

  return {
    accountId: account.account_id,
    balance: Number(account.available_balance),
    currency: account.currency,
    status: account.status,
  };
}

async function applyInternalIssuerLedger(txn) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingLedger = await getExistingLedgerResult(client, txn);
    if (existingLedger) {
      await client.query("COMMIT");
      return existingLedger;
    }

    const fromAccount = await lockAccount(client, txn.fromAccount);

    if (!fromAccount) {
      await client.query("ROLLBACK");
      return { status: "DECLINED", reason: "Issuer account not found" };
    }

    if (fromAccount.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { status: "DECLINED", reason: "Issuer account is not active" };
    }

    if (txn.type === "BALANCE_INQUIRY") {
      await client.query("COMMIT");
      return {
        status: "SUCCESS",
        system: "ISSUER_LEDGER",
        balance: Number(fromAccount.available_balance),
        currency: fromAccount.currency,
      };
    }

    if (txn.type === "REVERSAL") {
      const amount = Number(txn.amount);
      const credited = await creditAccount(client, {
        txnId: txn.id,
        accountId: txn.fromAccount,
        amount,
        entryType: "REVERSAL_CREDIT",
        description: "Issuer ledger reversal credit",
      });

      await client.query("COMMIT");
      return {
        status: "SUCCESS",
        system: "ISSUER_LEDGER",
        details: "Previous transaction reversed",
        balance: credited.balanceAfter,
        currency: credited.currency,
      };
    }

    const amount = Number(txn.amount);

    if (Number(fromAccount.available_balance) < amount) {
      await client.query("ROLLBACK");
      return { status: "DECLINED", reason: "Insufficient funds" };
    }

    const debited = await debitAccount(client, {
      txnId: txn.id,
      accountId: txn.fromAccount,
      amount,
      entryType: ledgerDebitType(txn.type),
      description: `Issuer ledger ${txn.type.toLowerCase()} debit`,
    });

    if (txn.type === "PURCHASE" && txn.toAccount) {
      await ensureAccount(client, txn.toAccount);
      await creditAccount(client, {
        txnId: txn.id,
        accountId: txn.toAccount,
        amount,
        entryType: "PURCHASE_CREDIT",
        description: "Issuer ledger purchase credit",
      });
    }

    await client.query("COMMIT");
    return {
      status: "APPROVED",
      system: "ISSUER_LEDGER",
      balance: debited.balanceAfter,
      currency: debited.currency,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockAccount(client, accountId) {
  const result = await client.query(
    `
    SELECT account_id, available_balance, currency, status
    FROM issuer_accounts
    WHERE account_id = $1
    FOR UPDATE
    `,
    [accountId]
  );

  return result.rows[0];
}

async function ensureAccount(client, accountId) {
  await client.query(
    `
    INSERT INTO issuer_accounts (account_id, available_balance, currency, status)
    VALUES ($1, 0, 'USD', 'ACTIVE')
    ON CONFLICT (account_id) DO NOTHING
    `,
    [accountId]
  );
}

async function debitAccount(client, entry) {
  await client.query(
    `
    UPDATE issuer_accounts
    SET available_balance = available_balance - $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE account_id = $1
    `,
    [entry.accountId, entry.amount]
  );

  return insertLedgerEntry(client, entry);
}

async function creditAccount(client, entry) {
  await client.query(
    `
    UPDATE issuer_accounts
    SET available_balance = available_balance + $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE account_id = $1
    `,
    [entry.accountId, entry.amount]
  );

  return insertLedgerEntry(client, entry);
}

async function insertLedgerEntry(client, entry) {
  const result = await client.query(
    `
    INSERT INTO issuer_ledger_entries
    (
      txn_id,
      account_id,
      entry_type,
      amount,
      balance_after,
      currency,
      description
    )
    SELECT
      $1,
      account_id,
      $3,
      $4,
      available_balance,
      currency,
      $5
    FROM issuer_accounts
    WHERE account_id = $2
    ON CONFLICT (txn_id, account_id, entry_type) DO UPDATE
    SET balance_after = EXCLUDED.balance_after
    RETURNING balance_after, currency
    `,
    [
      entry.txnId,
      entry.accountId,
      entry.entryType,
      entry.amount,
      entry.description,
    ]
  );

  return {
    balanceAfter: Number(result.rows[0].balance_after),
    currency: result.rows[0].currency,
  };
}

function ledgerDebitType(transactionType) {
  if (transactionType === "CASH_WITHDRAWAL") {
    return "CASH_WITHDRAWAL_DEBIT";
  }

  return "PURCHASE_DEBIT";
}

async function getExistingLedgerResult(client, txn) {
  const result = await client.query(
    `
    SELECT account_id, entry_type, balance_after, currency
    FROM issuer_ledger_entries
    WHERE txn_id = $1
    ORDER BY id
    `,
    [txn.id]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const fromEntry =
    result.rows.find((row) => row.account_id === txn.fromAccount) || result.rows[0];

  if (txn.type === "BALANCE_INQUIRY") {
    return {
      status: "SUCCESS",
      system: "ISSUER_LEDGER",
      balance: Number(fromEntry.balance_after),
      currency: fromEntry.currency,
    };
  }

  if (txn.type === "REVERSAL") {
    return {
      status: "SUCCESS",
      system: "ISSUER_LEDGER",
      details: "Previous transaction reversed",
      balance: Number(fromEntry.balance_after),
      currency: fromEntry.currency,
    };
  }

  return {
    status: "APPROVED",
    system: "ISSUER_LEDGER",
    balance: Number(fromEntry.balance_after),
    currency: fromEntry.currency,
  };
}

module.exports = {
  applyInternalIssuerLedger,
  getIssuerBalance,
};
