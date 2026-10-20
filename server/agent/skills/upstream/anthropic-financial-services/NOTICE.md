# Third-party attribution and adaptation notice

Upstream: Anthropic's [financial-services](https://github.com/anthropics/financial-services) repository.
License: Apache License 2.0; the unmodified license is included as `LICENSE`.
Pinned revision: `574ed3624aebd0418c7e96cd101262f30210ab26`.
Source paths, immutable URLs and SHA-256 checksums are recorded in `sources.json`.

The three Markdown source snapshots in this directory are unmodified copies, retained for provenance and human review. They are **not executable instructions for this repository** and are not loaded into the banking model prompt. Referenced upstream examples, code, connectors and plugins have not been installed.

AI-Banking adaptations, created 2026-10-20, are separate files under `server/agent/skills/`:

- `cashflow_reconciliation.json`: adapted from `gl-recon.md`. Uses this application's authorized ledger/transaction tools, integer cents and read-only analysis sandbox. Does not claim to reconcile an external ledger without a second source.
- `budget_variance.json`: adapted from `variance-commentary.md`. Applies period/scope alignment, variance decomposition and evidence-backed explanations to personal budgeting. Does not adopt corporate materiality defaults or invent a budget.
- `product_comparison.json`: adapted from `comps-analysis.md`. Uses comparability, consistent periods, source/date checks and missing-data disclosure for retail products. Does not apply corporate valuation multiples, example financial data or spreadsheet instructions to funds/deposits. Recommendations continue through `wealth_advice`.

These Chinese adaptations are modified, limited application workflows, not verbatim translations or complete implementations of the upstream financial-service skills. Existing bank permissions, confirmations and tool-derived facts remain authoritative. No affiliation or endorsement is implied.
