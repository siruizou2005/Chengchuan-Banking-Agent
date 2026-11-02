# Risk MVP: local operation and API

This PR is a simulator implementation. All payment responses include `simulation:true`.
It implements the five MVP modules without changing the existing technology stack.

## Run and verify

```powershell
npm ci
npm run test:risk
npm run build
npm run demo:risk
node --test --test-concurrency=2 tests/*.test.mjs
npm audit --json
```

The demo uses an in-memory database and no real payment/identity provider. It prints
`RISK_CHECKED → USER_APPROVED → PENDING → SETTLED` and age-boundary decisions.
The UI is available at `/#risk-transfer`, also linked from the existing Transfer page.
The Agent's `create_transfer_draft` tool returns a direct link to a server-owned draft.
Existing saved payees and account references are reused; raw account numbers are not
accepted by the new draft API. Draft creation and editing never hold funds.

Optional visual verification (use an installed Playwright package):

```powershell
$env:PLAYWRIGHT_PACKAGE='D:\path\to\node_modules\playwright\package.json'
node scripts/check-risk-ui.mjs
```

The browser script uses an isolated database, checks 320/390/1280 widths, large-text
mode, masked payee details, PIN confirmation and successful mock settlement. It writes
screenshots to `test-results/risk-mvp/`, never to the production database.

## Configuration

| Setting | Default / effect |
| --- | --- |
| `LIVE_PAYMENT_ENABLED` | false; setting true aborts startup; no live adapter exists |
| `RISK_AGE_MODE` | shadow; `enforce` activates age interventions, never age-only denial |
| `RISK_POLICY_FILE` | optional JSON file matching `server/risk/age-policy.json` |
| `RISK_REVIEWER_IDS` | empty; comma-separated existing user IDs, configured only by operator |

The policy contains timezone, jurisdiction metadata, age bands and intervention thresholds.
Invalid settings fail startup. Roll back by restoring an approved policy file and restarting;
the exact policy content hash is included in recorded versions. No HTTP API changes policy.
The supplied YAML sample is preserved unchanged. Policy thresholds are experimental,
not legal limits or calibrated fraud probabilities.

Trusted adapter options on `createApp({risk:...})` are `identity(userId)`,
`signals(userId,candidate)`, `transactions(userId)`, `coverageStart(userId)` and
`available()`. Each returns a bounded synchronous snapshot, or throws when unavailable.
Identity is `{verified,dob,sourceRef}`. Signals need a supported type, verified provenance,
source reference and expiry. Only backend wiring can supply these; request fields and
model memory cannot. Tests demonstrate adapters without manufacturing real KYC records.

Existing ledger timestamps are treated as occurrence dates (the simulator has no separate
sync timestamp). Imported recurring/refund classification reuses the existing import
classification; it is not a bank attestation. Self-transfer exclusion requires a verified
account reference owned by the same user; matching names or a statement's “本人” text
do not establish ownership. Currency is explicitly CNY for this repository.
Pure functions also handle independent currencies. Missing coverage does not turn empty
historical months into asserted complete zero-spend months. No raw DOB is persisted in
risk storage, exported to the Agent, or written to logs.

## API (all paths under /api)

Existing session cookie/Bearer authentication and same-origin write protection apply.
Writes/reviews have per-user rate limiting. Errors include 400 invalid schema, 403 resource
or authorization denial, 404 `RECIPIENT_NOT_FOUND` for an in-bank payee whose card does not
exist, 409 stale version/state, 429 throttling and 503 risk unavailable.

| Method/path | Body or response |
| --- | --- |
| GET `/v1/finance/risk-summary` | User-visible flags only |
| POST `/v1/transfers/drafts` | `{sourceAccountRef,beneficiaryRef,amountMinor,currency:"CNY",memo?}` |
| GET `/v1/transfers/drafts` | Own drafts, masked account details |
| GET `/v1/transfers/drafts/:id` | Authoritative confirmation snapshot |
| PATCH `/v1/transfers/drafts/:id` | `{version,...changedDraftFields}`; revokes all old approvals |
| POST `/v1/transfers/drafts/:id/approval-intents` | `{version,payloadHash}`; returns challenge and optional verificationActionId |
| POST `/v1/transfers/drafts/:id/approve` | `{challengeId,version,payloadHash,pin,verificationToken?}` |
| POST `/v1/transfers/drafts/:id/cancel` | `{}`; only before provider submission; a lapsed draft returns as EXPIRED |
| GET `/v1/transfers/:id/status` | Separates approved, pending and settled states |
| GET `/v1/risk/flags` | Own flag IDs/lifecycle, no detector thresholds |
| POST `/v1/risk/appeals` | `{flagId,rationale}` |
| GET `/internal/risk/reviews` | Reviewer-only redacted queue/evidence |
| POST `/internal/risk/reviews` | `{flagId,disposition,rationale,nextReviewAt?}` |
| GET `/internal/risk/fairness` | Week/version/core risk/age band/boundary cohorts |
| POST `/internal/payments/submit` | Always 403; executor is private to backend |
| POST `/webhooks/payments/mock` | Signed adapter envelope; no session required |

Strong verification uses the existing `/verify/start`, `/verify/face` or configured face
provider, and `/verify/complete` routes for the supplied verificationActionId. Never put
PINs, verification tokens or complete dates of birth into chat messages or logs.
The browser approval handler automatically invokes private submission after approval.
If a recheck fails, status stays unsubmitted; users obtain a new intent after resolving it.
An unknown provider outcome stays PENDING, including across process restart. Maintenance
reconciles by provider key. It never reports success merely because approval succeeded.

Flags transition OPEN → UNDER_REVIEW → CONFIRMED / FALSE_POSITIVE / RESOLVED;
OPEN and UNDER_REVIEW flags expire after seven days. Confirmation requires next review time:
a CONFIRMED flag stays in force past that time and returns to the reviewer queue when due,
and only a review closes it (CONFIRMED → UNDER_REVIEW, which restarts the seven days).
Confirming a flag, or a later HOLD_REVIEW/BLOCK on the same concern, raises its payee link to
HIGH, so confirmed fraud blocks further payments to that payee whatever the first decision was.
A HOLD_REVIEW or BLOCK decision and its flags stay on record even when they abort a legacy
request. Every review requires rationale and reviewer identity. Appeals are recorded; there is
no invented review SLA. An unresolved draft points to the existing support page.

Fairness uses latest pre-approval snapshot per draft, grouped by week, policy, objective
core action, age band and boundary cohorts 59/60, 64/65, 69/70, 79/80. Rates include
step-up, approval, completion, cancellation, authentication failure, appeal and false-positive
disposition. Fewer than 20 samples yields null rates / INSUFFICIENT_DATA; otherwise these
are descriptive counts, not causal significance. Verified loss and accessibility error
rates remain null until trusted outcome feeds exist. Evaluation latency is recorded.

## Migration and rollback

Startup runs additive, idempotent `migrateRisk`, recorded as `risk-mvp-v1` in
`schema_migrations`. New tables are namespaced `risk_*`; existing balances and user
identities are not rewritten. Immutable evaluation triggers prevent accidental edits/deletes.
The mock signing key and provider state persist so restart reconciliation remains possible.
The simulator database, including this mock key, requires the existing filesystem access
controls; production encryption and key management are not supplied by this MVP.

Before applying to a persistent simulator database, stop writes and take a consistent
SQLite backup (for example the SQLite CLI `.backup` command); do not copy only a live
WAL database's main file. Record the application commit and policy content.

To roll back the application:

1. Stop new traffic and the scheduler. Inspect `risk_payments` for SUBMITTING/PENDING.
2. Reconcile these payments using the current version. Do not release uncertain payment
   reservations or blindly retry them. If unresolved, retain this version for reconciliation.
3. Cancel remaining unsubmitted drafts through the API, then stop the app.
4. Restore the previous application/policy and keep the database plus risk audit tables.
   Do not drop tables, delete settled payments, or overwrite balances with an old backup.
5. A pre-migration backup is for recovery before new financial activity; after activity,
   reconcile records instead. The restart test verifies migration idempotency and exactly
   one posting after recovery.

## Validation results

See `VALIDATION.md` for final commands/results and known existing dependency advisories.
