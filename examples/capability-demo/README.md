# Capability demo

A self-contained CDS schema + sample data + an exhaustive list of natural-language
queries exercising every capability this MCP server supports — both the
capabilities that existed before the latest extension round ("old") and the ones
added in it ("new").

**Everything in `results.json` was produced by actually running this repo's code**
(`src/schema-reader.js` + `src/query-executor.js`) against a real in-memory SQLite
database (via `@cap-js/sqlite`), not hand-written or recalled from memory. Re-run
`node generate.js` from the repo root at any time to reproduce it yourself.

## Files

- `schema.cds` — the demo data model. Covers: a flat to-one association
  (`Orders.customer`), a to-many composition for `expand` (`Orders.items`), a
  self-referencing association for `hierarchy` (`Accounts.parent`/`children`), a
  native CDS `enum` (`Orders.STATUS`), `@Semantics.amount.currencyCode`
  (`Orders.AMOUNT`/`CURRENCY`), `@assert.range` (`Loans.DTI`), `@cds.search`
  (`Customers`), a calculated-on-read column (`Customers.FULL`), and
  `@Common.ValueList` (`Loans.SECTOR` → `Sectors.DESCRIPTION`). Also includes one
  `@cds.persistence.skip` entity (`InternalAudit`) to demonstrate it being excluded
  from the queryable schema entirely, and one temporal entity
  (`WorkAssignments`, via `@cds.valid.from`/`@cds.valid.to`) for `asOf`
  time-travel queries.
- `data/*.csv` — seed data for every entity (CAP's standard
  `<namespace>-<Entity>.csv` naming convention).
- `queries.js` — the query list: for each entry, a natural-language question
  (`nl`) and the descriptor JSON (`descriptor`) that `src/llm-planner.js` would be
  expected to produce for it. A few entries are marked `error: true` — these are
  deliberately invalid descriptors included to demonstrate the executor's own
  validation (e.g. requesting a "hierarchy" over a non-self-referencing
  association).
- `generate.js` — loads `schema.cds`, deploys it (with the seed data) to a real
  in-memory SQLite database, builds the schema via `buildSchema()`, then runs
  every entry in `queries.js` through `executeDescriptor()` for real, capturing:
  - the exact CQN object(s) the executor built (a hierarchy query issues one CQN
    SELECT per tree level, captured in order)
  - the actual generated SQL for each CQN, via `db.cqn2sql(query).sql` (parameterized,
    with `?` placeholders — the raw form CAP itself produces)
  - a human-readable equivalent of that same SQL (`readableSql`) — bind values
    inlined as literals and keywords broken onto their own line, for eyeballing
    or diffing against a BTP deployment by hand. **Inlining literals this way is
    not SQL-injection-safe and this string is never used to execute anything** —
    it exists purely for this `results.json` file, not as a re-runnable query.
  - the actual result rows returned by the (real, in-memory) database
  - or the actual error message thrown, for the `error: true` entries
- `schema-prompt.txt` — the exact text `buildSchemaPrompt()` produces for this
  schema — this is what the LLM planner actually sees as schema context.
- `results.json` — the generated output described above, one entry per query in
  `queries.js`, keyed by `id`.

## How to use this to validate a deployed app

1. Build a CAP project from `schema.cds` + `data/`, deploy it (HANA on BTP, or
   SQLite for local testing).
2. Wire up this repo's MCP server against that deployment (or call
   `executeDescriptor()` directly) and run each query's `descriptor` from
   `queries.js`.
3. Compare:
   - the SQL your deployment actually executes against `results.json`'s `sql`
     field for that query's `id`,
   - the rows you get back against `results.json`'s `rows`.
4. Any mismatch is either a real bug, or an expected backend-specific SQL syntax
   difference (this demo generates SQLite-flavored SQL; HANA's `cqn2sql` may emit
   slightly different SQL text for the same CQN — the CQN itself, and the rows,
   should match regardless of backend).

   **Two confirmed, non-bug differences found by actually running this demo's
   schema against a real BTP HANA Cloud deployment** (not just SQLite):
   - **Decimal columns come back as strings on HANA** (`"1500.00"`), as JS numbers
     on SQLite (`1500`) — same value, different driver representation. Compare
     numerically, not via strict string/JSON equality.
   - **An unaliased joined column's default name differs by backend** when there's
     no leaf-name collision to force an explicit alias — e.g. `sector.DESCRIPTION`
     with no `as` comes back named `DESCRIPTION` on HANA's legacy runtime, but
     `sector_DESCRIPTION` on `@cap-js/sqlite`. Give an explicit `{ "col": "...",
     "as": "..." }` alias whenever consistent column naming across backends
     matters — don't rely on the implicit default.

   **One confirmed real limitation of this package's current implementation when
   connected through the legacy `@sap/hana-client`-based HANA runtime** (still the
   peer-dep target most existing CAP+HANA projects use today, as opposed to the
   newer `@cap-js/db-service`-based `@cap-js/hana`):
   - `viaFiltered` inside `aggregate` or `having` — and **all window functions** —
     are rejected with a clear error instead of silently producing wrong/broken
     SQL. Root cause confirmed against a real deployment in both cases (not
     inferred): CDS's own internal alias-generation utility crashes on a
     `viaFiltered` ref inside an aggregate argument; window functions' `OVER`
     clause is silently dropped by the legacy runtime's function renderer. A
     modern `@cap-js/db-service`-based HANA adapter would very likely render both
     correctly (confirmed: the shared `func()` renderer in `@cap-js/db-service`,
     which both `@cap-js/sqlite` and `@cap-js/hana` build on, explicitly handles
     the CQN shape this package generates) — but switching HANA drivers is the
     consuming project's decision, not something this package does for them.

## Regenerating

```sh
cd <repo root>
node examples/capability-demo/generate.js
```

Requires `@cap-js/sqlite` as a devDependency of the repo (already installed via
`npm install --save-dev @cap-js/sqlite@1.11.1` — pinned to this version because
newer 2.x releases require `@sap/cds >=9.8`, while this repo targets `@sap/cds ^8`).

## A bug this demo caught

Building this demo against a **real compiled** CDS model (rather than the
hand-built CSN object literals used in the unit tests) surfaced a genuine bug:
the real CDS compiler flattens a dictionary-valued annotation like
`@cds.search: {NAME, NOTES}` into dotted-path keys (`@cds.search.NAME`,
`@cds.search.NOTES`) on the definition, rather than leaving a nested object at
`def['@cds.search']`. The same is true of `@Common.ValueList`. Both reads in
`src/schema-reader.js` assumed the nested-object form and were silently broken
against any model compiled from real `.cds` source — only the unit tests (which
construct already-nested CSN by hand) passed. This has been fixed (see
`src/schema-reader.js`'s `getAnnotation()` helper) and covered by new regression
tests that reproduce the real compiler's flattened shape directly.
