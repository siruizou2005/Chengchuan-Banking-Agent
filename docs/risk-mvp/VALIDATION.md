# Validation record — 2026-10-28

Local environment: Windows, Node v22.19.0 and Node v24.22.1 with `node:sqlite` (repository/CI target: Node 24); all databases used by these checks
were isolated test databases. No deployment, real identity verification or live payment
was performed.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=2 tests/*.test.mjs` | After integrating latest main: **237 passed**, 0 failed, 0 cancelled (276.2 s); initial base was 217/217 |
| Node v24.22.1: `node --test tests/risk-mvp.test.mjs` | **16 passed**, 0 failed (12.5 s), on the merged branch |
| `node --test --test-concurrency=2 tests/risk-mvp.test.mjs tests/permissions.test.mjs tests/bank.test.mjs` | After final risk-policy/ownership validation: 59 passed, 0 failed (109.9 s) |
| `node --test tests/risk-mvp.test.mjs` | After final atomic draft-state guard: 16 passed, 0 failed (42.5 s) |
| `npm run build` | TypeScript and Vite passed; existing large-chunk warning remains |
| `node scripts/check-risk-ui.mjs` | Masked confirmation, 320/390/1280 widths, large text, PIN approval and mock settlement passed; no browser errors |
| `npm run demo:risk` | RISK_CHECKED → USER_APPROVED → PENDING → SETTLED; 64/65/80 age examples |
| `git diff --check` | Passed |
| `npm audit --json` | 7 existing dependency findings: 6 high, 1 moderate; **not a passing release gate** |

The original `interface-nb-v2` branch was already merged/deleted on GitHub. This branch
integrates current `main` (`38d927c`), retaining enrollment, onboarding and report push;
its PR diff contains only the risk MVP additions and small integration changes. The
merged branch was rebuilt and browser-tested again. Node 24 was downloaded from the
official Node distribution and verified against its SHA-256 manifest, only under ignored
test-results. GitHub's Linux/Node 24 checks are linked from
[PR #30](https://github.com/siruizou2005/AI-Banking/pull/30).

The dependency findings affect `@larksuiteoapi/node-sdk`, `axios`, `body-parser`,
`express`, `follow-redirects`, `qs`, and `vite`. This PR adds no runtime dependency and
does not upgrade unrelated packages. Resolve/reassess those advisories separately
before production promotion. The MVP itself cannot enable live payments.

The first unrestricted parallel regression run hit a local channel-request timeout and
cancelled product tests. Isolated reproduction confirmed the product test's fake fetch
had no socket keeping Node alive for an unref'ed AbortSignal timeout. A test-only keepalive,
cleared in teardown, fixes that harness issue. The bounded-concurrency full run passed.
No product implementation was changed for this test issue.

## Spec coverage in tests/risk-mvp.test.mjs

| Requirement | Automated coverage |
| --- | --- |
| T01 | Authenticated normal draft → mock payment; one posting |
| T02 | Verified own-account exclusion; income/refund/currency separation |
| T03 | 59/60, 64/65, 69/70, 79/80 birthdays, timezone, Feb 29 and invalid dates |
| T04 | Two independent moderate/mild sources permit WARN → STEP_UP at 65 |
| T05 | Core severe/block decision is not weakened or increased by age |
| T06 | Every adult age 18–105 with no evidence remains ALLOW; no family authorization |
| T07 | Invalid/unverified DOB becomes UNKNOWN; no client DOB or age override |
| T08 | Seasonal income, large outflows, zero MAD, insufficient history, month day one |
| T09 | Draft edits increment version and revoke issued challenges/approvals |
| T10 | Boolean approval, unsupported executor tools and forged fields cannot authorize |
| T11 | Trusted fraud signal after approval prevents submission |
| T12 | Concurrent approval, one provider key, duplicate/out-of-order callbacks, timeout/restart reconciliation |
| T13 | Risk unavailability blocks new and legacy execution |
| T14 | Instruction-like memo remains data; no payment permission added |
| T15 | FALSE_POSITIVE review and immutable evaluation/audit history |
| T16 | Cross-user draft/appeal denial, reviewer RBAC, no DOB exposure |
| T17 | PENDING never presented as SETTLED; forged signatures and payload changes rejected |
| T18 | Authenticated higher-value mock payment for ages 30/60/65/70/80/85 |
| T19 | Live mode rejected; responses explicitly simulated |
| T20 | Policy upgrade/rollback, flag expiry and renewed approval |

Additional checks cover malformed monetary input, saved-payload integrity, beneficiary
substitution, balance changes, old/new payment cumulative thresholds, additive migration
idempotency and exactly one posting after restarting a persistent SQLite database.

Logs/screenshots are local ignored artifacts under `test-results/risk-mvp*`. The browser
dependency used for local visual QA was installed under ignored test-results, not added
to package.json/package-lock.json. CI now also runs the existing build after tests.

## Remaining external acceptance work

Real KYC, bank authorization/execution, production encryption/key handling, legally
approved retention, staffed review SLA, calibrated thresholds and outcome-based fairness
evaluation require external integrations or business decisions. Their absence is disclosed
in ADR-001; mock tests do not establish production compliance or fraud-model accuracy.
