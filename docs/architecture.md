# Architecture Boundaries

Payment-sim separates payment decisions from workflow orchestration and technical
integration. Dependencies point inward:

```text
entrypoints and infrastructure
          |
          v
      application
          |
          v
        domain
```

The domain layer does not import Express, PostgreSQL, Redis, BullMQ, environment
variables, logging, or metrics.

## Domain

`domain/` owns payment vocabulary and deterministic business decisions:

- `transactionConstants.js` defines transaction types, channels, issuers,
  networks, and statuses.
- `paymentPolicy.js` defines default transaction and risk limits.
- `transactionValidation.js` validates and normalizes transaction input.
- `riskAssessment.js` produces approve, review, or reject decisions.
- `transactionRouting.js` selects an internal or external route.
- `paymentAuthorization.js` owns PIN and transaction-access policies.
- `transactionState.js` defines final states and allowed state transitions.
- `issuerLedgerPolicy.js` plans balance inquiries, debits, credits, reversals,
  and declines without executing SQL.

Domain policies accept their variable rules as arguments. This keeps them usable
without a running server, database, or queue and makes policy boundaries directly
testable.

## Application

`application/` coordinates domain decisions and ports supplied by the composition
root:

- `acceptPayment.js` validates, evaluates risk, prepares an accepted transaction,
  and invokes the transaction repository.
- `processTransaction.js` coordinates processor decisions, routing, downstream
  handling, settlement recording, and transaction finalization.

Application modules receive repositories and technical services as constructor
arguments. They do not create PostgreSQL pools, BullMQ workers, or Express
responses.

## Infrastructure

`infrastructure/` is the canonical import boundary for technical adapters:

- `http/` exposes API authentication, CORS, rate limiting, and HTTP authorization.
- `persistence/` exposes transaction and issuer-ledger repositories.
- `queue/` exposes the BullMQ transaction queue.
- `observability/` exposes logging and metrics.

The adapter modules currently delegate to the pre-refactor implementation paths
under `middleware/`, `store/`, `jobs/`, `logger/`, and `observability/`. Those old
paths remain compatibility modules so existing scripts and tests continue to work.
New runtime composition should import through `infrastructure/`; implementation
files can be moved behind those adapters later without changing application code.

## Entrypoints and composition

- `app.js` translates HTTP requests and responses and wires the payment-acceptance
  use case.
- `api.js` starts and stops the HTTP process.
- `jobs/transactionJobHandler.js` owns BullMQ claim and lease handling and wires
  the transaction-processing use case.
- `worker.js` starts and stops the worker process.
- `outbox.js` starts and stops outbox delivery and transaction recovery.

Entrypoints may depend on every layer because they assemble the running system.
Domain and application modules must not import an entrypoint.

## Persistence transaction boundaries

PostgreSQL remains responsible for atomicity and concurrency:

- transaction creation and outbox creation share one database transaction;
- issuer accounts are locked before ledger decisions are executed;
- ledger entries and balance updates remain in one transaction;
- processing claims and finalization remain guarded by status and processor ID.

The domain determines what operation is allowed. The PostgreSQL adapter determines
how that operation is committed safely.

## Testing strategy

- `domainBehaviorTest.js` characterizes validation, risk, routing, authorization,
  and state behavior.
- `issuerLedgerPolicyTest.js` tests ledger decisions without PostgreSQL.
- `acceptPaymentTest.js` tests payment acceptance with injected fakes.
- `processTransactionTest.js` tests processing and finalization with injected
  fakes.
- Existing migration, recovery, sensitive-data, observability, and reliability
  tests verify infrastructure integration.

Refactoring should preserve this direction: first add or update a domain test,
then change the policy, then adapt application and infrastructure code.
