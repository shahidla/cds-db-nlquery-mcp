# Ask Your SAP HANA Database Questions in Plain English — No SQL Required

**An MCP server that turns natural language questions into real CDS queries — with automatic SQL JOINs, schema-driven disambiguation, and minimal configuration — against your existing SAP CAP db-layer entities.**

If you work with SAP CAP projects, you know the drill: a business question comes in, you open your SQL editor, figure out which tables hold the answer, work out the JOINs and filter conditions, and 20 minutes later you have a result. Ask a slightly different question and you start over.

What if you could just *ask*?

```
Which customers have a DTI ratio above 5?
```

And get this back:

```
Results: 3 rows

Partner    : 30100003
DTI Ratio  : 7.20
Customer   : Domestic Customer AU 3

Partner    : 30100001
DTI Ratio  : 5.80
Customer   : Domestic Customer AU 1

Partner    : 30100004
DTI Ratio  : 5.40
Customer   : Domestic Customer AU 4
```

That's what **[cds-db-nlquery-mcp](https://github.com/shahidla/cds-db-nlquery-mcp)** does. It's an MCP server that sits on top of your SAP CAP project and lets you query your database-layer entities — the ones defined in `db/schema.cds`, not your OData service layer — in natural language, from Claude Code, Claude Desktop, or any MCP-compatible host.

Here's how it works, why it's architected this way, and three real examples against a live HANA Cloud schema.

---

## How It Works, At a Glance

```
 Your question (plain English)
        │
        ▼
 ┌────────────────────────┐
 │ Stage 1 — LLM           │  reads your CDS schema (labels, associations,
 │ Question → Descriptor   │  @Common.Text, enums) → outputs JSON only:
 └─────────┬───────────────┘  { entity, select, where, valCol, limit }
           │  JSON descriptor
           ▼
 ┌────────────────────────┐
 │ Stage 2 — CDS           │  descriptor → CQN → real SQL JOINs,
 │ Descriptor → SQL        │  generated from association metadata —
 └─────────┬───────────────┘  not guessed by the LLM
           │  rows from HANA
           ▼
 ┌────────────────────────┐
 │ Stage 3 — Answer        │  MCP client renders the rows, or hands them
 │ Rows → Plain English    │  to a second LLM call to phrase the answer
 └────────────────────────┘

   The LLM never touches SQL. CDS never touches your question.
```

---

## Why This Isn't "LLM Writes SQL"

Most natural-language-to-SQL demos work the same way: dump the whole database schema into a prompt, ask the LLM to write SQL, run whatever comes back. That's fast to build and brittle to run — the LLM has to get table names, JOIN syntax, and HANA-specific SQL right in one shot, with no framework checking its work.

This package splits the problem in two:

1. **The LLM's only job is translation.** It reads your CDS schema and turns a question into a small JSON descriptor — entity, columns, filters. It never writes SQL.
2. **The CDS framework's only job is execution.** It turns that descriptor into a CQN query (CDS's own query representation) using association-path expressions, and lets CDS — not the LLM, not hand-written SQL — generate the actual SQL JOINs that HANA executes.

That division matters because it's where most "AI + database" tools quietly fail: doing JOINs in JavaScript after fetching too much data, or trusting the LLM to write syntactically valid HANA SQL from scratch. Neither happens here. There's no JavaScript-side join, no post-fetch filtering — `WHERE`, `ORDER BY`, and `LIMIT` are all pushed down to HANA in a single round-trip per question.

---

## Three-Stage Architecture

```
You: "Show me active loans for customers in the mining sector,
      with the borrower's name and loan amount"
```

### Stage 1: Question → JSON Descriptor

At startup, the server loads your full CDS model and builds a compact schema description — entity names, columns with types, labels, enums, `@Common.Text` references, and association paths. That schema text plus your question goes to a small LLM (Claude Haiku, GPT-4o-mini, or any configured provider). The LLM responds with a descriptor, not SQL:

```json
{
  "entity": "Loans",
  "select": ["LOAN_ID", "AMOUNT", "customer.BU_SORT1", "status.TEXT"],
  "where": [
    { "col": "customer.SECTOR_CODE", "op": "=", "val": "MINING" },
    { "col": "status.TEXT", "op": "like", "val": "Active" }
  ],
  "limit": 50
}
```

This is a cheap LLM call — a structured-output translation task, not a reasoning task. The model isn't answering your question; it's mapping it onto the schema vocabulary it was given.

### Stage 2: Descriptor → CQN → SQL (CDS Generates the JOINs, Not the LLM)

The server takes that descriptor and builds **one** CDS CQN query. `customer.BU_SORT1` and `status.TEXT` are CDS association paths — the server resolves them against the schema's join metadata and CDS compiles them into real SQL JOINs:

```sql
SELECT
  L.LOAN_ID,
  L.AMOUNT,
  BP.BU_SORT1   AS customer_BU_SORT1,
  LSC.TEXT      AS status_TEXT
FROM bankingsentinel_Loans L
INNER JOIN bankingsentinel_BusinessPartners BP  ON BP.PARTNER = L.PARTNER
LEFT  JOIN bankingsentinel_LoanStatusCodes  LSC ON LSC.CODE    = L.STATUS
WHERE UPPER(BP.SECTOR_CODE) = 'MINING'
  AND UPPER(LSC.TEXT) LIKE '%ACTIVE%'
LIMIT 50
```

The JOINs are real, generated by CDS from association metadata you already declared in your schema — not reconstructed from scratch by an LLM guessing at foreign keys.

### Stage 3: Results → Answer

The rows come back from `cds.run()` as plain objects. Your MCP client (Claude Code, Claude Desktop, etc.) renders them — or, as in the Banking Sentinel example later, hands them to a second, separate LLM call whose only job is to phrase the answer in plain English.

---

## Wait — Is That Safe?

Right question. The server only ever issues `SELECT` — there is no code path that builds an INSERT, UPDATE, or DELETE. Beyond that, there are three independent layers, all enforced server-side, none of them optional:

1. **Database-level**: point `MCP_DB_USER`/`MCP_DB_PASSWORD` at a dedicated read-only HANA user. If the framework had a bug, HANA itself would still reject a write.
2. **Entity allowlist** (`MCP_ALLOWED_ENTITIES`): restricts which entities are queryable at all. This is enforced on the entity you asked for **and** on every entity reached through an association path — so allowlisting `BCA_DTI` but not `BusinessPartners` blocks `customer.BU_SORT1` from being selected at all, closing the obvious bypass-via-JOIN hole.
3. **Column blocklist** (`MCP_BLOCKED_COLUMNS`): strips named columns (e.g. `PASSWORD`, `EMBEDDING`, `SSN`) before the query is even built — they're never sent to HANA, not fetched-then-redacted.

The one thing worth saying plainly, because the README says it plainly: **this bypasses your CAP service-layer `@requires`/`@restrict` annotations.** It queries `db/schema.cds` entities directly via `cds.run()`, not your OData service. If your service layer is where your authorization model lives, that model doesn't apply here — the three controls above are the substitute, not an addition.

For a quick demo, start with none of them and everything is queryable. For anything pointed at real data, set all three.

---

## The Real Lever: Schema Annotations, Not Prompt Engineering

Before the examples, this is the part that actually determines whether your queries come back right: **`@NLP.label`**.

The server already reuses your existing `@title` annotations automatically — if your schema already has Fiori value-help labels, the LLM gets those for free. `@NLP.label` exists for the cases where `@title` doesn't fit or isn't disambiguating enough, and it overrides `@title` when both are present.

Here's a real one from the schema you'll see in the examples below:

```cds
@title: 'Partner Type Code'
@NLP.label: 'Partner type code: 1=person, 2=organisation — NOT a name, never use for name lookups'
BU_TYPE : String(2);
```

Without that label, `BU_TYPE` is just a two-character string column to the LLM — and "type code" columns get mistaken for name columns constantly, because the LLM has no way to know what the values mean. The label isn't decoration; it's the only channel you have to tell the model what NOT to do with a column. The same mechanism handles join direction (`@NLP.joinType: 'LEFT'` when cardinality alone is ambiguous) and aliasing (`@NLP.alias`).

None of this touches your OData service or Fiori UI — `@NLP.label` is a CDS annotation the server reads at schema-load time and nothing else consumes.

---

## Configuration: 5 Minutes to Running

```bash
npm install @shahid.la/cds-db-nlquery-mcp
```

Create `.mcp.json` in your CAP project root:

```json
{
  "mcpServers": {
    "cds-db-nlquery-mcp": {
      "command": "npx",
      "args": ["-y", "@shahid.la/cds-db-nlquery-mcp"],
      "cwd": "/absolute/path/to/your/cap/project",
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "ANTHROPIC_MODEL": "claude-haiku-4-5-20251001"
      }
    }
  }
}
```

Open the project in an MCP-aware client and ask a question. `LLM_PROVIDER` auto-detects from whichever API key is set, so for a quick start you only need the key.

**Production env vars:**

| Variable | Default | Purpose |
|---|---|---|
| `MCP_ALLOWED_ENTITIES` | all entities | Comma-separated entity allowlist — enforced on JOINs too |
| `MCP_BLOCKED_COLUMNS` | none | Columns stripped before the query is built |
| `MCP_MAX_ROWS` | 500 | Hard SQL `LIMIT` cap, server-side |
| `MCP_DB_USER` / `MCP_DB_PASSWORD` | inherits app's DB user | Run as a separate, ideally read-only, HANA user |
| `MCP_MODEL_PATH` | `db` | Where your CDS model lives, if not the default `db/` |

**LLM providers**, today: Anthropic and OpenAI are first-class (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Everything else — Azure OpenAI, Groq, Ollama, local models — works through `OPENAI_BASE_URL` pointed at any OpenAI-compatible endpoint, not through a dedicated integration.

---

## Three Real Examples

These run against the actual schema and seed data of [Banking Sentinel](https://github.com/shahidla/Banking-Sentinel), a demo SAP CAP + HANA Cloud project I use to exercise this package against a real, non-trivial schema (18 entities, multi-hop associations, coded value-help tables). Every descriptor and result below reflects that real schema — nothing is invented for the post.

---

### Example 1 — Simple Filter Across One Association

**Question:** *"Which customers have a DTI ratio above 5?"*

**Schema (the relevant slice):**

```cds
entity BCA_DTI {
  key PARTNER : String(10);
  DTI_RATIO   : Decimal(5,2);

  customer : Association to BusinessPartners on customer.PARTNER = PARTNER;
}

@NLP.label: 'Customers and business partners — demo borrowers: 301xxxx, guarantors: 309xxxx'
entity BusinessPartners {
  key PARTNER : String(10);
  @title: 'Customer / Business Partner Name'
  BU_SORT1    : String(50);
}
```

**Descriptor the LLM returns:**

```json
{
  "entity": "BCA_DTI",
  "select": ["PARTNER", "DTI_RATIO", "customer.BU_SORT1"],
  "where": [{ "col": "DTI_RATIO", "op": ">", "val": 5 }],
  "orderBy": "DTI_RATIO",
  "orderDir": "DESC",
  "limit": 20
}
```

**Result, against the live database:**

```
Results: 3 rows

Partner    : 30100003
DTI Ratio  : 7.20
Customer   : Domestic Customer AU 3

Partner    : 30100001
DTI Ratio  : 5.80
Customer   : Domestic Customer AU 1

Partner    : 30100004
DTI Ratio  : 5.40
Customer   : Domestic Customer AU 4
```

> **[SCREENSHOT PLACEHOLDER 1 — Claude Code: the question, MCP tool call, and these three rows]**

One association (`customer`), one JOIN, one filter. This is the floor — every query, however complex, starts from this same mechanism.

---

### Example 2 — Coded Values via `@Common.Text` (Not Guessing the Raw Code)

**Question:** *"Show me active loans for customers in the mining sector, with the borrower's name and loan amount."*

This question has a trap: "active" and "mining sector" are both *human* terms over *coded* columns. `Loans.STATUS` is stored as a single character (`'A'`/`'C'`), not the word "active." If the LLM guessed at the raw code, it would be wrong as often as it was right.

**Schema:**

```cds
entity Loans {
  key LOAN_ID   : String(15);
  PARTNER       : String(10);
  AMOUNT        : Decimal(15,2);
  @Common.Text: status.TEXT
  STATUS        : String(1);

  customer : Association to BusinessPartners on customer.PARTNER = PARTNER;
  status   : Association to LoanStatusCodes  on status.CODE     = STATUS;
}

// Adding a new status is a data INSERT into this table — never a schema/code change.
entity LoanStatusCodes {
  key CODE : String(1);
  TEXT     : String(20);
}

entity BusinessPartners {
  key PARTNER  : String(10);
  BU_SORT1     : String(50);
  SECTOR_CODE  : String(20);   // RETAIL_PROP, MINING, AGRICULTURE, ...
}
```

`@Common.Text: status.TEXT` is the standard SAP value-help pattern — the same one Fiori uses to show "Active" in a dropdown while storing `'A'`. The schema reader tells the LLM this path exists; the system prompt instructs it to filter on `status.TEXT` directly rather than invent a raw code.

**Descriptor the LLM returns:**

```json
{
  "entity": "Loans",
  "select": ["LOAN_ID", "AMOUNT", "customer.BU_SORT1", "status.TEXT"],
  "where": [
    { "col": "customer.SECTOR_CODE", "op": "=", "val": "MINING" },
    { "col": "status.TEXT", "op": "like", "val": "Active" }
  ],
  "limit": 50
}
```

**Result:**

```
Results: 1 row

Loan ID    : L-009
Amount     : AUD 3,200,000.00
Customer   : Domestic Customer AU 9
Status     : Active
```

> **[SCREENSHOT PLACEHOLDER 2 — Claude Code: question, descriptor visible in MCP server logs, and this result]**

If the bank adds a new loan status next quarter (`PENDING_REVIEW = 'P'`), this query keeps working without a code change — it's matching on text, not a hardcoded code the LLM would otherwise have had to memorize.

---

### Example 3 — Column-to-Column Comparison Across Two Hops (`valCol`)

**Question:** *"Which loans are under-collateralized — where the pledged collateral is worth less than the loan amount?"*

This is qualitatively different from the first two: it's not comparing a column to a value the user typed, it's comparing **two columns from different entities** to each other. There's no literal to filter on.

**Schema:**

```cds
entity BCA_COLLATERAL {
  key LOAN_ID   : String(15);
  key COLLAT_ID : String(15);
  COLLAT_TYPE   : String(10);   // PROPERTY, VEHICLE, CASH
  VALUE         : Decimal(15,2);

  loan : Association to Loans on loan.LOAN_ID = LOAN_ID;
}

entity Loans {
  key LOAN_ID : String(15);
  AMOUNT      : Decimal(15,2);
  customer    : Association to BusinessPartners on customer.PARTNER = PARTNER;
}
```

The descriptor format supports `valCol` for exactly this — comparing a column to another column (a path, possibly through a JOIN) instead of to a literal `val`:

```json
{
  "entity": "BCA_COLLATERAL",
  "select": ["COLLAT_TYPE", "VALUE", "loan.LOAN_ID", "loan.PARTNER", "loan.customer.BU_SORT1", "loan.AMOUNT"],
  "where": [
    { "col": "VALUE", "op": "<", "valCol": "loan.AMOUNT" }
  ],
  "orderBy": "loan.LOAN_ID",
  "limit": 50
}
```

`loan.customer.BU_SORT1` is a two-hop path — `BCA_COLLATERAL → loan → Loans → customer → BusinessPartners` — resolved in the same single query, no extra round-trip. The generated `WHERE` clause is `WHERE COLLAT.VALUE < L.AMOUNT`, a real cross-table comparison, not two separate queries reconciled in JavaScript.

**Raw result: 10 rows.** Worth pausing on why it's 10 and not fewer — the comparison is **per pledged asset**, not per loan. A loan secured by both a property and a cash deposit produces two collateral rows, and each is compared to the *full* loan amount individually. That's the literal, correct answer to "which pledged assets are worth less than the loan" — it just means a multi-asset loan can appear more than once, even when its combined collateral would be adequate.

That's exactly where Stage 3 earns its place. The MCP server hands back those 10 flat rows; the second LLM call (the one that turns MCP results into an answer) grouped them by loan and computed the shortfall itself:

```
10 under-collateralized loan records identified (collateral value < loan amount):

Loan L-004 (Partner: 30100003, Domestic Customer AU 3)
Loan Amount: AUD 2,100,000.00
Total Collateral Value: AUD 1,480,000.00
Shortfall: AUD 620,000.00
Collateral Breakdown:
  Property: AUD 1,200,000.00
  Cash: AUD 280,000.00

Loan L-006 (Partner: 30100005, Domestic Customer AU 5)
Loan Amount: AUD 1,850,000.00
Total Collateral Value: AUD 1,300,000.00
Shortfall: AUD 550,000.00
Collateral Breakdown:
  Property: AUD 1,100,000.00
  Cash: AUD 200,000.00

Loan L-007 (Partner: 30100006, Domestic Customer AU 6)
Loan Amount: AUD 45,000.00
Total Collateral Value: AUD 35,000.00
Shortfall: AUD 10,000.00
Collateral Breakdown:
  Vehicle: AUD 35,000.00

Loan L-009 (Partner: 30100009, Domestic Customer AU 9)
Loan Amount: AUD 3,200,000.00
Total Collateral Value: AUD 2,400,000.00
Shortfall: AUD 800,000.00
Collateral Breakdown:
  Property: AUD 2,000,000.00
  Cash: AUD 400,000.00

[+ 2 more loans from the wider training portfolio, outside the named demo customers]
```

> **[SCREENSHOT PLACEHOLDER 3 — Claude Code: question, descriptor showing the `valCol` field and the 10 raw rows in the MCP server logs, plus this aggregated answer]**

This is the example I'd point a skeptical architect to first. Plenty of "NL to SQL" demos can do Example 1. Fewer can resolve a coded value-help table correctly. Almost none handle a column-to-column comparison across an association path, because that requires the framework — not the LLM — to actually understand JOIN semantics. And the per-asset-not-per-loan result is itself a useful, honest reminder of what the descriptor format can and can't express today: it has no `SUM`/`GROUP BY`, so "is this loan's *combined* collateral sufficient" is a question for the LLM answering over the raw rows, not something the query itself computes.

---

## Beyond Filters: Aggregation, Hierarchy, Nested Reads, Window Functions

The three examples above were already true in earlier versions. Since then the
descriptor format grew into a real query language — not by adding syntax for its
own sake, but because each addition maps to a CQL capability CAP already
supports and a real class of question:

- **Aggregation** — `"aggregate": [{"fn":"sum","col":"AMOUNT","as":"total"}]` +
  `"groupBy"` + `"having"` — "total order amount per customer," "customers with
  more than 5 loans."
- **Nested reads (`expand`)** — "show me each order with its line items nested
  inside" returns one parent row per order with a real nested array, not a
  flattened, duplicated-parent-row JOIN result.
- **Recursive hierarchy** — `"hierarchy": {"assoc":"children","direction":"descendants"}`
  walks an unbounded self-referencing tree (org charts, account hierarchies) level
  by level, capped by a configurable max depth — something a fixed-depth
  `a.b.c.COL` path genuinely cannot express.
- **Window functions** — `rank`, `row_number`, running totals, lag/lead, all with
  `partitionBy`/`orderBy` — "rank each order by amount within its customer,"
  "each customer's single largest order."
- **`CASE WHEN`, `UNION`/`INTERSECT`/`EXCEPT`, temporal `asOf` queries** — labeling
  rows by a computed condition, combining two different entities into one result
  set, and time-travel reads against `@cds.valid.from`/`@cds.valid.to` entities.

Same architectural promise as before: the LLM picks which of these to use and
fills in the JSON, CDS turns it into one real CQN query, the server never writes
SQL by hand.

---

## Built by Testing Against Real HANA, Not Just an In-Memory Database

Here's the part most "look what my MCP server can do" posts skip: a comprehensive
unit test suite (123 tests) passed the entire time these capabilities were
broken in a specific, real way. The tests used an in-memory SQLite-style adapter
that tolerates things real HANA doesn't. The only way to actually know whether
this worked was to deploy the demo schema to a real HANA Cloud instance and run
every query against it for real — so that's what I did, repeatedly, across one
extended session, and it caught real bugs:

- A real NL question — "show me each customer's single largest order" —
  surfaced that `expand`'s `orderBy`/`limit` (for "top N per group") wasn't
  implemented at all: the row cap applied, but nothing sorted first, so the
  result could silently be an arbitrary order instead of the actual largest
  one. Fixed by sorting before truncating. That fix, plus the existing
  enum-to-text translation and blocked-column stripping, all shared one
  unexamined assumption: each only ever checked `Array.isArray()` on a nested
  value. A follow-up systematic audit — deliberately constructing a two-level
  `expand` test, not a natural-language question this time — found all three
  silently skipped a nested value entirely whenever it was a plain object (a
  `to-one` association) instead of an array.
- A descriptor with an unrecognized field (an LLM wrote `{"notExists": "orders"}`
  as a sibling of `"where"` instead of inside it) was silently ignored rather
  than rejected — the query ran with no filter applied at all, returning every
  row instead of failing loudly.
- The legacy `@sap/hana-client`-based HANA runtime (still the default most
  CAP+HANA projects use) silently drops the `OVER` clause from a window-function
  query — no error, just wrong SQL, until HANA itself throws a syntax error
  downstream. Confirmed the CQN this package generates is *correct* per CAP's
  current standard (the same shape `@cap-js/sqlite` and the modern `@cap-js/hana`
  adapter both render properly) — only the legacy runtime mishandles it. The
  server now detects which adapter is connected and only restricts behavior on
  the legacy one; on a modern adapter, the same query just works.

Every one of these was found, root-caused, and fixed by actually deploying
`examples/capability-demo/`'s schema to live HANA and running real queries
against it — not by reading the code harder. The four scripts that do this
live in that folder in the GitHub repo (they're development/testing tools, not
part of the published npm package — `npm install` only gives you `src/`), ready
to run, not just described:

- `validate-deployment.js` — runs every example query directly against your
  deployment and checks the results, no LLM involved.
- `ask.js` — ask your own question against your deployment, end-to-end through
  a real LLM.
- `ask-batch.js` — runs every example question's *natural-language* text (not
  the hand-written descriptor) through a real LLM and checks the result. This is
  what actually separates "the package is wrong" from "the model picked an odd
  column" — and it surfaced real, fixable mistakes in both categories, across
  two different models (Claude and DeepSeek), not just one.
- `smoke-test-server.js` — the other three call this package's internal
  functions directly via `require()`. This one spawns `src/mcp-server.js` — the
  actual published artifact — as a real child process and drives it through the
  real MCP stdio protocol, the same way Claude Code or `npx` actually would.
  Used this to chase down what looked like a real bug (a hierarchy query
  silently falling back to a flat list, through this path specifically) — it
  turned out to be a false alarm caused by incomplete debug logging in the
  server itself, not an actual execution defect, but the only way to find that
  out for certain was testing the real protocol path, not assuming the
  internal-function tests covered it.

If you're evaluating this for something that matters, don't take the examples
above on faith — clone the repo, deploy `examples/capability-demo/` to your own
HANA, and run these scripts yourself.

---

## What Happens When the LLM Gets It Wrong

All three examples above are success cases — worth being honest about the failure path too. If the LLM's response doesn't parse as JSON, or comes back without an `entity` field, the server rejects it outright rather than guessing or silently running a degraded query. The same applies to an entity or column outside `MCP_ALLOWED_ENTITIES`, or one that doesn't exist in your schema at all — each produces a clear error back to the MCP client, not a best-effort result you'd have to double-check. There's no fallback path that quietly does something different from what you asked.

---

## What Else the Server Reads From Your CDS Model

Beyond `@title`/`@NLP.label` (covered above), several more things already in your schema do the rest of the work, none of them new annotations you'd have to add just for this:

- **Associations** — drive every JOIN; cardinality (`to-many` vs `to-one`) decides `LEFT` vs `INNER` automatically, and which `expand`/`hierarchy` shapes are even valid.
- **`@Common.Text` and `@Common.ValueList`** — the standard SAP value-help patterns, reused so the LLM filters on human text instead of guessing codes, whether it's a small fixed enum or a large lookup table.
- **Native CDS `enum`** — surfaced to the LLM as `name="value"` pairs, and translated back (`STATUS_text`) automatically in every result row — including inside nested `expand` results, recursively.
- **Calculated-on-read elements** (`FULL = FIRST || ' ' || LAST`) — selectable like any stored column; the server substitutes the underlying expression itself rather than assuming the database materialized it as a physical column (confirmed it doesn't, on HANA).
- **`@assert.range`** — surfaced as a sanity-bound hint, so the LLM can catch a likely unit/scale mismatch (a 0–1 ratio vs. a 0–100 percentage) before it emits a filter that trivially returns zero rows.
- **`@cds.search`** and **`@cds.valid.from`/`@cds.valid.to`** — free-text search columns and temporal entities, both read directly from annotations you'd already have for Fiori search bars and time-sliced data.

This is why it doesn't feel like a generic SQL wrapper bolted onto your project: it's reading the same metadata your CDS model already carries for OData, Fiori value-help, and UI labels — just pointed at a different consumer.

---

## When to Use This (and When Not To)

**Good fit:**
- Ad-hoc data exploration during development or support investigations
- Audit/compliance spot-checks — "show me all loans without collateral where LTV exceeds 80%"
- Operational questions that change shape every time, so a fixed report doesn't fit

**Not a fit:**
- Anything user-facing — this bypasses `@requires`/`@restrict`; use your OData service for that
- Scheduled/repeated reporting — this is exploratory, not a BI tool
- Any write path — read-only by design, no exceptions

---

## Try It

```bash
npm install @shahid.la/cds-db-nlquery-mcp
```

Add the `.mcp.json` block above, point it at a CAP project with a few `@NLP.label` annotations, and ask it something you'd otherwise have opened a SQL editor for. The first time a three-table JOIN with a coded value-help comes back correctly from a plain English question, you'll see why this is worth the five minutes of setup.

Want to verify all of this yourself before trusting it with something that matters, rather than trusting this post? Clone the repo, deploy `examples/capability-demo/`'s schema to your own database, and run `validate-deployment.js`, `ask.js`, `ask-batch.js`, and `smoke-test-server.js` — the same scripts that found and confirmed every fix described above.

Find the project on **[GitHub](https://github.com/shahidla/cds-db-nlquery-mcp)** and **[npm](https://www.npmjs.com/package/@shahid.la/cds-db-nlquery-mcp)**.

Feedback, issues, and PRs welcome — especially real-world schema patterns and annotation edge cases.
