const pool = require("../db/connection");
const {
  LedgerOperation,
  createIssuerLedgerResult,
  planIssuerLedgerTransaction,
} = require("../domain/issuerLedgerPolicy");

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

    const fromAccountRow = await lockAccount(client, txn.fromAccount);
    const fromAccount = fromAccountRow
      ? {
          availableBalance: Number(fromAccountRow.available_balance),
          currency: fromAccountRow.currency,
          status: fromAccountRow.status,
        }
      : null;
    const plan = planIssuerLedgerTransaction(txn, fromAccount);

    if (!plan.approved) {
      await client.query("ROLLBACK");
      return plan.result;
    }

    if (plan.operation === LedgerOperation.BALANCE_INQUIRY) {
      await client.query("COMMIT");
      return createIssuerLedgerResult(
        txn.type,
        fromAccount.availableBalance,
        fromAccount.currency
      );
    }

    if (plan.operation === LedgerOperation.REVERSAL_CREDIT) {
      const credited = await creditAccount(client, {
        txnId: txn.id,
        ...plan.sourceEntry,
      });

      await client.query("COMMIT");
      return createIssuerLedgerResult(
        txn.type,
        credited.balanceAfter,
        credited.currency
      );
    }

    const debited = await debitAccount(client, {
      txnId: txn.id,
      ...plan.sourceEntry,
    });

    if (plan.destinationEntry) {
      await ensureAccount(client, plan.destinationEntry.accountId);
      await creditAccount(client, {
        txnId: txn.id,
        ...plan.destinationEntry,
      });
    }

    await client.query("COMMIT");
    return createIssuerLedgerResult(
      txn.type,
      debited.balanceAfter,
      debited.currency
    );
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

  return createIssuerLedgerResult(
    txn.type,
    fromEntry.balance_after,
    fromEntry.currency
  );
}

module.exports = {
  applyInternalIssuerLedger,
  getIssuerBalance,
};
