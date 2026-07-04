CREATE TABLE IF NOT EXISTS issuer_accounts (
  account_id VARCHAR(50) PRIMARY KEY,
  available_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS issuer_ledger_entries (
  id SERIAL PRIMARY KEY,
  txn_id VARCHAR(50) NOT NULL,
  account_id VARCHAR(50) NOT NULL REFERENCES issuer_accounts(account_id),
  entry_type VARCHAR(30) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  balance_after NUMERIC(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (txn_id, account_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_issuer_ledger_entries_txn_id
ON issuer_ledger_entries (txn_id);

INSERT INTO issuer_accounts (account_id, available_balance, currency, status)
VALUES
  ('A123', 5000.00, 'USD', 'ACTIVE'),
  ('B456', 2500.00, 'USD', 'ACTIVE')
ON CONFLICT (account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS settlement_records (
  id SERIAL PRIMARY KEY,
  txn_id VARCHAR(50) UNIQUE NOT NULL,
  network VARCHAR(50) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  authorization_status VARCHAR(30) NOT NULL,
  settlement_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_settlement_records_status
ON settlement_records (settlement_status, created_at);
