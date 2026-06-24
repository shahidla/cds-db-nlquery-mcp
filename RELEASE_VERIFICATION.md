# Release verification log

Manual pre-release verification results — kept as a permanent, append-only
record so "was this actually tested against real infrastructure" is answerable
from the repository itself, not from an unverifiable claim in a chat or commit
message. Each entry is the **real, unedited output** of running both
deployment-verification scripts (see `examples/capability-demo/README.md`)
against a live BTP HANA Cloud deployment of `examples/capability-demo/`'s
schema, immediately before tagging the named version.

This is a required manual step before every release (see `README.md`'s "How
releases are tested") — `npm test`'s 126 mocked unit tests are necessary but
not sufficient on their own; this package's actual behavior depends on real
CDS/database/adapter behavior that a mock cannot fully stand in for.

---

## v0.7.1 / v0.7.2 — 2026-06-24

**On top of commits:** `9a20f27` (0.7.1), `3fcd303` (0.7.2)
**Database:** real production HANA Cloud deployment of
[Banking-Sentinel](https://github.com/shahidla/Banking-Sentinel) — not this
repo's own `examples/capability-demo/` schema.
**LLM:** Claude (`claude-haiku-4-5-20251001`)

This release's verification path differs from the usual `validate-deployment.js`/
`smoke-test-server.js` run against `examples/capability-demo/` — recording that
honestly rather than implying it was the same process. The bug was found and
fixed in direct response to a real production failure, and verified against
that exact failure on real HANA rather than the synthetic demo schema:

**The bug:** Banking-Sentinel's "What is the total loan amount across all
customers?" intermittently returned wrong totals or a flat error
(`invalid column name: SUM(AMOUNT)`) — the planning LLM occasionally put a
function-call string into `select` instead of using the `aggregate` field.

**Verification — before the fix (0.7.0), reproduced against live HANA:**
```
> executeDescriptor({ entity: 'Loans', select: ['SUM(AMOUNT)'] }, schema, {})
HANA error: invalid column name: SUM(AMOUNT)
```

**Verification — after the fix, same live HANA connection:**
```
> executeDescriptor({ entity: 'Loans', select: ['SUM(AMOUNT)'] }, schema, {})
CAUGHT: Found function-call syntax used as a plain column name: SUM(AMOUNT). [...]
Use the "aggregate" field for sum/count/avg/min/max [...]

> executeDescriptor({ entity: 'Loans', select: ['SUM(AMOUNT) AS TOTAL_AMOUNT'] }, schema, {})
CAUGHT: Found function-call syntax used as a plain column name: SUM(AMOUNT) AS TOTAL_AMOUNT. [...]

> executeDescriptor({ entity: 'Loans', aggregate: [{ fn: 'sum', col: 'AMOUNT', as: 'total_loan_amount' }] }, schema, {})
ROWS: [{"total_loan_amount":"31773000.00"}]
```
`31,773,000.00` matches ground truth (30 loan records, confirmed via a direct
`SELECT SUM(AMOUNT)` against the same table). Re-ran end-to-end through
Banking-Sentinel's full `/a2a/agent` pipeline 5/5 times after the fix —
consistent correct total every time, where pre-fix runs had varied across at
least four different wrong outcomes (two different incorrect totals, a false
"no rows" answer, and the raw HANA error above) across repeated attempts.

`npm test`: 126 passed, 0 failed (123 from v0.7.0 + 2 new regression tests for
this fix). `npm run lint`: clean.

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
