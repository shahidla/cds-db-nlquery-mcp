# Release verification log

Manual pre-release verification results — kept as a permanent, append-only
record so "was this actually tested against real infrastructure" is answerable
from the repository itself, not from an unverifiable claim in a chat or commit
message. Each entry is the **real, unedited output** of running both
deployment-verification scripts (see `examples/capability-demo/README.md`)
against a live BTP HANA Cloud deployment of `examples/capability-demo/`'s
schema, immediately before tagging the named version.

This is a required manual step before every release (see `README.md`'s "How
releases are tested") — `npm test`'s 123 mocked unit tests are necessary but
not sufficient on their own; this package's actual behavior depends on real
CDS/database/adapter behavior that a mock cannot fully stand in for.

---

## v0.7.0 — 2026-06-22

**On top of commit:** `e292b628dcac7cf54b7b9a88484ff2801886e5fe`
**Database:** BTP HANA Cloud trial, modern `@cap-js/hana` adapter
**LLM:** Claude (`claude-haiku-4-5-20251001`)

### 1. `validate-deployment.js` — every example descriptor executed directly (no LLM)

```
=== Summary: 35 passed, 0 failed, 0 known HANA limitations, 0 skipped (of 35) ===
```

### 2. `smoke-test-server.js` — `src/mcp-server.js` spawned as a real child process, driven over the actual MCP stdio protocol, real LLM call per question

| Question | Descriptor produced | Result |
|---|---|---|
| "How many orders does each customer have, and what is the total amount?" | `entity: Orders`, `aggregate: [count(*), sum(AMOUNT)]`, `groupBy: CUSTOMER_ID, customer.NAME` | 3 rows, no error |
| "Show me all descendants of account A1" | `entity: Accounts`, `hierarchy: {assoc: children, direction: descendants, startWhere: ID=A1}` | 5 rows, no error |
| "Show me each order with its line items nested inside" | `entity: Orders`, `expand: [{assoc: items}]` | 6 rows, no error |

```
All questions answered without error.
```

Full raw output (both scripts, unedited) — `release-verification-0.7.0.txt`,
generated alongside this entry, same run.
