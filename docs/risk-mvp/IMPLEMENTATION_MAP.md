# Risk MVP implementation map (PR0–PR6)

## Repository discovery

The application is a simulator: Node 24 / Express 5, React 19 / TypeScript / Vite,
`node:sqlite`, and `node:test`. No bank payment provider exists. Existing identity
enrolment is not a verified date-of-birth feed. Do not derive verified age from it.

Reusable paths:

- `server/db.mjs`: SQLite WAL, additive migrations, synchronous `BEGIN IMMEDIATE`,
  accounts/ledger/transactions, redacted audit.
- `server/authorization.mjs`: canonical parameter digests, private execution permits,
  scoped authorizations, unique step execution.
- `server/services.mjs`, `server/direct-verification.mjs`, `server/verify.mjs`:
  proposal, App PIN, transaction-bound SMS/face verification, scheduled execution.
- `server/agent/tools.mjs`, `server/agent/policy.mjs`: allowlisted tools and existing
  daily amount policy. Channels cannot confirm payments.
- `server/app.mjs`: session authentication, origin checks, rate limiting, banking API.
- `src/Approval.tsx`, `src/Verify.tsx`, `src/chat/cards.tsx`: existing trusted controls.
- `tests/helpers.mjs`, `.github/workflows/test.yml`: HTTP fixtures and regression CI.

## Smallest compatible implementation

| Stage | Code | Validation |
| --- | --- | --- |
| PR0 | This map and ADR | Preserve existing simulator and unrelated modules |
| PR1 | `server/risk/features.mjs`, `policy.mjs`, `service.mjs`, `schema.mjs` | Calendar windows, deduplication, independent evidence, immutable evaluations |
| PR2 | `server/risk/age.mjs`, versioned JSON policy | DOB/timezone/leap-day boundaries, fairness and shadow/enforce |
| PR3 | `server/risk/transfers.mjs`, routes, `src/RiskTransfer.tsx` | Owned draft, masked confirmation, optimistic version updates |
| PR4 | Transfer-bound challenges; `server/risk/payment.mjs` | PIN/strong verification reuse, pre-execution check, mock signatures, idempotency |
| PR5 | Risk flags/reviews/appeals in same SQLite database | RBAC, lifecycle, expiry, immutable history |
| PR6 | Agent draft tool; legacy execution risk gate; tests and operations guide | T01–T20 plus existing regression/build/audit |

## Migration and dependencies

Add namespaced `risk_*` tables with foreign keys, uniqueness and status constraints;
record a schema migration. Do not change historical transaction amounts or identities.
Reuse Node built-ins; no new runtime dependencies. Runtime policy uses validated JSON
equivalent to the supplied YAML, avoiding a YAML parser dependency. The supplied YAML
remains unchanged. All new payment results explicitly say `simulation: true`.

Environment: `RISK_AGE_MODE` (default shadow), `RISK_POLICY_FILE` (optional validated
JSON), `LIVE_PAYMENT_ENABLED` (must remain false), `RISK_REVIEWER_IDS` (server-owned
RBAC allowlist). Business timezone defaults to the existing Asia/Shanghai convention.

## External gaps / decisions

Verified DOB, device intelligence and confirmed fraud intelligence require trusted
backend adapters. Missing age is UNKNOWN; missing balances/features are explicit.
No public endpoint may edit DOB or submit risk evidence. Existing PIN authentication
is reused only for sandbox approval; existing SMS/face flow is required on STEP_UP.
No production payment adapter is provided; attempting to enable live payments fails.
Human review uses a protected API and existing support entry, with no invented SLA.
The legacy simulator API remains compatible; new editable drafts use a separate,
strict version-bound protocol. The final common settlement gate also checks risk.

Rollout/rollback are recorded in `OPERATIONS.md`; actual results are in `VALIDATION.md`.
No deployment or production configuration change is part of this PR. The final branch
integrates latest main while preserving its enrollment, onboarding and report-push flows.
