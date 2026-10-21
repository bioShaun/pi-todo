# AGENTS.md

Architecture, tool contract, persistence/context invariants, and test commands live in [CLAUDE.md](CLAUDE.md). This file records cross-cutting engineering principles.

## Principles

- Preserve error specificity end-to-end. Validators return precise failures ("must be a string", "cannot be blank", "cannot exceed N characters"); call sites must propagate them instead of collapsing distinct failure modes into a generic message. Distinguish "field absent" (report `missing ...`) from "field present but malformed" (surface the validator's error verbatim). Accurate diagnostics are part of the contract: model callers decide retries from them, and users debugging corrupted session snapshots rely on them to locate what is actually wrong.
- Aggregate independent validation failures in one batch response. Atomicity still applies: collect every item/update error first, then reject the whole batch without persisting. Do not stop at the first failure when later failures are independently discoverable, and do not let aggregation turn a partial mutation into a persisted one.
