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

This isn't just a description of a workflow — there are four ready-to-run scripts
in this folder that actually implement it, the same ones used to find and verify
every fix described in this README and in `BLOG.md`'s "Real bugs, found and fixed"
section.

1. Build a CAP project from `schema.cds` + `data/`, deploy it (HANA on BTP, or
   SQLite for local testing), and make sure your project's cds config
   (`.cdsrc.json` / `.cdsrc-private.json` / bound service) points at it.
2. **`validate-deployment.js`** — runs every hand-written descriptor in
   `queries.js` directly (no LLM involved) against your deployment and compares
   the rows to `results.json`. This tells you whether the *execution* layer
   (CQN → SQL → rows) works correctly on your specific backend/adapter.
   ```sh
   node examples/capability-demo/validate-deployment.js
   # on the legacy @sap/hana-client runtime, 4 entries are confirmed limitations:
   LEGACY_HANA_CLIENT=true node examples/capability-demo/validate-deployment.js
   ```
3. **`ask.js`** — ask your own natural-language question against your deployment,
   end-to-end through a real LLM. Useful for trying things `queries.js` doesn't
   cover.
   ```sh
   node examples/capability-demo/ask.js "Which loans have a DTI above 50?"
   node examples/capability-demo/ask.js --provider=anthropic "..."
   ```
4. **`ask-batch.js`** — runs every `queries.js` question's *natural-language* text
   (not the hand-written descriptor) through a real LLM and compares the result.
   This is what actually distinguishes an LLM mistake from a package bug — see
   `BLOG.md` for what this surfaced in practice.
   ```sh
   node examples/capability-demo/ask-batch.js                    # DeepSeek/OpenAI-compatible
   node examples/capability-demo/ask-batch.js --provider=anthropic
   ```
   Both need the relevant API key as an env var (`OPENAI_API_KEY` +
   `OPENAI_BASE_URL` for DeepSeek/Groq/etc., or `ANTHROPIC_API_KEY` for Claude).
5. **`smoke-test-server.js`** — unlike the three scripts above, which all call
   `src/schema-reader.js`/`src/query-executor.js`/`src/llm-planner.js` directly
   via `require()`, this one spawns `src/mcp-server.js` itself as a real child
   process and drives it through the actual MCP stdio/JSON-RPC protocol via
   `@modelcontextprotocol/sdk`'s `Client` — the same way Claude Code, Claude
   Desktop, or `npx -y @shahid.la/cds-db-nlquery-mcp` actually invoke it. The other
   scripts confirm the library code is correct; this one confirms the *published
   artifact*, talked to the way a real consumer talks to it, is correct too.
   ```sh
   node examples/capability-demo/smoke-test-server.js
   ```
6. Any mismatch from `validate-deployment.js` is either a real bug, or an expected
   backend-specific SQL syntax difference (this demo's `results.json` was
   generated against SQLite; HANA's `cqn2sql` may emit slightly different SQL
   text for the same CQN — the CQN itself, and the rows, should match regardless
   of backend).

   **Tested against real BTP HANA Cloud with both HANA adapters CDS supports** —
   the legacy `@sap/hana-client`-based runtime (still the default for most existing
   CAP+HANA projects), and the modern `@cap-js/db-service`-based `@cap-js/hana`.
   As of this writing, `queries.js` has 35 entries (3 deliberately test rejection
   behavior, 32 expect real rows). Findings:

   - **With `@cap-js/hana` installed: all 35 entries pass**, the 32 real-row ones
     exactly matching `results.json`'s SQLite-generated rows. This includes
     `viaFiltered` inside `aggregate`/`having` and every window function (rank,
     top-N-per-group, running total) — confirmed with real, hand-verified numbers
     (e.g. filtered per-customer sums and per-partition rankings checked by hand
     against the seed data), not just "didn't throw."
   - **With the legacy `@sap/hana-client` runtime: 2 things are genuinely
     adapter-specific**, root-caused against a real deployment, not just inferred:
     - `viaFiltered` inside `aggregate`/`having` crashes inside CDS's own internal
       alias-generation utility (`generateAliases.js`, `"table.startsWith is not a
       function"`) — it assumes a plain string table alias, but `viaFiltered`
       produces a structured `{ id, where }` hop there.
     - Window functions' `OVER` clause is silently dropped by the legacy runtime's
       function renderer (no error — the query just runs with the clause missing,
       then HANA itself throws a syntax error on the malformed SQL that results).
     This package detects which adapter is connected (via `db.cqn2sql`'s
     presence) and rejects both with a clear, actionable error **only** on the
     legacy runtime — on `@cap-js/hana` both work correctly and are not rejected.
   - **The decimal-as-string-vs-number and unaliased-joined-column-naming
     differences noted in earlier testing were also legacy-runtime-specific** —
     `@cap-js/hana` matches `@cap-js/sqlite`'s conventions (JS numbers, and
     `sector_DESCRIPTION`-style auto-aliasing) exactly. They only matter if you're
     still on the legacy runtime.
   - **Several other real bugs found via this same live-HANA testing were NOT
     adapter-specific** — they affected both adapters equally and are fixed at
     the package level, not adapter-detected around: `expand`'s `orderBy`/`limit`
     truncation was unimplemented at first; three post-fetch steps (enum-to-text
     translation, the row cap, blocked-column stripping) all silently skipped a
     `to-one` nested branch; an unrecognized top-level descriptor field was
     silently ignored instead of rejected; colliding output-column aliases across
     `select`/`aggregate`/`window`/`caseWhen` reached HANA as a raw SQL crash; the
     standard SQL "every non-aggregated select column needs groupBy" rule wasn't
     enforced. See git history / `BLOG.md` for the full account of each.
   - One more, found only reachable on the **modern** adapter specifically (window
     functions are rejected outright on the legacy one, so this code path is
     never reached there): a top-level `orderBy` using an association path,
     combined with `windowFilter`, crashes inside `@cap-js/db-service`'s own query
     inference (`"X not found in the elements of undefined"`) because the
     `windowFilter` wrapper has no association metadata left to resolve a path
     against. Rejected explicitly with a workaround instead of letting that
     surface.

   **Bottom line**: this package's CQN construction is correct for every
   capability it claims to support, on a modern adapter. The legacy
   `@sap/hana-client` runtime has 2 confirmed limitations this package can detect
   and reject but not fix (switching to `@cap-js/hana` is confirmed, not just
   theorized, to resolve them — your project's own dependency decision). Every
   other bug found this way was a real defect in this package's own code, now
   fixed and covered by a regression test.

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
