# CDS Cookbook Gap Analysis & Extension Plan

> **Purpose of this document.** This package (`@shahid.la/cds-db-nlquery-mcp`) translates
> natural-language questions into CDS queries against a CAP project's `db/schema.cds` model.
> It currently covers a useful but partial slice of what SAP CAP's CDS modeling language
> (CDL) and query language (CQL) actually support. This document is a self-contained brief:
> it explains the relevant CDS concepts from the CAP Cookbook/capire docs, maps each one to
> this package's *current* behavior (with exact file/line references), and specifies a
> concrete, incremental extension for each gap — schema changes, code changes, prompt
> changes, and example questions the extension unlocks.
>
> **Audience.** Written so that another AI agent (or a developer) with no prior exposure to
> this conversation can pick any one section and implement it without needing additional
> research. Each section is independent — implement them in any order, or pick a subset.

---

## 0. Architecture recap (read this first)

Five files, ~700 lines total:

| File | Responsibility |
|---|---|
| `src/mcp-server.js` | MCP server entrypoint. Loads the CDS model at startup, registers two tools: `natural_language_query` and `list_entities`. |
| `src/schema-reader.js` | Walks `cds.model.definitions` and builds a flat `schema` object: `{ EntityName: { label, key, fqn, columns, joins } }`. Also renders `schema` into a compact text block (`buildSchemaPrompt`) that gets pasted into the LLM system prompt. |
| `src/llm-planner.js` | Sends the schema text + user question to an LLM (Anthropic or OpenAI-compatible). The LLM returns a **query descriptor** — a small JSON object (`entity`, `select`, `where`, `orderBy`, `limit`). |
| `src/query-executor.js` | Turns the descriptor into a single CQN query via `cds.run()`, with access control (entity allowlist, column blocklist, row cap) enforced before execution. |
| `src/config.js` | Environment-variable driven server config. |

**The core idea:** the LLM never sees or writes SQL. It writes a small JSON descriptor; the
descriptor vocabulary (what fields it can contain, what operators exist) **is** the feature
surface of this package. Every extension below follows the same shape: (1) CDS model
feature → (2) descriptor field → (3) executor logic that turns the field into CQN → (4)
planner prompt update teaching the LLM when/how to use the new field.

**Current descriptor format** (`src/llm-planner.js:14-22`):
```json
{
  "entity":   "<entity name from schema>",
  "select":   ["COL", "assocAlias.COL", ...] ,
  "where":    [{ "col": "COL or assocAlias.COL", "op": "...", "val": ... }],
  "orderBy":  "COL or assocAlias.COL",
  "orderDir": "ASC" | "DESC",
  "limit":    50
}
```
All `where` conditions are AND-ed (`src/query-executor.js:79-85`). There is no grouping, no
OR, no aggregation, no nesting, no recursion.

---

## 1. Aggregation & grouping (COUNT / SUM / AVG / MIN / MAX, GROUP BY)

### CDS/CQL background
CQL (CAP's query language) supports SQL-style aggregate functions and `GROUP BY` directly in
`SELECT`, e.g. `SELECT sector, count(*) as cnt, avg(DTI_RATIO) as avgDti FROM Customers GROUP
BY sector`. In `cds.ql` JS this is `SELECT.from('Customers').columns('sector', 'count(*) as
cnt').groupBy('sector')`. This is bread-and-butter CDS — almost every CAP analytics/reporting
use case relies on it.

### Current state
`query-executor.js:213-223` builds exactly one `SELECT.from(entityDef.fqn)` with a plain
column list — no aggregate functions, no `GROUP BY`/`HAVING`. The schema reader has no
concept of grouping. This means questions like:

- "How many loans does each customer have?"
- "What's the average DTI ratio per sector?"
- "Total overdue amount by status"

...currently cannot be answered. The LLM has no vocabulary to express them, so it either
fabricates a wrong flat query (returns raw rows, not aggregates) or fails.

### Extension

**1. Descriptor changes** — add two optional fields:
```json
{
  "entity":  "Loans",
  "select":  ["customer.BU_SORT1"],
  "aggregate": [{ "fn": "count", "col": "LOAN_ID", "as": "loan_count" }],
  "groupBy": ["customer.BU_SORT1"],
  "having":  [{ "fn": "count", "col": "LOAN_ID", "op": ">", "val": 5 }],
  "where":   [...],
  "limit":   50
}
```
`fn` ∈ `count | sum | avg | min | max`. `col` may be `*` only for `count`. `as` is the output
alias (default: `${fn}_${col}`).

**2. `src/query-executor.js` changes**
- Add a `buildAggregateCol({ fn, col, as })` helper producing a CQN function-call column:
  `{ func: fn, args: col === '*' ? [{val: 1}] : [colRef(col)], as }`. This is confirmed as the
  official CQN shape for function calls (per CAP's own CQN reference — a function-call node is
  literally `{func: String, args: expr[]}`), not a guess — no fallback to raw CQL string
  parsing is needed for this part.
- When `descriptor.aggregate` is present, append these to the `cols` array built at
  `query-executor.js:178-209` instead of (or alongside) plain columns.
- When `descriptor.groupBy` is present, call `q.groupBy(...descriptor.groupBy.map(colRef))`.
  `groupBy`/`having`/`distinct` are documented first-class `SELECT` clauses in both CQN and the
  `cds.ql` fluent builder (`.groupBy(...)`, `.having(...)`), so this is a direct, sanctioned
  builder call, not an undocumented corner.
- When `descriptor.having` is present, build a CQN HAVING expression analogous to
  `buildWhereExpr` (reuse the same operator switch, just attach via `q.having(...)` instead
  of `q.where(...)`).
- Apply the same allowlist/blocklist checks to columns referenced inside `aggregate`,
  `groupBy`, and `having` — extend the `allPaths` collection at `query-executor.js:144-148` to
  include them, so the entity-allowlist bypass protection (joined-entity check) still holds.

**3. `src/schema-reader.js` changes** — none required; aggregates operate on existing
columns. Optionally surface in `buildSchemaPrompt` a one-line note that numeric/decimal
columns support `sum`/`avg`/`min`/`max` and any column supports `count`.

**4. `src/llm-planner.js` prompt changes** — add to `SYSTEM_PROMPT`:
```
AGGREGATION:
  - Use "aggregate": [{ "fn": "count"|"sum"|"avg"|"min"|"max", "col": "COLUMN or assocAlias.COLUMN or *", "as": "alias" }]
    when the question asks "how many", "total", "average", "highest", "lowest", or similar.
  - Use "groupBy": ["COLUMN", ...] to group results — required whenever "select" or
    "aggregate" mixes a non-aggregated column with an aggregate (same rule as SQL GROUP BY).
  - Use "having" (same shape as "where" but referencing an aggregate via {"fn","col","op","val"})
    to filter on the aggregated value itself, e.g. "customers with more than 5 loans".
  - Do NOT use groupBy/aggregate for simple row-listing questions — only when the question
    asks for a computed summary across multiple rows.
```

### Worked example
*"How many loans does each customer have, sorted highest first?"*
```json
{
  "entity": "Loans",
  "select": ["customer.PARTNER", "customer.BU_SORT1"],
  "aggregate": [{ "fn": "count", "col": "LOAN_ID", "as": "loan_count" }],
  "groupBy": ["customer.PARTNER", "customer.BU_SORT1"],
  "orderBy": "loan_count",
  "orderDir": "DESC",
  "limit": 50
}
```

---

## 2. Boolean grouping in WHERE (OR, nested AND/OR)

### CDS/CQL background
CQL `where` clauses are full boolean expression trees — `(a = 1 OR a = 2) AND b > 5` is
normal CQL. CAP's CQN represents this as nested arrays: `[[a, '=', 1], 'or', [a, '=', 2]]`
wrapped in parens, ANDed with the rest.

### Current state
`buildWhereExpr` (`query-executor.js:46-86`) only ANDs a flat list of conditions — there is
no way to express OR at all. The planner prompt doesn't mention OR. Any question like:

- "Loans with status Active or Pending"
- "Customers in MINING or AGRICULTURE sector"
- "Loans where DTI > 5 OR DTI is missing"

...gets silently mis-translated (the LLM either picks one branch, fabricates an `IN`-like
single condition, or ignores half the question).

### Extension

**1. Descriptor changes** — allow `where` items to be either a flat leaf condition (current
shape, unchanged for backward compatibility) **or** a group node:
```json
{
  "where": [
    { "any": [
        { "col": "STATUS", "op": "=", "val": "A" },
        { "col": "STATUS", "op": "=", "val": "P" }
      ]
    },
    { "col": "customer.BU_SORT1", "op": "like", "val": "mining" }
  ]
}
```
`any` = OR-group, `all` = explicit AND-group (useful for `(a OR b) AND (c OR d)` shapes).
Groups can nest. Top-level array remains implicitly AND-ed, same as today.

**2. `src/query-executor.js` changes** — refactor `buildWhereExpr` into a recursive function:
```js
function buildCondExpr(node) {
  if (node.any) return wrapParens(joinWith('or', node.any.map(buildCondExpr)));
  if (node.all) return wrapParens(joinWith('and', node.all.map(buildCondExpr)));
  return buildLeafExpr(node); // existing per-op switch, extracted unchanged
}
```
`wrapParens` should emit CQN's parenthesization — in `cds.ql`, a sub-array group needs to be
nested as a single array element, e.g. `[ [...orParts], 'and', [...rest] ]`; check the exact
CQN shape against the installed `@sap/cds` (use `cds.parse.expr('(a=1 or a=2)')` in a scratch
script to see the canonical AST and mirror it).
Update `allPaths` collection (`query-executor.js:144-148`) to recurse into `any`/`all` groups
when gathering columns for the allowlist check — a naive `.flatMap` over top-level `where`
will miss columns hidden inside a group, silently under-enforcing `MCP_ALLOWED_ENTITIES`.

**3. `src/llm-planner.js` prompt changes**:
```
GROUPING:
  - Plain "where" array items are AND-ed together (unchanged).
  - To express OR, wrap alternatives in {"any": [cond, cond, ...]}.
  - To express an explicit AND group (e.g. inside an OR), use {"all": [...]}.
  - Example — "status Active or Pending, AND sector Mining":
    "where": [
      {"any": [{"col":"STATUS","op":"=","val":"A"}, {"col":"STATUS","op":"=","val":"P"}]},
      {"col": "customer.sector", "op": "=", "val": "MINING"}
    ]
```

---

## 3. EXISTS / ANY predicate on to-many associations

### CDS/CQL background
CDS path expressions through a to-many association inside a `where` clause use an existential
quantifier implicitly when written as an infix filter: `Customers[exists payments[STATUS=
'OPEN']]` or in CQL: `SELECT from Customers where exists payments[DAYS_OVERDUE > 30]`. This
is the standard CAP idiom for "parent rows that have at least one matching child row" —
fundamentally different from a flat join, because a flat join on a to-many association
duplicates the parent row once per matching child (fan-out), whereas `exists` returns the
parent exactly once.

### Current state
This package only does flat joins (`query-executor.js:211-217`, association paths resolved
via `colRef` → CDS auto-JOIN). There is no `exists` support. Consequently:

- "Which customers have at least one overdue payment?" — today, if attempted via a flat
  join + where on `payments.DAYS_OVERDUE > 30`, it technically *works* for filtering, but the
  customer row will appear **once per matching payment**, not once. Asking "how many
  customers have an overdue payment" on top of that would double-count badly.
- "Customers with no open loans" (anti-join / NOT EXISTS) cannot be expressed at all today —
  a flat join can't represent absence.

### Extension

**1. Descriptor changes** — new condition shape using `exists`/`notExists` instead of `col`:
```json
{ "exists": "payments", "where": [{ "col": "DAYS_OVERDUE", "op": ">", "val": 30 }] }
{ "notExists": "loans", "where": [{ "col": "STATUS", "op": "=", "val": "A" }] }
```
The `where` inside an `exists` node is scoped to the *target* entity of the association (so
its `col` values are plain columns of the joined entity, not prefixed with the alias).
Nested `exists` (association chains) supported by allowing `exists` to itself be a dotted
path: `"exists": "customer.payments"`.

**2. `src/query-executor.js` changes**
- `EXISTS` over an association's infix filter is a **native, first-class CQL/CQN construct** —
  confirmed directly from CAP's own CQL reference: `WHERE EXISTS books[year = 2000]` is plain,
  sanctioned CQL, and the compiler unfolds a path with several associations into nested
  `EXISTS` predicates automatically. This is simpler than originally assumed — no hand-rolled
  correlated subquery, no manual `$outer` reference is needed. Build it via the association's
  infix-filter path directly:
  ```js
  // CQN: { xpr: ['exists', { ref: [alias], where: [...] }] } — or, if the installed cds.ql
  // exposes a fluent equivalent (e.g. `exists books.where(...)` / infix-filter path refs),
  // prefer that over hand-built CQN. Resolve `alias` via entityDef.joins exactly as colRef()
  // does for ordinary path refs, and build the inner `where` with the existing recursive
  // condition builder from §2, scoped so its column names are NOT alias-prefixed (they're
  // already relative to the joined entity, the way a real infix filter works).
  ```
  For `notExists`, wrap the same construct with `not exists` instead of `exists`.
- **Known CQL limitation to carry forward into this implementation**: "paths inside the
  filter are not yet supported" — i.e. the infix filter inside `exists`/`notExists` can only
  reference the *joined* entity's own direct columns, not a further association path off of
  it (e.g. `exists payments[loan.STATUS='A']` is not valid CQL today). The descriptor's
  `where` inside an `exists` node must therefore be restricted to plain columns of the
  immediate target entity — reject (with a clear planner-facing error) any `col` inside an
  `exists`/`notExists` node that itself contains a `.`, rather than silently sending an invalid
  query to the DB.
- Extend the entity-allowlist walk (`collectJoinedEntities`, `query-executor.js:23-37`) to
  also descend into `exists`/`notExists` association targets — otherwise a disallowed entity
  is readable indirectly via an `exists` filter even though it's blocked for direct/select use.

**3. `src/llm-planner.js` prompt changes**:
```
EXISTENCE FILTERS (to-many associations):
  - To filter parent rows by "has at least one related row matching X", use:
    {"exists": "assocAlias", "where": [{"col": "COL", "op": "...", "val": ...}]}
    NOT a flat join — a flat join on a to-many association duplicates the parent row once
    per matching child, which is wrong for "which customers have..." style questions.
  - To filter for "has NO related row matching X" (e.g. "loans with no open payments"), use
    "notExists" instead of "exists", same shape.
  - Use a plain "assocAlias.COL" path in select/where only when you want to pull a SINGLE
    related value alongside the parent row (to-one association, or to-many where row
    duplication is acceptable/expected by the question, e.g. "list each payment with its
    loan's amount").
```

### Worked example
*"Which customers have a loan that's more than 90 days overdue?"*
```json
{
  "entity": "Customers",
  "select": ["PARTNER", "BU_SORT1"],
  "where": [{ "exists": "loans", "where": [{ "col": "DAYS_OVERDUE", "op": ">", "val": 90 }] }],
  "limit": 50
}
```

---

## 4. Recursive parent-child / grandchild hierarchies

### CDS/CQL background
CAP models hierarchies (org charts, account trees, BOMs, category trees) as a
**self-referencing association** — an entity with an association to itself, typically via a
`parent`/`up_` foreign key:
```cds
entity Accounts {
  key ID : UUID;
  name   : String;
  parent : Association to Accounts;
  children : Association to many Accounts on children.parent = $self;
}
```
Flat join path expressions (`parent.name`, `parent.parent.name`) only reach a **fixed,
hard-coded number of hops** — fine for "show the parent" or "show the grandparent", but not
for "show all descendants" or "show the full ancestor chain" at arbitrary depth.

**Confirmed native support exists** (this changes the recommended implementation path below).
CAP has built-in **Recursive Hierarchies** support, declared on the entity (or via `annotate`)
with the standard OData/Fiori `@Aggregation.RecursiveHierarchy` annotation:
```cds
annotate Accounts with @Aggregation.RecursiveHierarchy #AccountTree: {
  NodeProperty:               ID,      // the node's own key
  ParentNavigationProperty:   parent   // association pointing to the parent node
};
```
CAP Node.js (consolidated with CAP Java's existing support) serves this for OData v4 — the
Fiori Tree Table pattern — including sort/filter/search on hierarchical data, **on SAP HANA
Cloud, SQLite, and PostgreSQL**. This is a materially stronger starting point than assuming
"raw SQL on every backend": where the annotation is declared, the runtime already knows how to
expand/collapse the tree without this package writing any traversal SQL itself.

### Current state
`schema-reader.js:88-101` treats a self-referencing association exactly like any other
association — it becomes one entry in `joins`. The LLM can write `parent.parent.name`
manually for a *fixed* depth, but:
- There's no way to ask for "all descendants" / "all ancestors" / "the full chain" without
  knowing the depth in advance.
- Nothing in the schema prompt tells the LLM "this association is a self-reference — it's a
  hierarchy, not a one-off lookup."
- Genuinely recursive questions ("show every business unit under Region X, including
  sub-sub-units") are unanswerable today.

### Extension

**1. `schema-reader.js` changes** — two independent signals, read both:
- First, check for the entity-level `@Aggregation.RecursiveHierarchy` annotation (it may
  appear directly on the entity or via a separate `annotate Entity with @Aggregation.
  RecursiveHierarchy #Qualifier: {...}` elsewhere in the model — `cds.linked()` merges
  `annotate` extensions onto the definition, so reading `def['@Aggregation.
  RecursiveHierarchy']` off the linked entity should see it either way). If present, record
  its `NodeProperty`/`ParentNavigationProperty` as `entityDef.nativeHierarchy = { nodeProp,
  parentNav }` — this is the strong signal: the runtime has a declared, supported hierarchy.
- Second, regardless of the annotation, detect self-referencing associations (where
  `col.target` resolves to the same entity as `def` itself, i.e. `targetKey === entityKey`) and
  tag them in the `joins` metadata — this is the weaker signal (a self-reference *could* be a
  hierarchy even without the formal annotation):
```js
joins[alias] = { entity: targetKey, from: keys.from, to: keys.to, type: joinType,
                 recursive: targetKey === entityKey };
```
Surface this in `buildSchemaPrompt` (`schema-reader.js:171-173`) as e.g.
`"parent"→Accounts(ID=PARENT_ID,INNER){self-referencing — hierarchy}`.

**2. Descriptor changes** — add a `hierarchy` query mode as an alternative to flat
select/where, for when the question is inherently about traversal depth rather than a fixed
join:
```json
{
  "entity": "Accounts",
  "hierarchy": { "assoc": "children", "direction": "descendants", "startWhere": [{ "col": "ID", "op": "=", "val": "ACC-100" }], "maxDepth": null },
  "select": ["ID", "name"],
  "limit": 200
}
```
`direction` ∈ `descendants | ancestors`. `startWhere` identifies the root row(s) to start
from. `maxDepth: null` = unbounded (capped server-side, see below).

**3. `src/query-executor.js` changes** — prefer the native path first, raw SQL only as fallback:
- **Preferred path — native `@Aggregation.RecursiveHierarchy`**: if the target entity (or an
  `annotate` extension of it, check both) carries this annotation, `schema-reader.js` should
  surface it (see step 1 above) and the executor should drive CAP's own hierarchy query
  support rather than hand-writing traversal SQL — verify the exact `cds.ql`/CQN surface for
  this against the installed `@sap/cds` version (it is exposed via OData's
  `$apply=ancestors()/descendants()` at the protocol layer; confirm what, if anything, is
  exposed as a plain `cds.ql` builder call or CQN shape for direct `cds.run()` use without
  going through an OData request — this is the one piece that still needs hands-on
  verification against the installed version, since the annotation's existence is confirmed
  but the exact non-OData JS entry point wasn't independently confirmed during this research
  pass). This works uniformly across SAP HANA Cloud, SQLite, and PostgreSQL per the same
  annotation — no backend-specific branching needed if this path is available.
- **Fallback — no `@Aggregation.RecursiveHierarchy` annotation present on the entity**: the
  consumer's schema doesn't declare the entity as a formal hierarchy, but the question still
  implies unbounded traversal over a plain self-referencing association. Two backend-specific
  raw-SQL paths, same as originally planned:
  - **SAP HANA**: HANA's `HIERARCHY_DESCENDANTS(SOURCE(...), START WHERE ...)` /
    `HIERARCHY_ANCESTORS(...)` table functions, via `cds.run(cds.parse.cql(...))` or a raw
    parameterized SQL string if the CQL parser doesn't model table functions.
  - **SQLite (dev)**: SQLite supports `WITH RECURSIVE` CTEs. Since `cds.run()` doesn't expose
  CTEs through the query builder, drop to a raw parameterized SQL string specifically for
  this code path, guarded behind a capability check (`cds.db.kind === 'sqlite'`), e.g.:
  ```sql
  WITH RECURSIVE tree AS (
    SELECT * FROM Accounts WHERE <startWhere>
    UNION ALL
    SELECT a.* FROM Accounts a JOIN tree t ON a.PARENT_ID = t.ID
  )
  SELECT * FROM tree LIMIT :maxRows
  ```
  **Security note**: because this is raw SQL, every identifier (table/column names) must come
  only from the already-validated `schema` object (never directly from the LLM's free-form
  strings) — interpolate column/table names from `entityDef.fqn`/`entityDef.columns` lookups,
  and pass `startWhere` values as bound parameters, never string-concatenated, to avoid SQL
  injection through a crafted natural-language question.
- Enforce a hard `MCP_MAX_HIERARCHY_DEPTH` (new config var, default e.g. 20) regardless of
  `maxDepth` requested, to bound worst-case traversal cost on large/cyclic data.

**4. `src/config.js` changes** — add `maxHierarchyDepth: parseInt(process.env.MCP_MAX_HIERARCHY_DEPTH || '20', 10)`.

**5. `src/llm-planner.js` prompt changes**:
```
HIERARCHIES:
  - Associations marked "self-referencing — hierarchy" in the schema represent a
    parent/child tree (org charts, account trees, category trees, BOMs).
  - For a FIXED number of hops ("show the parent's name"), use a normal path:
    "select": ["parent.name"].
  - For an UNBOUNDED traversal ("all descendants", "everything under X", "the full
    ancestor chain"), use:
    {"entity": "...", "hierarchy": {"assoc": "<self-ref alias>", "direction": "descendants"|"ancestors", "startWhere": [...]}, "select": [...]}
    Do NOT try to fake unbounded depth by chaining "parent.parent.parent...".
```

### Worked example
*"List every account under Region-North, however deep."*
```json
{
  "entity": "Accounts",
  "hierarchy": { "assoc": "children", "direction": "descendants",
                 "startWhere": [{ "col": "name", "op": "=", "val": "Region-North" }] },
  "select": ["ID", "name"],
  "limit": 500
}
```

---

## 5. Deep/nested (expand-style) output for compositions — fixing join fan-out

### CDS/CQL background
CAP distinguishes **associations** (peer relationship, e.g. Loan ↔ Customer) from
**compositions** (containment, e.g. Order *has* OrderItems — the child cannot exist without
the parent and is deleted with it). For compositions, CAP's idiomatic read pattern is a
**deep read / expand**: `SELECT from Orders { ID, status, items { ID, product, qty } }`,
which CAP/the DB driver executes as the join but **returns nested JSON** (`{ ID, status,
items: [ {...}, {...} ] }`) — one parent object with an array of children, not N duplicated
flat rows.

### Current state
`schema-reader.js:89` treats `col.isComposition` identically to `col.isAssociation` — both
just become a `joins` entry used for dotted-path flattening. `query-executor.js` always
produces a flat row set (`cds.run(q)` with plain column refs) — there is no expand/nested
output anywhere. For a to-many composition, asking *"show me each order with its line
items"* today either (a) is impossible to express cleanly in the flat descriptor, or (b) if
attempted via a flat join, returns one row **per item**, with the parent's columns repeated —
technically correct data, but a poor/confusing shape for "list orders with their items"
questions, and actively wrong if the parent-level data is then used in any per-parent
aggregation by the calling LLM.

### Extension

**1. Descriptor changes** — add an `expand` field, used specifically for to-many
associations/compositions, that nests results instead of flattening them:
```json
{
  "entity": "Orders",
  "select": ["ID", "status"],
  "expand": [{ "assoc": "items", "select": ["ID", "product", "qty"], "where": [...], "limit": 20 }],
  "limit": 50
}
```
`expand` entries can themselves contain a nested `expand` (grandchildren), mirroring CAP's
own nested-expand syntax — **with one confirmed limitation to carry into this implementation**:
CAP's own CQL docs flag "nested expands following to-many associations" as currently
unsupported. Concretely: `items { ID, parts { ID } }` where both `items` and `parts` are
to-many is the unsupported shape; `items { ID, product { name } }` (to-many → to-one) is fine.
The executor (and the planner prompt) must therefore reject/flatten a nested `expand` whose
*parent* expand level is already a to-many association — validate this against
`entityDef.joins[alias].type`/cardinality before building the query, and surface a clear
planner-facing error rather than sending CAP a query it will reject at a less obvious point.

**2. `src/query-executor.js` changes** — build the CQN using `cds.ql`'s native expand
syntax rather than path-flattening:
```js
q.columns(...plainCols, alias => alias[joinAlias](sub => sub.columns(...childCols).where(...).limit(n)));
```
(the exact builder call is `SELECT.from(entityDef.fqn).columns(c => { c.ID; c.status;
c.items(i => { i.ID; i.product; i.qty }) })` in `cds.ql` — confirm against the installed
`@sap/cds` version). `cds.run()` of an expand query already returns nested JSON natively —
no manual post-processing needed for the nesting itself.
- Apply column blocklist/allowlist filtering recursively into each `expand` level (reuse the
  existing per-column filter logic at `query-executor.js:178-209`, applied once per nesting
  level).
- Apply a max-expand-rows cap per nested level (reuse/extend `MCP_MAX_ROWS`, or add a
  dedicated `MCP_MAX_EXPAND_ROWS` so a parent page of 50 doesn't accidentally allow 50×500
  child rows).

**3. `src/llm-planner.js` prompt changes**:
```
NESTED / DEEP READS (compositions, to-many):
  - When the question asks to see a parent ENTITY TOGETHER WITH A LIST of its child rows
    (e.g. "orders with their line items", "loans with their payment history"), use "expand"
    instead of a flat join path — this returns one parent object per row with a nested
    array, instead of duplicating the parent row once per child:
    {"entity": "Orders", "select": ["ID","status"], "expand": [{"assoc":"items","select":["product","qty"]}]}
  - Use a flat "assocAlias.COL" path instead when you only need ONE scalar value pulled
    from a to-one association (e.g. "loan's customer name") or when you genuinely want one
    flat row per child (e.g. "list every payment along with its loan amount").
```

### Worked example
*"Show me open orders together with their line items."*
```json
{
  "entity": "Orders",
  "where": [{ "col": "status", "op": "=", "val": "OPEN" }],
  "select": ["ID", "status"],
  "expand": [{ "assoc": "items", "select": ["product", "qty"] }],
  "limit": 50
}
```

---

## 6. Virtual & calculated elements

### CDS/CQL background
CDS supports two kinds of "not a plain stored column" elements:
- **`virtual`** elements — declared in the model but never persisted or selected from the DB;
  populated by custom handler code at runtime. Not safe to `SELECT` directly via `cds.run()`.
- **Calculated elements** — `colName = ( expression )`, either `calculated on read`
  (computed by the DB in every query, like a generated SQL column) or `calculated on write`
  (computed once and persisted). E.g. `fullName = (firstName || ' ' || lastName)`.

### Current state
`schema-reader.js:102` explicitly **skips** virtual columns (`col.type && !col.virtual`).
Calculated-on-read elements are *not* explicitly filtered — depending on how `@sap/cds`
surfaces them in `cds.linked()` output, they may or may not currently appear with a `type`
and pass through; this needs verification, but there is no special handling either way. The
practical effect: any business-meaningful derived field your schema defines this way (full
name, computed ratios, status flags) is either invisible to the LLM or selected without the
LLM knowing it's a derived expression rather than a stored value (mostly harmless for
`calculated on read`, but worth being explicit about).

### Extension

**1. `src/schema-reader.js` changes**
- For `calculated on read` elements (check `col.value` / the CDS compiler's calculated-element
  marker — inspect `cds.linked()` output for the exact property, likely `col.value` holding
  the expression AST), include them in `columns` with a marker:
  ```js
  if (col.value) meta.calculated = true; // selectable, computed by the DB on every read
  ```
  These are safe to `SELECT` — CDS/the DB computes them — so just tag them for transparency
  in the schema prompt (`"DTI_RATIO_CALC:Decimal[calculated]"`), which also helps the LLM
  understand why a field might not accept being used on the left side of certain filters
  efficiently (some DBs can't index a computed expression).
- For genuinely `virtual` elements, keep skipping them from `columns` (current behavior is
  correct — they cannot be read via `cds.run()`), but optionally log at startup
  (`process.stderr.write`) which virtual fields were skipped per entity, so a developer
  extending the schema with `@NLP.label` knows why a field they expected isn't queryable.

**2. No `query-executor.js` change needed** — calculated-on-read columns are just normal
`colRef()` selections once exposed; the DB handles the computation.

**3. `src/llm-planner.js` prompt changes** — minimal: schema text already shows
`[calculated]` tag from above; optionally add one line:
```
Columns tagged [calculated] are computed by the database on every query — select them like
any other column; you cannot use them as the target of a write (not relevant — this server
is read-only anyway).
```

---

## 7. `@Common.ValueList` (in addition to the already-supported `@Common.Text`)

### CDS/CQL background
`@Common.Text` (already supported by this package) is for simple 1:1 code→text lookups via
an association. `@Common.ValueList` is the broader OData/Fiori "value help" annotation —
points to a (possibly external, possibly parameterized) value-list entity, optionally with
multiple display/filter columns and additional filter parameters. The `Parameters` array's
entries use confirmed concrete `$Type` names — `ValueListParameterInOut` (the field maps both
ways: it both filters the value-list lookup by the current row's value and writes the chosen
value back) and `ValueListParameterDisplayOnly` (a value-list column shown for context but not
mapped back to any field on the current entity, e.g. a longer description column). It's used
for richer dropdown/search-help scenarios than a flat text lookup, e.g. a value list with both
a code and a longer description plus a category filter.

### Current state
`schema-reader.js:124-127` only reads `col['@Common.Text']`. `@Common.ValueList` is not read
at all — any coded column using only `@Common.ValueList` (no `@Common.Text`) is invisible to
the NLQ planner as a "this code has a human-readable counterpart" hint, even though
semantically it's the same kind of problem this package already solves for `@Common.Text`.

### Extension

**1. `src/schema-reader.js` changes** — read `col['@Common.ValueList']`, specifically its
`CollectionPath` (target entity) and the `Parameters` array's `ValueListProperty` fields, and
where a simple case can be detected (a `ValueListParameterDisplayOnly` entry — a column shown
for context but not round-tripped back to the current row — mapping to a label field on the
value-list entity, and that entity is reachable via an existing association), surface it the
same way as `textVia`:
```js
const valueList = col['@Common.ValueList'];
if (valueList?.CollectionPath && !meta.textVia) {
  const labelParam = (valueList.Parameters || [])
    .find(p => p.$Type === 'Common.ValueListParameterDisplayOnly');
  if (labelParam) meta.valueListVia = `${assocAliasForCollectionPath}.${labelParam.ValueListProperty}`;
}
```
(A `ValueListParameterInOut` entry is the round-trip filter/key column, not a display label —
don't use it as the text source.)
This requires resolving `CollectionPath` (an entity FQN/name) back to an existing association
alias on the current entity — if no direct association exists to that entity, this
annotation can't be turned into a join path and should be skipped (log it, don't crash).

**2. No `query-executor.js`/`llm-planner.js` structural change** — once `meta.valueListVia` is
populated, it flows through the exact same `buildSchemaPrompt` rendering and prompt rule #8
already written for `textVia` (`schema-reader.js:165-167`, `llm-planner.js:56`) — reuse,
don't duplicate. Just generalize prompt rule #8 to mention "readable text available via X"
without caring whether it came from `@Common.Text` or `@Common.ValueList`.

---

## 8. `@Semantics` annotations for currency/unit-aware presentation

### CDS/CQL background
CAP recognizes semantic annotations that pair an amount/quantity column with the column
holding its currency/unit code:
```cds
amount   : Decimal @Semantics.amount.currencyCode: 'currency_code';
currency_code : String(3) @Semantics.currencyCode;
```
This tells UIs (and could tell an LLM) "these two columns are a pair — don't show 1500
without showing USD next to it."

### Current state
Not read anywhere in `schema-reader.js`. The LLM has no signal that `AMOUNT` and `CURRENCY`
are linked, so it might select one without the other, or the final answer (formatted by the
calling LLM client, per the `instructions` block in `mcp-server.js:245-250`) might present a
bare number.

### Extension

**1. `src/schema-reader.js` changes** — detect `@Semantics.amount.currencyCode` /
`@Semantics.quantity.unitOfMeasure` on a column, and record the paired column name:
```js
const pairCol = col['@Semantics.amount.currencyCode'] || col['@Semantics.quantity.unitOfMeasure'];
if (pairCol) meta.pairedWith = pairCol;
```
Render in the schema prompt: `AMOUNT:Decimal{pairs with CURRENCY — always select both together}`.

**2. `src/llm-planner.js` prompt changes**:
```
AMOUNT/QUANTITY COLUMNS:
  - If a column's schema entry says "pairs with X", and you select that column, also select
    X in the same query (so the LLM presenting results can show "1,500 USD" instead of a
    bare number). This applies even if the question didn't explicitly mention currency/unit.
```

**3. No `query-executor.js` change** — purely a prompt-level nudge plus a tiny schema-reader
addition; the executor already handles arbitrary column selections.

---

## 9. Free-text search via `@cds.search`

### CDS/CQL background
CDS lets an entity declare which columns participate in CAP's built-in `search` query option:
```cds
entity Customers @(cds.search: { BU_SORT1, NOTES }) { ... }
```
CQL then supports `SELECT from Customers where search('mining')` — a single full-text-ish
predicate across the declared columns (compiled by CAP into an OR-of-LIKE, or a native
full-text predicate on DBs that support it), without the caller needing to know exactly which
column the term lives in.

### Current state
Not read by `schema-reader.js`. Every "find anything containing X" question today must be
translated by the LLM into an explicit `like` condition on a column it has to guess — which
fails when the matching term could plausibly be in any of several columns (e.g. "find
anything mentioning Acme" — is "Acme" in the customer name, the notes field, the address?).

### Extension

**1. `src/schema-reader.js` changes** — read the entity-level `@cds.search` annotation,
collect the listed column names, store as `searchableColumns` on the entity descriptor:
```js
const searchAnno = def['@cds.search'];
if (searchAnno) entityDef.searchableColumns = Object.keys(searchAnno).filter(k => searchAnno[k] !== false);
```
Render in schema prompt: `Customers [...] searchable: BU_SORT1, NOTES`.

**2. Descriptor changes** — new top-level field:
```json
{ "entity": "Customers", "search": "acme", "select": [...] }
```

**3. `src/query-executor.js` changes** — when `descriptor.search` is present and the
entity has `searchableColumns`, build an OR-of-`upper(...) like` group across those columns
(reuse the case-insensitive `like` logic at `query-executor.js:68-71`), AND-ed with any other
`where` conditions. If the entity has no declared `searchableColumns`, return a clear
planning-time error rather than silently searching nothing, or fall back to all `String`-typed
columns with a startup-config opt-in (`MCP_SEARCH_FALLBACK_ALL_STRING_COLUMNS=true`) — default
off, since searching every string column by default could be surprising/slow.

**4. `src/llm-planner.js` prompt changes**:
```
FREE-TEXT SEARCH:
  - If an entity lists "searchable: COL1, COL2, ..." and the question is a vague/unscoped
    "find anything about X" rather than a specific column match, use:
    {"entity": "...", "search": "X", ...}
    instead of guessing one column for a "like" filter.
```

---

## 10. Sanity bounds via `@assert.range` (reduce hallucinated filters)

### CDS/CQL background
`@assert.range: [min, max]` (or an enum-like list) on a column is normally an *input
validation* annotation, enforced by CAP on writes. This package is read-only, so it can't
"enforce" anything on writes — but the annotation is still useful metadata: it tells you the
valid domain of a column.

### Current state
Not read. Nothing stops the LLM from generating an obviously-out-of-range filter (e.g. `DTI
> 500` when DTI is realistically `0–50`) — which isn't a crash, just a query that will
trivially return zero rows, often confusing the end user into thinking the *data* is missing
rather than the *filter* being unreasonable.

### Extension

**1. `src/schema-reader.js` changes** — read `col['@assert.range']`, surface as a hint:
```js
if (col['@assert.range']) meta.range = col['@assert.range']; // [min, max]
```
Render: `DTI_RATIO:Decimal[0..50]`.

**2. `src/llm-planner.js` prompt changes**:
```
RANGE HINTS:
  - A column shown as "COL:Type[min..max]" has a known valid domain. If the question implies
    a filter value outside that range, it's more likely the question used a different unit/
    scale than that the data is wrong — double check the column choice and value before
    emitting the filter (e.g. a percentage 0-1 vs 0-100 mismatch).
```
This is advisory only — no executor change required. It's a low-cost, high-value nudge that
reduces a real class of LLM mistakes (unit/scale confusion) without adding any new descriptor
fields.

---

## 11. Pagination (`offset`) for browsing beyond `limit`

### CDS/CQL background
CQL supports `.limit(n, offset)` — straightforward SQL `LIMIT n OFFSET m`.

### Current state
`query-executor.js:223` calls `q.limit(effectiveLimit)` with no offset — every query starts
at row 0. Follow-up questions like *"show me the next 50"* have no way to be expressed; the
LLM would just re-run the identical query and get the identical first page.

### Extension

**1. Descriptor changes** — add `offset` (default 0).

**2. `src/query-executor.js` changes** — `q.limit(effectiveLimit, descriptor.offset || 0)`.
Cap `offset` server-side too (e.g. reject/clamp absurd offsets) to avoid deep-pagination
table scans being used as an unintentional DoS vector against the DB — add
`MCP_MAX_OFFSET` (default e.g. 100000) in `config.js`, enforced in the executor.

**3. `src/llm-planner.js` prompt changes** — note that the *MCP client* (the calling LLM,
e.g. Claude Code), not the planner LLM, is what would typically ask a NL follow-up like "show
more" — so this is more about exposing `offset` as an optional tool-input parameter
(`mcp-server.js`'s `natural_language_query` `inputSchema`, alongside `max_rows`) than about
planner prompt changes. Add an `offset` property there, threaded through `callConfig`
similarly to `max_rows` (`mcp-server.js:153-160, 205-208`).

---

## 12. Filtered/infix association paths

### CDS/CQL background
CQL allows an inline filter directly on an association step in a path: `payments[STATUS=
'OPEN'].AMOUNT` — "the AMOUNT of this loan's OPEN payments," scoping the join itself rather
than filtering the outer row afterward. This differs subtly from a `where` on the joined
column: it changes which child rows participate in the join (relevant for to-many
associations combined with aggregation — e.g. "total of OPEN payments per loan" requires the
filter to be *inside* the join, not outside, to get correct per-group sums when other
payment statuses also exist).

### Current state
Not supported — `colRef()` (`query-executor.js:12-14`) only ever splits a plain dotted path;
there's no way to attach a filter to an intermediate hop.

### Extension

**1. Descriptor changes** — extend any path string to optionally carry an inline filter
using a small bracket DSL the planner emits and the executor parses, e.g.
`"payments[STATUS=OPEN].AMOUNT"`, or alternatively (simpler to implement correctly) a
structured form to avoid writing a mini-parser:
```json
{ "col": "AMOUNT", "viaFiltered": { "assoc": "payments", "where": [{"col":"STATUS","op":"=","val":"OPEN"}] } }
```
The structured form is recommended over a bracket-string DSL — much less error-prone to
parse, and reuses the existing `where`-condition machinery.

**2. `src/query-executor.js` changes** — when building the CQN column/join, attach the
inline filter to the join's `on` condition (AND it into the existing `from=to` join predicate
for that alias) rather than as a top-level `WHERE`, using `cds.ql`'s infix-filter builder if
available (`SELECT.from('Loans').columns(l => l.payments(p => p.where({STATUS:'OPEN'})).AMOUNT)`-style
API — check the installed `@sap/cds` version's exact syntax) instead of hand-rolling CQN.
**Confirmed CQL limitation that constrains this feature's scope**: "paths inside the filter
are not yet supported" — i.e. `viaFiltered.where` conditions may only reference plain columns
of the filtered association's *own* target entity, never a further association path off of
it (`payments[loan.STATUS='A']` is invalid CQL). Validate this at planning time: reject any
`viaFiltered.where[].col` that contains a `.`, with a clear error, rather than building an
invalid query.
**Complementary schema-level alternative worth documenting alongside this**: CDS supports
declaring a fixed infix-filtered path directly in the model as an "association-like calculated
element," e.g. `homeAddress = addresses[kind='home': 1];` — if the consumer's own schema
already defines such a shortcut for a *commonly* filtered case, it shows up to this package as
an ordinary association (no executor change needed at all) and is both simpler and safer than
generating the filter dynamically per-query. Mention this in the README/docs as the
recommended approach for filters the consumer knows will recur often; reserve the dynamic
`viaFiltered` descriptor field for filters that vary per natural-language question.

**3. `src/llm-planner.js` prompt changes** — relevant primarily once aggregation (§1) is
also implemented, since infix filters mostly matter for "aggregate over a filtered subset of
a to-many child" questions:
```
FILTERED JOINS (only matters with aggregation):
  - "Total of OPEN payments per loan" needs the OPEN filter applied INSIDE the join to
    payments, not as a top-level WHERE on the outer query (a top-level WHERE on an
    aggregated query would incorrectly exclude loans whose ONLY payments are non-OPEN,
    rather than just excluding non-OPEN payments from the sum). Use:
    {"col": "AMOUNT", "viaFiltered": {"assoc": "payments", "where": [{"col":"STATUS","op":"=","val":"OPEN"}]}}
```

---

## 13. `@cds.persistence.skip` / `@cds.autoexpose` correctness in schema discovery

### CDS/CQL background
- `@cds.persistence.skip` marks an entity that exists in the CDS model but has **no backing
  database table/view** (e.g. a pure API-only or computed entity). Querying it via
  `cds.run()` against the db layer will fail or behave unexpectedly.
- `@cds.autoexpose` marks an entity (often a pure association target with no own service
  exposure) that should be auto-exposed only when reached via a composition, not queried
  standalone — more of a service-layer concern than db-layer, but worth checking it doesn't
  leak through.

### Current state
`schema-reader.js:81-83` only filters out `def.kind !== 'entity'` and names starting with
`sap.`/`DRAFT.`. It does **not** check `@cds.persistence.skip`. If a consumer's schema has
such an entity, it currently gets included in the discovered schema, offered to the LLM as
queryable, and will throw a confusing DB-level error at execution time the first time someone
asks a question that happens to target it.

### Extension

**1. `src/schema-reader.js` changes** — at `schema-reader.js:80-82`, add:
```js
if (def['@cds.persistence.skip'] === true || def['@cds.persistence.skip'] === 'true') continue;
```
This is a pure correctness fix, independent of any of the bigger features above — small,
isolated, safe to implement first as a quick win.

**2. No other file needs to change.**

---

## 14. Localized (translated) text columns

### CDS/CQL background
`localized` on a string element (`localized DESCRIPTION : String`) tells CAP to maintain a
shadow `.texts` companion entity (CAP's `TextsAspect`, keyed by the original entity's key plus
`locale`) holding one row per translation, and CAP's runtime **automatically** rewrites any
read of that element into a join against the row matching the current request's locale
(falling back to the default language) — this is the concrete mechanism name to reference if
this section is ever implemented (`<Entity>.texts`, generated by `TextsAspect`). This already
happens transparently at the `cds.run()` level — no special query syntax needed by the caller.

### Current state
Works "by accident" today — `localized` columns just look like normal `String` columns to
`schema-reader.js`, and `cds.run()` does the locale-join automatically underneath. The only
gap: this package's `cds.run()` call (`query-executor.js:225`) never sets a locale on the
query/transaction, so it will always fall back to the model's default language, regardless of
what language the end user is asking in. Not broken, just not locale-aware.

### Extension

**1. Optional, low priority.** If multi-language data matters, accept a `locale` per-call
parameter (or read `MCP_DEFAULT_LOCALE` from config) and run the query inside `cds.context`
or `cds.tx({ locale })` so the localized-column joins resolve against the right language.
Mark this as a "nice to have, not a gap that breaks anything today" — unlike §13, this is not
urgent.

---

## 15. Window functions, ranking, and partitioning (RANK / ROW_NUMBER / NTILE / LAG / LEAD / running totals)

### Why this section exists
Someone who knows a schema and SQL well doesn't stop at `GROUP BY` — "top 3 loans per
customer by amount," "rank customers by DTI within their sector," "running total of payments
ordered by date," "this month vs. last month per account" are all completely ordinary
business questions, and all of them are SQL **window functions**
(`OVER (PARTITION BY ... ORDER BY ...)`), not plain aggregation. §1 (GROUP BY) *collapses*
rows into one per group; window functions *keep every row* and attach a per-row, per-group
computed value (a rank, a running sum, the previous row's value, etc.) — a fundamentally
different and commonly-needed query shape that §1 cannot express.

### CDS/CQL background
Standard SQL window-function syntax:
```sql
SELECT LOAN_ID, customer_id, amount,
       RANK() OVER (PARTITION BY customer_id ORDER BY amount DESC) AS amount_rank
FROM Loans
```
Common functions: `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `NTILE(n)`, `LAG(col, offset)`,
`LEAD(col, offset)`, and the same aggregates as §1 (`SUM`, `AVG`, `COUNT`, `MIN`, `MAX`) used
*as window functions* (with `OVER (...)` instead of `GROUP BY`) for running totals / moving
averages. SAP HANA supports the full standard set; SQLite has supported window functions
since 3.25 (bundled with most current `@sap/cds` SQLite drivers).

**Important constraint to design around:** CAP's `cds.ql` JS query builder, as of this
package's current `@sap/cds` dependency, has **no first-class fluent API for window
functions** (no `.over()`/`.partitionBy()` builder methods) — this needs to be re-verified
against whatever `@sap/cds` version is installed when this is implemented, since CAP's query
builder surface has grown over time, but treat "no native builder support" as the default
assumption rather than discovering it the hard way mid-implementation.

### Current state
No support at all — not aggregation-adjacent, not partial, just absent. Today, "show the top
3 highest loans for each customer" cannot be expressed by this package's descriptor in any
form: a flat query with `orderBy`+`limit` only ranks/limits *globally*, not *within each
group*, and §1's `groupBy`/`having` collapses rows so individual loan rows are gone by the
time you could rank them.

### Extension

**1. Descriptor changes** — new optional `window` array (per-row computed columns) and an
optional `windowFilter` (post-window filtering — see the SQL constraint explained below):
```json
{
  "entity": "Loans",
  "select": ["LOAN_ID", "customer.PARTNER", "AMOUNT"],
  "window": [{
    "fn": "rank",
    "as": "amount_rank_in_customer",
    "partitionBy": ["customer.PARTNER"],
    "orderBy": [{ "col": "AMOUNT", "dir": "DESC" }]
  }],
  "windowFilter": [{ "col": "amount_rank_in_customer", "op": "<=", "val": 3 }],
  "limit": 500
}
```
- `fn` ∈ `row_number | rank | dense_rank | ntile | lag | lead | sum | avg | count | min | max`.
- `ntile` requires `"buckets": n`. `lag`/`lead` require `"col"` (the value to pull) and
  optional `"offset"` (default 1).
- `partitionBy` is optional (omit for a window over the whole result set — e.g. a running
  total of *all* payments ordered by date with no grouping).
- `orderBy` here is the window's own ordering (distinct from the descriptor's top-level
  `orderBy`, which still controls final row order).
- `windowFilter` exists because of a real SQL rule, not an implementation choice: **a window
  function's result alias cannot be referenced in a `WHERE` clause at the same query level**
  (the standard mandates `WHERE` is evaluated before window functions are computed). "Top 3
  per customer" therefore requires a derived-table wrap:
  ```sql
  SELECT * FROM ( SELECT ..., RANK() OVER (...) AS r FROM Loans ) WHERE r <= 3
  ```

**2. `src/query-executor.js` changes**
- Build each `window` entry as a raw CQN expression column using CQN's `{ xpr: [...] }` token
  array form (the same escape hatch CDS itself uses for expressions the fluent builder
  doesn't model), e.g. tokens for
  `RANK() OVER (PARTITION BY "PARTNER" ORDER BY "AMOUNT" DESC)`. **Every identifier inside
  that token array must be resolved from the already-validated `schema`/`entityDef` object —
  never interpolate the LLM's path strings directly** — reuse `colRef()`'s path-splitting and
  the existing join-alias resolution so a `partitionBy`/`orderBy` column that's actually an
  association path (`customer.PARTNER`) still goes through the same validated join-resolution
  logic as a normal `select` column, not a separate ad-hoc path.
- If `windowFilter` is present: build the *inner* query exactly as above (with the `window`
  columns included), then wrap it — check whether the installed `cds.ql` supports
  `SELECT.from(<a previously-built CQN SELECT>)` as a derived-table source; if it does, use
  that and call `.where(...)` (reusing the existing `buildWhereExpr`/condition-group logic
  from §2) on the outer wrapper. If the builder doesn't support subquery-in-FROM cleanly,
  fall back to a single raw parameterized SQL string for this one specific shape (same
  identifier-validation discipline as the hierarchy raw-SQL path in §4: resolve all
  table/column names from `schema` before string-building, bind all filter values as
  parameters, never concatenate user-influenced strings into the SQL text).
- Extend the entity-allowlist `allPaths` walk (`query-executor.js:144-148`) to include columns
  referenced inside `window.partitionBy`, `window.orderBy`, and `windowFilter` — same
  closing-the-bypass rationale as every other section above.

**3. `src/llm-planner.js` prompt changes**:
```
WINDOW FUNCTIONS (ranking, "top N per group", running totals — different from groupBy):
  - Use "groupBy" + "aggregate" (§ above) when the question wants ONE summary row per group
    ("total loans PER customer", "average DTI PER sector") — rows collapse.
  - Use "window" instead when the question wants to KEEP every row but attach a per-row
    rank/position/running value computed within a group, e.g. "top 3 loans per customer",
    "rank customers by DTI within their sector", "running total of payments by date":
    {"fn": "rank"|"row_number"|"dense_rank"|"ntile"|"lag"|"lead"|"sum"|"avg"|"count"|"min"|"max",
     "as": "alias", "partitionBy": ["COL", ...] (optional), "orderBy": [{"col":"COL","dir":"ASC"|"DESC"}]}
  - "Top N PER GROUP" questions need BOTH a "window" rank AND a "windowFilter" on that rank's
    alias (e.g. {"col":"amount_rank_in_customer","op":"<=","val":3}) — a plain top-level
    "where" cannot filter on a window-function result; you MUST use "windowFilter" for that.
  - Do not use "window" for a simple "top N overall" question (no PARTITION BY implied) —
    that's just "orderBy" + "limit", unchanged.
```

### Worked example
*"Show the top 3 highest-amount loans for each customer."*
```json
{
  "entity": "Loans",
  "select": ["LOAN_ID", "customer.PARTNER", "AMOUNT"],
  "window": [{ "fn": "rank", "as": "amount_rank_in_customer",
               "partitionBy": ["customer.PARTNER"],
               "orderBy": [{ "col": "AMOUNT", "dir": "DESC" }] }],
  "windowFilter": [{ "col": "amount_rank_in_customer", "op": "<=", "val": 3 }],
  "limit": 500
}
```
*"Running total of payments per loan, ordered by payment date."*
```json
{
  "entity": "Payments",
  "select": ["LOAN_ID", "PAYMENT_DATE", "AMOUNT"],
  "window": [{ "fn": "sum", "col": "AMOUNT", "as": "running_total",
               "partitionBy": ["LOAN_ID"],
               "orderBy": [{ "col": "PAYMENT_DATE", "dir": "ASC" }] }],
  "orderBy": "PAYMENT_DATE",
  "orderDir": "ASC",
  "limit": 500
}
```

---

## 16. Combining multiple queries — UNION / INTERSECT / EXCEPT

### Why this section exists (and why it's *not* in the limitations list below)
On first pass, this document grouped `UNION`/`INTERSECT`/`EXCEPT` in with CTEs and generic
subqueries as "architecturally hard, same risk profile as letting the LLM write arbitrary
SQL." That was wrong. Set operations across two independently-valid queries are actually one
of the **lowest-risk, lowest-effort** extensions in this entire document — lower than §4
(hierarchies, needs raw SQL) and §15 (window functions, needs the CQN `{xpr}` escape hatch).
The reason: this package already executes each descriptor down to a plain JS array of rows
(`query-executor.js`'s `executeDescriptor` returns `rows`, an ordinary array, after enum/
blocklist post-processing) — combining two such arrays is JS, not SQL.

### CDS/CQL background
Standard SQL: `SELECT ... FROM A ... UNION [ALL] SELECT ... FROM B ...` (also `INTERSECT`,
`EXCEPT`), each branch must select the same number of columns with compatible types. `UNION`
(no `ALL`) deduplicates the combined result; `UNION ALL` doesn't.

### Current state
Not supported. Each MCP tool call produces exactly one descriptor, rooted at one entity.
"Show me all customers AND all suppliers in one list" or "accounts that appear in both the
delinquent list and the high-value list" cannot be expressed in one call today.

### Extension

**1. Descriptor changes** — accept a top-level `union` (or `intersect`/`except`) array of
**ordinary, already-supported descriptors**, each validated and executed exactly as today:
```json
{
  "union": [
    { "entity": "Customers", "select": ["PARTNER", "BU_SORT1"], "where": [...] },
    { "entity": "Suppliers", "select": ["SUPPLIER_ID", "NAME"], "where": [...] }
  ],
  "distinct": false,
  "limit": 200
}
```
For `intersect`/`except`, use the same shape with the operator as the top-level key instead
of `union`. Each branch's `select` must resolve to the same number of output columns — if the
underlying entities have differently-named columns that represent "the same thing" (e.g.
`PARTNER` vs `SUPPLIER_ID` both meaning "ID"), the LLM should alias them to a shared name
(reuse the existing aliasing mechanism already in `query-executor.js:193-199` for
leaf-name-collision aliasing).

**2. `src/query-executor.js` changes** — no new CQN, no new SQL string-building:
- Add a thin wrapper, e.g. `executeUnion(descriptor, schema, callConfig)`, that:
  1. Validates `descriptor.union.length >= 2` and that every branch's resolved column count
     matches (run each branch's existing column-resolution logic from `executeDescriptor`
     far enough to get the column list before executing, to fail fast on a mismatch with a
     clear error rather than a confusing partial result).
  2. Calls the **existing, unmodified** `executeDescriptor()` once per branch — every
     existing security check (entity allowlist, column blocklist, row cap) already applies
     per-branch with zero new code, because each branch *is* a today's descriptor.
  3. Concatenates the resulting row arrays (`[...rowsA, ...rowsB]`).
  4. For `union` with `distinct: true`, or for `intersect`/`except`, do the set logic in JS:
     `JSON.stringify` each row (or a canonical key built from the row's column values) into a
     `Set`/`Map`, then filter — no SQL needed for this, plain array/object operations.
  5. Apply the combined-result `limit` *after* combining (cap the final array length), and
     enforce the per-branch limit *before* combining too (so one branch can't return
     unbounded rows before the cap is applied) — same `MCP_MAX_ROWS` config already in use.

**3. `src/mcp-server.js` changes** — none beyond passing the descriptor through; the tool's
existing `natural_language_query` handler already calls into the executor generically.

**4. `src/llm-planner.js` prompt changes**:
```
COMBINING RESULTS FROM MULTIPLE ENTITIES (UNION / INTERSECT / EXCEPT):
  - If the question asks to see results from TWO DIFFERENT entities together in one list
    (e.g. "all customers and all suppliers"), use:
    {"union": [<entity-A descriptor>, <entity-B descriptor>], "distinct": false}
  - Each branch is a normal descriptor (entity/select/where/...) — both branches MUST select
    the same NUMBER of columns; alias columns to a shared name if the underlying column
    names differ but represent the same thing (e.g. both aliased to "id", "name").
  - Use "intersect" for "appears in both X and Y," "except" for "appears in X but not Y" —
    same branch-descriptor shape, different top-level key.
  - Do NOT use this for joining related data from one entity to another via an association —
    that's a normal join path (unchanged), not a union. Union is for combining two
    conceptually separate result sets, not for relating rows to each other.
```

### Worked example
*"List all customers and all suppliers together, with just their ID and name."*
```json
{
  "union": [
    { "entity": "Customers", "select": [{ "col": "PARTNER", "as": "id" }, { "col": "BU_SORT1", "as": "name" }] },
    { "entity": "Suppliers", "select": [{ "col": "SUPPLIER_ID", "as": "id" }, { "col": "NAME", "as": "name" }] }
  ],
  "distinct": false,
  "limit": 200
}
```
(Note: this also requires extending `select` to optionally carry an explicit alias per
column — `{ "col": "...", "as": "..." }` instead of a bare string — a small, low-risk
addition to the existing `select` handling in `query-executor.js:178-209`, useful on its own
even outside of `union`.)

---

## 17. `CASE WHEN` computed expressions

### Why this section exists (and why it's no longer in the limitations list)
An earlier pass of this document listed `CASE WHEN` as "a genuine, not-yet-planned gap" in the
limitations table. Further research corrected that: CAP's own CQL reference confirms `CASE
WHEN` with enum-symbol support is plain, sanctioned CQL —
`case status when #open then 0 when #in_progress then 1 end as status_int` is a real, working
example straight from the docs. There is nothing exotic or unsupported about it; it belongs
here as a proper extension, on the same footing as §15 (window functions), not in the
limitations table.

### CDS/CQL background
`CASE WHEN ... THEN ... [ELSE ...] END` works as a computed `SELECT` column exactly like
standard SQL, with one CDS-specific convenience: `WHEN` branches can match against enum
symbols (`#open`, `#in_progress`) instead of raw stored values, so the expression reads in
terms of the model's own enum vocabulary rather than magic numbers/codes.

### Current state
Not supported. A question like *"label each loan's status as Healthy/Watch/Default based on
DAYS_OVERDUE"* has no way to be expressed today — the LLM would have to either fabricate a
column that doesn't exist, or fetch raw rows and ask the calling LLM client to do the
classification client-side (workable, but pushes business logic into prose rather than the
query).

### Extension

**1. Descriptor changes** — add an optional `caseWhen` array of computed columns, usable
anywhere a normal column can appear in `select`:
```json
{
  "entity": "Loans",
  "select": ["LOAN_ID"],
  "caseWhen": [{
    "as": "risk_band",
    "when": [
      { "where": [{ "col": "DAYS_OVERDUE", "op": "<=", "val": 0 }], "then": "Healthy" },
      { "where": [{ "col": "DAYS_OVERDUE", "op": "<=", "val": 30 }], "then": "Watch" }
    ],
    "else": "Default"
  }],
  "limit": 50
}
```
Each `when` entry's `where` uses the same condition shape (including `any`/`all` groups from
§2) as a normal `where` clause, scoped to the entity already in context (same column
resolution as any other `select`/`where` reference — association paths allowed).

**2. `src/query-executor.js` changes** — build via CQN's `{ xpr: [...] }` token-array escape
hatch, the same sanctioned mechanism used for §15's window functions (CAP's own CQN reference
describes `xpr` as deliberately "uninterpreted": keywords/operators are plain strings in a
flat array, which is exactly what a `CASE WHEN` token sequence needs). Resolve every column
reference inside each `when.where` through the existing recursive condition-building logic
from §2 (`buildCondExpr`) so the same operator vocabulary and identifier validation apply —
never assemble the `xpr` tokens from raw LLM strings. Extend the allowlist `allPaths` walk
(`query-executor.js:144-148`) to include columns referenced inside `caseWhen[].when[].where`.

**3. `src/llm-planner.js` prompt changes**:
```
COMPUTED LABELS (CASE WHEN):
  - Use "caseWhen" to turn a numeric/coded column into a business-readable label inline,
    e.g. classifying DAYS_OVERDUE into "Healthy"/"Watch"/"Default" bands:
    {"as": "alias", "when": [{"where": [...], "then": "value"}, ...], "else": "value"}
  - Branches are evaluated top to bottom; the first matching "where" wins (standard CASE WHEN
    semantics) — order branches from most specific to least specific.
  - Prefer an existing "_text" sibling (§ enum/Common.Text handling) over caseWhen whenever
    the model already defines the human-readable mapping — caseWhen is for ad-hoc
    classifications the question asks for that the schema doesn't already encode.
```

### Worked example
*"Show each loan's ID and a risk band: Healthy if not overdue, Watch if 1-30 days overdue, Default otherwise."*
```json
{
  "entity": "Loans",
  "select": ["LOAN_ID"],
  "caseWhen": [{
    "as": "risk_band",
    "when": [
      { "where": [{ "col": "DAYS_OVERDUE", "op": "<=", "val": 0 }], "then": "Healthy" },
      { "where": [{ "col": "DAYS_OVERDUE", "op": "<=", "val": 30 }], "then": "Watch" }
    ],
    "else": "Default"
  }],
  "limit": 200
}
```

---

## 18. Temporal data — `validFrom`/`validTo` time-sliced queries

### CDS/CQL background
CAP has a dedicated **temporal data** mechanism for date-effective records (price history,
org-assignment history, anything where you need "what was true as of date X," not just
"what's true now"). An entity becomes temporal either via explicit annotations:
```cds
entity WorkAssignments {
  start : Date @cds.valid.from;
  end   : Date @cds.valid.to;
}
```
or, more commonly, via the predefined `temporal` aspect from `@sap/cds/common`:
```cds
using { temporal } from '@sap/cds/common';
entity WorkAssignments : temporal { /* adds validFrom, validTo (Timestamp) automatically */ }
```
Time slices are uniquely identified by the conceptual key **plus** `validFrom` — the database
primary key includes both, while the entity's exposed API still reads like a normal,
timeless entity. Validity periods are expected to be **non-overlapping, closed-open
intervals** (same convention as SQL:2011). Two query modes exist:
- **As-of-now (default)**: a plain read returns only the row valid right now — no special
  syntax required, CAP injects the date filter automatically based on the current moment.
- **As-of-date / time-travel**: at the OData protocol layer this is the `sap-valid-at`
  query parameter (e.g. `?sap-valid-at=date'2017-01-01'`); the underlying mechanism is a
  session/request context variable (`valid-from`/`valid-to`) that the runtime uses to filter
  temporal entities — confirmed to **not work on SQLite** today (session-context variables
  aren't supported there), so this extension is HANA/Postgres-only in practice.

### Current state
Not read or handled specially anywhere. `schema-reader.js` treats `validFrom`/`validTo`
columns like any other `Date`/`Timestamp` column — the LLM could, today, write a manual
`where` on `validFrom <= X and validTo > X`, but it has no signal that an entity *is* temporal,
so it has no reason to think to do that, and a plain "give me the loan as of last year" today
silently returns whatever the *current* read returns (no error, just the wrong slice — a
subtle correctness gap, not a hard failure).

### Extension

**1. `src/schema-reader.js` changes** — detect the `temporal` aspect/annotation pattern: an
entity having both a column tagged `@cds.valid.from` and one tagged `@cds.valid.to` (whether
via the explicit annotations or inherited from the `temporal` aspect — `cds.linked()` should
expose the annotation regardless of which path the model used). Tag the entity:
```js
entityDef.temporal = { from: fromColName, to: toColName };
```
Render in the schema prompt: `WorkAssignments [temporal: valid from START to END]`.

**2. Descriptor changes** — add an optional `asOf` field (a date string) at the top level of a
descriptor targeting a temporal entity:
```json
{ "entity": "WorkAssignments", "select": [...], "asOf": "2017-01-01", "limit": 50 }
```

**3. `src/query-executor.js` changes** — when `descriptor.asOf` is present and
`entityDef.temporal` exists, add an explicit `where` condition
`from <= asOf AND to > asOf` (closed-open, matching the documented interval convention) rather
than relying on session-context variables — this sidesteps the confirmed SQLite limitation
entirely and works identically across HANA/SQLite/Postgres, at the cost of not using CAP's
built-in protocol-level mechanism. If `asOf` is omitted, do nothing special — the entity reads
exactly as it does today (as-of-now is already correct without intervention, since the
underlying table only models point-in-time correctness via overlapping slices, not an
implicit "current" filter this package would need to add itself — verify this assumption
against the installed `@sap/cds` version's actual temporal-table DDL/view shape before
shipping, since whether "as of now" needs an explicit filter or is handled entirely by a
generated view depends on exactly how the consumer's project defines the temporal entity).

**4. `src/llm-planner.js` prompt changes**:
```
TIME-TRAVEL QUERIES (temporal entities only):
  - An entity shown as "[temporal: valid from X to Y]" tracks history — multiple time slices
    per logical record. For "as of <date>" / "back in <year>" / "what was true on <date>"
    questions, use "asOf": "YYYY-MM-DD" at the top level instead of trying to hand-write a
    where condition on the validFrom/validTo columns yourself.
  - Without "asOf", you get the current/latest slice — fine for "what is the current X"
    questions on a temporal entity.
```

### Worked example
*"What was the customer's work assignment on 2017-01-01?"*
```json
{ "entity": "WorkAssignments", "select": ["ID", "role"], "asOf": "2017-01-01", "limit": 50 }
```

---

## 19. Native `excluding` clause — a documented alternative to `MCP_BLOCKED_COLUMNS` (not a recommended replacement)

### CDS/CQL background
CQL's `SELECT * excluding { col1, col2 }` removes named columns from an otherwise-implicit
`*` projection, including inside nested expands/inlines. CAP's own docs frame its purpose as
enabling "late materialization" — staying open to a source entity gaining new columns later
without the view/query needing to be touched, since `excluding` only ever subtracts from
whatever the source currently has.

### Current state and why this package does NOT use this mechanism today
`query-executor.js:201-209` implements column blocking the opposite way: when any columns are
blocked, it builds an **explicit allow-list** of every column that isn't blocked
(`Object.keys(entityDef.columns).filter(c => !allBlocked.has(c))`), rather than sending `*
excluding {...}` to the database. This is a deliberate, security-relevant difference worth
documenting explicitly so a future implementer doesn't "simplify" it away:

| | `excluding` (CQL native) | This package's current approach |
|---|---|---|
| Behavior when schema gains a new column later | New column is **auto-included** in `*` (unless also added to the exclude list) | New column is **auto-excluded** until someone explicitly adds it to the allow-list build |
| Failure mode if `MCP_BLOCKED_COLUMNS` is misconfigured/incomplete | A newly added sensitive column (e.g. a future `SSN` field) would be silently exposed | A newly added column is simply not selectable until the code/config catches up — safe by default |

This is a "secure by default, fail closed" property worth keeping. **Do not replace the
current allow-list construction with `excluding` for the blocklist feature** — the explicit
allow-list is strictly safer for a security control whose entire job is "never expose column
X," even if it requires a tiny bit more code than the native clause. `excluding` remains
useful, if ever needed, for an unrelated purpose: letting the *LLM* deliberately omit specific
columns from a result for readability (e.g. "show me everything except the internal notes
field") — a UX nicety, not a security boundary, and should never be wired to the same code
path as `MCP_BLOCKED_COLUMNS`/`allowedEntities` enforcement.

---

## Known limitations vs. full hand-written SQL — what stays out of scope, and why

The question this section answers: *"If I gave this database to someone who knows SQL well,
they could write any query they wanted — CTEs, window functions, subqueries, pivots, set
operations, whatever the question needs. Can this package eventually do the same?"*

**Short answer: mostly yes, for the question *shapes* that come up in practice — §1–§19 above
cover aggregation, grouping, OR logic, existence checks, recursion, deep reads,
ranking/partitioning/running totals, combining multiple entities' results, computed CASE WHEN
labels, and time-sliced/temporal queries, which together account for the large majority of
real-world ad-hoc business questions. But this package is deliberately NOT, and should not
become, a generic "let the LLM write and execute arbitrary SQL" engine.** The descriptor-JSON
architecture is a constraint applied on purpose, not a temporary limitation waiting to be
lifted. The list below is what remains genuinely out of scope even after implementing every
extension in this document, and the architectural reason it's drawn there. (Two corrections
from earlier drafts of this table, kept here for transparency: `UNION`/`INTERSECT`/`EXCEPT`
were originally listed here as architecturally hard — wrong, see §16, they're pure JS array
operations over the existing validated path. `CASE WHEN` was originally listed here as a vague
"not yet planned gap" — also an underestimate; confirmed as plain native CQL, see §17.)

| Capability | Status after §1–§19 | Why it's still out of scope |
|---|---|---|
| `WITH ... AS (...)` CTEs (general-purpose) | Not supported, except the one narrow raw-SQL CTE used internally for SQLite recursive hierarchy traversal (§4, fallback path only) | A general CTE feature means accepting arbitrary multi-step query structure from the LLM — at that point you're no longer validating a finite, known vocabulary, you're validating arbitrary SQL structure, which is a different and much harder security problem. |
| Arbitrary correlated scalar subquery as a `SELECT` column (e.g. `(SELECT MAX(x) FROM y WHERE ...) AS col`) | Not supported as a generic feature | Only specific, validated subquery *shapes* are supported: `exists`/`notExists` (§3), the window-function derived-table wrap (§15), and `caseWhen` (§17). A generic "put any subquery anywhere" escape hatch reopens the same arbitrary-structure problem as CTEs. |
| `FULL OUTER JOIN` | Not supported | CDS associations themselves only model `INNER`/`LEFT` cardinality-derived joins (`schema-reader.js:96-97`) — CAP's own modeling layer doesn't expose `FULL OUTER` as an association concept, so there's no schema-level hook to drive it from. Achievable only via raw SQL, which would need its own dedicated (and carefully scoped) extension. |
| Stored procedure / user-defined function calls | Not supported, and not planned | Executing arbitrary procedures based on an LLM's interpretation of a question is a materially larger blast radius than read-only `SELECT`s — out of scope by design. |
| Any write (`INSERT`/`UPDATE`/`DELETE`/DDL) | Not supported, and structurally cannot happen | The descriptor vocabulary has no field that means "write" — there's no parser path that could accidentally execute one. This is the one limitation that's a *feature*, not a gap: see the README's "Read-only" guarantee. |
| `PIVOT` / `UNPIVOT`, dynamic column sets decided at query time | Not supported | Same arbitrary-structure problem as CTEs — the result *shape* of a pivot depends on data values, which conflicts with the "every column the LLM can touch is validated against the static schema up front" design. |
| Truly unbounded result sets / unbounded recursion depth | Not supported, even where the underlying SQL feature exists (§4 hierarchies, §15 window functions over large partitions) | Every section above that introduces a new traversal or computation explicitly keeps the existing row caps (`MCP_MAX_ROWS`) and adds new caps where needed (`MCP_MAX_HIERARCHY_DEPTH`, `MCP_MAX_OFFSET`). This is intentional: an MCP tool answering chat questions has different cost/safety requirements than a BI analyst running a one-off query directly against the warehouse. |

### The architectural reason, stated directly

This package is not a text-to-SQL engine that hands an LLM's raw SQL string to the database.
It is a small, fixed JSON descriptor vocabulary, compiled into CQN by trusted code, on
purpose, because that's what makes the following three guarantees possible at all:

1. **Every identifier is schema-validated before use.** Table and column names only ever
   come from the `schema` object built from the real, loaded CDS model — never from an
   LLM's free-form string substituted directly into a query. This is what prevents both SQL
   injection through a crafted natural-language question and silent garbage queries against
   columns that don't exist.
2. **The existing security controls stay enforceable.** `MCP_ALLOWED_ENTITIES`,
   `MCP_BLOCKED_COLUMNS`, and `MCP_MAX_ROWS` (`config.js`, enforced in
   `query-executor.js:120-172`) only work because the descriptor's vocabulary is finite and
   known in advance — every new feature in this document was explicitly threaded back through
   that allowlist walk for exactly this reason. A generic SQL pass-through has no equivalent
   choke point.
3. **"Read-only" is structural, not a convention.** There is no code path anywhere in the
   descriptor → CQN pipeline that can express a write or a DDL statement, because the
   descriptor schema simply has no field that means that. A raw-SQL mode would have to
   re-derive that guarantee by parsing and rejecting statement types at runtime — strictly
   weaker than "the capability doesn't exist in the vocabulary at all."

**If full arbitrary-SQL parity is genuinely required** — i.e., a use case that truly cannot
be expressed by any combination of §1–§19 (CTEs, pivots, full outer joins, procedure calls) —
that is a different and strictly higher-risk product, not an extension of this one. It should
be a separate, explicitly opt-in mode: a distinct tool name (e.g. `raw_sql_query`, never the
same tool as `natural_language_query`), gated behind its own config flag (e.g.
`MCP_ENABLE_RAW_SQL=false` by default), with its own independent safeguards — a strict
single-`SELECT`-statement validator that rejects multiple statements, DDL/DML keywords, and
comment-hiding tricks; mandatory use of the restricted read-only `MCP_DB_USER` (never the
app's default connection); and ideally execution inside an explicitly read-only transaction if
the driver supports one. **Recommendation: implement §1–§19 first** — they cover the
overwhelming majority of real question shapes, including ranking, partitioning, multi-entity
combination, computed labels, and time-travel — and only consider a raw-SQL mode if a specific,
concrete question genuinely cannot be expressed any other way.

---

## Suggested implementation order

Ordered by (impact) ÷ (implementation risk), not strict dependency:

1. **§13** `@cds.persistence.skip` filter — tiny, pure bugfix, do first regardless of what
   else gets picked up.
2. **§2** OR/nested WHERE groups — small, high-value, no new architectural concept (just a
   recursive refactor of an existing function).
3. **§1** Aggregation/GROUP BY — biggest unlock in terms of *number of new questions
   answerable*; moderate executor complexity.
4. **§3** EXISTS/NOT EXISTS — fixes a real correctness gap (join fan-out) that currently
   produces *wrong* (not just incomplete) answers for a common question shape.
5. **§10** `@assert.range` hints — trivial, prompt-only, immediate quality improvement.
6. **§7 / §8** `@Common.ValueList` / `@Semantics` — incremental generalization of
   already-proven patterns (`@Common.Text`), low risk.
7. **§11** Offset/pagination — small, mostly mechanical.
8. **§6** Virtual/calculated elements — mostly a transparency/labeling improvement.
9. **§9** `@cds.search` — moderate value, isolated.
10. **§5** Deep/expand output — architecturally the biggest change (new output shape,
    nested filtering/blocklisting), do after the team is comfortable with the codebase
    changes from §1–§4.
11. **§12** Filtered/infix joins — mostly only valuable once §1 (aggregation) exists; pair
    them together.
12. **§4** Recursive hierarchies — most complex (potentially raw-SQL, DB-specific,
    security-sensitive), do last and with the most test coverage.
13. **§15** Window functions/ranking/partitioning — pair with §1 (shares the aggregate-fn
    vocabulary and the same "verify cds.ql builder support, fall back to validated raw SQL"
    risk profile as §4); do after §1–§4 are in and tested, since `windowFilter` reuses the
    condition-group logic from §2.
14. **§16** UNION/INTERSECT/EXCEPT — despite appearing late numerically, this is one of the
    *lowest*-risk items on the whole list (pure JS array combination over the existing,
    already-validated single-entity execution path, no new SQL) — good candidate to pull
    forward and do early/cheaply alongside §2 if multi-entity questions come up often.
15. **§17** `CASE WHEN` — confirmed plain native CQL (no longer a vague gap); pair with §15
    since both use the same `{xpr:[...]}` escape hatch and the same identifier-validation
    discipline — implement together for shared review effort.
16. **§18** Temporal data (`asOf`) — isolated, low risk (a single extra `where` condition,
    purely additive), but only valuable if the consumer's schema actually has temporal
    entities — do opportunistically, not on a fixed schedule.
17. **§14** Locale awareness — nice-to-have, no urgency.
18. **§19** Native `excluding` clause — not an implementation task at all, just a documented
    decision to *not* adopt it for the security-relevant blocklist; read it once, then skip.

See "Known limitations vs. full hand-written SQL" above for what's deliberately **not** on
this list (CTEs, generic subqueries, full outer joins, stored procedures, writes,
pivot/unpivot) and why.

## Cross-cutting implementation notes for whoever picks this up

- **Every new descriptor field must be threaded through the existing access-control checks**
  (`collectJoinedEntities` / the allowlist loop in `query-executor.js:141-160`). It is easy to
  add a new way to reach a joined entity (via `exists`, `expand`, `viaFiltered`, `hierarchy`,
  `window.partitionBy`, `caseWhen.when[].where`) and forget to extend the allowlist walk —
  that would silently reopen the exact bypass the existing code comment at
  `query-executor.js:19-22` was written to close. Treat this as a required step for §1, §3,
  §4, §5, §12, §15, §17, not an optional follow-up.
- **Verify exact `cds.ql`/CQN builder syntax against the actual installed `@sap/cds` version**
  before writing executor code. This research pass confirmed several pieces directly against
  CAP's own docs/source — treat these as settled, not speculative: the `{func, args}`
  function-call shape (§1), `groupBy`/`having`/`distinct` as documented `cds.ql` builder
  methods (§1), `EXISTS`/infix-filter as native CQL with no hand-rolled subquery needed (§3),
  the `{xpr:[...]}` uninterpreted-token escape hatch for window functions and `CASE WHEN`
  (§15, §17), and the `@Aggregation.RecursiveHierarchy` annotation's existence and
  cross-backend (HANA/SQLite/Postgres) support (§4). What's still genuinely unverified and
  needs a hands-on check against the installed version before coding: the exact non-OData
  `cds.ql`/CQN entry point for driving `@Aggregation.RecursiveHierarchy` directly via
  `cds.run()` (§4), and whether the installed `cds.ql` supports a previously-built CQN
  `SELECT` as a derived-table source for the `windowFilter` wrap (§15) — write a tiny
  throwaway script (`node -e "..."` against a real CAP project) to print the CQN AST for a
  hand-written `cds.ql` query before committing to either of those two specific code shapes.
- **Every new feature needs a planner prompt section AND a schema-reader/executor change** —
  a feature that exists in the executor but isn't mentioned in `SYSTEM_PROMPT` will never be
  used by the LLM; a feature mentioned in the prompt but not implemented in the executor will
  cause runtime errors on first use. Ship both halves together per feature, not in separate
  PRs.
- **Backward compatibility**: every extension above is additive (new optional descriptor
  fields) — no existing descriptor shape needs to change. Keep it that way; this package has
  no descriptor schema version field, so there's no migration path if a field's meaning
  changes incompatibly later.
