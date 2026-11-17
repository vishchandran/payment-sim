# Software supply-chain security baseline

## Required controls

- Commit `package-lock.json` and use `npm ci` for reproducible installation.
- Resolve packages from the configured npm registry.
- Disable dependency lifecycle scripts unless a reviewed exception is required.
- Pin GitHub Actions to reviewed commit SHAs.
- Grant the workflow token read-only access and prevent checkout credentials from persisting.
- Audit production and complete dependency trees on dependency pull requests and weekly.
- Review Dependabot pull requests; major upgrades require compatibility testing.
- Keep secrets and environment files out of source, Docker build context, and workflow logs.
- Run the application container as a non-root user.

## Audit findings — 2026-11-17

| Finding | Severity | Evidence | Risk | Status |
| --- | --- | --- | --- | --- |
| Mutable GitHub Action tags | High | CI used `actions/checkout@v4` and `actions/setup-node@v4`. | A moved or compromised tag could execute unreviewed CI code. | Remediated with reviewed v5 commit SHAs. |
| Implicit workflow permissions and persisted credentials | High | CI had no explicit `permissions`; checkout used its default credential persistence. | Untrusted code or a compromised step could misuse the workflow token. | Remediated with `contents: read` and `persist-credentials: false`. |
| No automated audit or Dependabot configuration | Medium | No dependency-security workflow or Dependabot file existed. | Vulnerabilities and risky updates could remain unnoticed. | Remediated with PR/weekly scans and non-major update PRs. |
| Lifecycle scripts were unrestricted | High | Standard `npm ci` permitted package install scripts. | A compromised package could execute code during installation. | Remediated with `ignore-scripts=true`; no current dependency requires an exception. |
| Reproducible container install and non-root runtime | Low | Docker already used `npm ci --omit=dev` and `USER node`. | Existing controls reduce dependency drift and runtime impact. | Preserved; lifecycle scripts are now explicitly disabled. |

## Validation and residual risk

The application manifest, lockfile, CI workflow, Dockerfile, ignore files, and service dependencies were inspected. Existing PostgreSQL, Redis, BullMQ, migration, core, reliability, retry, outbox, reconciliation, and DLQ behavior is unchanged.

The first audit found four production transitive vulnerabilities: one critical, two high, and one moderate. A restricted one-time workflow ran `npm audit fix --package-lock-only --ignore-scripts`; review confirmed that only the lockfile changed and that Express and BullMQ direct versions were preserved. The patched transitive versions are `body-parser` 2.4.0, `ip-address` 10.7.6, `proxy-addr` 2.0.8, and `qs` 6.17.1. The temporary write-enabled workflow was removed before final validation.

GitHub Actions provide executed installation, audit, migration, integration, and reliability-test evidence. Audit findings must be reviewed for production reachability; a scanner result alone does not prove exploitability. Lockfiles, disabled lifecycle scripts, pinned Actions, audits, and Dependabot reduce risk but cannot guarantee that every dependency is benign. Branch protection, required reviews, secret scanning, and Dependabot alerts should be enabled in repository settings where available.
