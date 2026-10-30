# ADR-001: Extend the simulator without replacing its authorization engine

Status: implemented. Scope: one reviewable PR covering PR0–PR6 work packages.

The repository already has authenticated App confirmation, canonical action digests,
SQLite execution locks, single-use authorizations, SMS/face verification and plans.
Replacing those components would break scheduled and IM-originated operations.

1. Keep the existing APIs, accounts, ledger, scheduler and authorization engine.
   Add the same objective risk checks to proposal/approval/final settlement paths.
   STEP_UP maps to existing strong verification. Pending payments in the new flow
   count in the old daily policy as well. Existing configured limits remain age-neutral.
2. Editable transfers use a small separate `risk_drafts` protocol. An edit increments
   version, hashes the complete server-resolved payee/account/amount/currency/memo/fee
   snapshot and revokes all prior challenges and approvals. Draft creation does not
   reserve funds. Final mock settlement posts into existing transactions/ledger.
3. Reuse existing PIN authentication and, when required, SMS/face verification with
   a private `risk_transfer_approval` action bound to challenge/hash/version. No boolean
   or chat text can produce approval. These are explicitly **sandbox assertions**;
   they are not claimed to be production WebAuthn or bank authorization.
4. The executor is a backend closure, absent from the Agent tool facade. The public
   internal-submit route always rejects. Approval HTTP handlers authenticate the
   user, then invoke the executor internally. There is no new network service or
   provider credential exposed to the model. Existing in-process Agent identity is
   retained; this PR does not invent a separate OAuth issuer or payment service.
5. Only mock payment is implemented. Durable provider keys, signatures, event sequence,
   unique draft execution and atomically consumed approval protect the new protocol.
   Once submitted, ambiguous results remain PENDING and reconciliation queries by key;
   it never resubmits an uncertain payment. Legacy simulator transfers remain local
   atomic postings, with the additional final risk gate; they are not live payments.
6. KYC and device/fraud feeds are backend-only synchronous snapshot adapters. No
   network call occurs inside a SQLite transaction. Unavailable or asynchronous feeds
   fail closed; deployments must refresh trusted snapshots separately. Default DOB is
   UNKNOWN, never inferred from chat, identity enrolment or demo-user phone numbers.
7. Validated JSON mirrors the supplied YAML age matrix without adding a YAML runtime
   dependency. Shadow records hypothetical interventions; enforce activates them.
   A content digest supplements the declared policy version, so editing configuration
   without changing its version still cannot reuse an old approval after restart.
8. Review is an authenticated, explicit reviewer allowlist API, not a new admin app.
   Review changes work-item status, never payment authorization. Flags do not add to
   future risk scores; current objective facts do. A false-positive disposition suppresses
   an identical flag for the same draft/facts until expiry. Confirmed provider fraud
   requires correction at its trusted source; a review cannot silently bypass it.

Unsupported production capabilities: verified DOB feed, WebAuthn/bank auth adapter,
real bank execution/recipient-name verification, legal retention/deletion policy,
database encryption-at-rest/key management, staffed review SLA and verified fraud-loss
or accessibility telemetry. They remain explicit launch dependencies. No live-payment
promotion is possible with this code. The existing simulator enrolment rules still
govern account eligibility; elder protection does not establish minor eligibility.

The rollback is additive: reconcile pending payments before reverting the application,
retain risk tables and immutable evaluations, and never restore an old balance snapshot
over completed activity. See OPERATIONS.md.
