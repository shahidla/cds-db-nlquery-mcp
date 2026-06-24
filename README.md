# @shahid.la/cds-db-nlquery-mcp

MCP server for natural language queries against **CDS db-layer entities** (`db/schema.cds`).

Ask questions about your database in plain English. The server discovers your schema automatically, generates real SQL JOINs using CDS, and returns rows. No hardcoded queries, no SQL, no schema configuration. Bring your own LLM: Anthropic or OpenAI, or any OpenAI-compatible endpoint (Azure OpenAI, Groq, Ollama, local models, etc.).

> **Targets the `db/` layer, not OData services.** If your entities are exposed as OData services, use an MCP package that targets the service layer instead.

**Read-only.** This package only executes SELECT queries. No INSERT, UPDATE, or DELETE.

---

## Prerequisites

- A CAP project with `@sap/cds >= 7`
- A configured CDS database (HANA Cloud, SQLite, PostgreSQL)
- An MCP client (Claude Code, Claude Desktop, or any MCP-compatible host)
- An API key for an LLM provider (see [LLM provider](#llm-provider) below), used to translate your question into a query, not to answer it

---

## Quick start

**1. Install in your CAP project**

```bash
npm install @shahid.la/cds-db-nlquery-mcp
```

**2. Create `.mcp.json` in your CAP project root** (same folder as `package.json`)

```json
{
  "mcpServers": {
    "cds-db-nlquery": {
      "command": "npx",
      "args": ["-y", "@shahid.la/cds-db-nlquery-mcp"],
      "cwd": "/absolute/path/to/your/cap/project",
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Set `cwd` to the absolute path of your CAP project root, where `db/schema.cds` lives. See [LLM provider](#llm-provider) for using OpenAI, Gemini, or another provider instead.

`npx -y` re-resolves the package on every server start (from npm's cache once
downloaded, not a fresh network fetch each time, but still an extra resolution
step). If you've run `npm install @shahid.la/cds-db-nlquery-mcp` already, you
can point `"command"` at the installed binary directly instead,
`node_modules/.bin/cds-db-nlquery-mcp`, for a slightly more predictable startup,
especially in production.

**3. Open your project in Claude Code and ask a question**

```
Which customers have a DTI ratio above 5?
Show me all open payments overdue by more than 30 days, include the borrower name.
List all loans in the MINING sector with the customer's current DTI ratio.
```

**Example response:** the server tells the client to render rows as a vertical
field/value list, not a markdown table (real output, verified against a live
deployment):

```
Found 3 customers with DTI above 5:

PARTNER    : 30100003
DTI_RATIO  : 7.20
BU_SORT1   : Domestic Customer AU 3

PARTNER    : 30100001
DTI_RATIO  : 5.80
BU_SORT1   : Domestic Customer AU 1

PARTNER    : 30100002
DTI_RATIO  : 5.40
BU_SORT1   : Domestic Customer AU 2
```

---

## How it works

When you ask a question:

1. Your MCP client (e.g. Claude Code) calls the `natural_language_query` tool with your question.
2. The MCP server has already loaded your CDS schema at startup: entity names, columns, and associations. It sends this schema plus your question to the LLM provider you configured (Anthropic, OpenAI, or any OpenAI-compatible endpoint), which translates it into a structured query descriptor.
3. The server executes a single CDS query. CDS association paths (`customer.BU_SORT1`) generate real SQL JOINs, executed by your database, not by JavaScript. Scales to production data volumes.
4. Results come back to your MCP client, which formats and presents the answer.

The LLM call in step 2 is a small, cheap planning step (translating your question into JSON). It does not need a large or expensive model. A fast/cheap tier model is recommended.

---

## Configuration

All configuration is via environment variables in the `.mcp.json` `env` block.

```json
{
  "mcpServers": {
    "cds-db-nlquery": {
      "command": "npx",
      "args": ["-y", "@shahid.la/cds-db-nlquery-mcp"],
      "cwd": "/path/to/your/cap/project",
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "MCP_ALLOWED_ENTITIES": "Customers,Orders,Products",
        "MCP_BLOCKED_COLUMNS": "PASSWORD,EMBEDDING,SSN",
        "MCP_MAX_ROWS": "100",
        "MCP_MODEL_PATH": "db"
      }
    }
  }
}
```

| Variable | Default | Description |
|---|---|---|
| `MCP_ALLOWED_ENTITIES` | *(all entities)* | Comma-separated list of entity **short names**, the name after the last dot in the FQN (e.g. `Customers`, not `my.app.Customers`). Leave unset during development; always set for production. |
| `MCP_BLOCKED_COLUMNS` | *(none)* | Comma-separated column names to exclude from all results. Stripped before the query runs. Useful for columns like `EMBEDDING`, `PASSWORD`, `SSN`. |
| `MCP_MAX_ROWS` | `500` | Maximum rows per query. Enforced as a SQL `LIMIT`, not a post-fetch filter. |
| `MCP_MODEL_PATH` | `db` | Path to your CDS model folder or file, relative to `cwd`. Change if your schema is at `model/`, `srv/`, etc. |
| `MCP_DB_USER` / `MCP_DB_PASSWORD` | *(consumer app's own DB user)* | Connect with a different HANA user than your app's runtime user. Host/port/schema are reused, only credentials are overridden. See [Security → Production](#production) for why this matters. |

### LLM provider

A small LLM call translates your question into a query descriptor. **Bring your own provider**, set ONE of the following in the `env` block:

**Anthropic (Claude):**
```json
"env": {
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "ANTHROPIC_MODEL": "claude-haiku-4-5-20251001"
}
```

**OpenAI, or any OpenAI-compatible provider:**
```json
"env": {
  "OPENAI_API_KEY": "sk-...",
  "OPENAI_MODEL": "gpt-4o-mini"
}
```

`OPENAI_MODEL` accepts any model name. Use whatever your provider expects. Set `OPENAI_BASE_URL` to point at a different OpenAI-compatible endpoint:

| Provider | `OPENAI_BASE_URL` | Example `OPENAI_MODEL` |
|---|---|---|
| OpenAI | *(omit, uses default)* | `gpt-4o-mini` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.0-flash` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| xAI (Grok) | `https://api.x.ai/v1` | `grok-2-latest` |
| Azure OpenAI | your Azure endpoint | your deployment name |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.1` (API key can be any non-empty string) |

| Variable | Description |
|---|---|
| `LLM_PROVIDER` | `"anthropic"` or `"openai"`. Auto-detected from whichever API key is set, only needed if both are set and you want to force one. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Anthropic native API |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` | OpenAI or any OpenAI-compatible endpoint |

This is a planning-only call (question to JSON descriptor). A fast/cheap tier model is sufficient and recommended.

---

## Security

### Development

The server uses your project's existing database connection, whatever CDS has configured in `default-env.json` or your service binding. No extra setup needed.

### Production

**Important:** this package queries the database directly via `cds.run()`. It does **not** go through the CAP service layer, so CAP `@requires` and `@restrict` annotations are **not enforced**. Access control is entirely your responsibility at the database and configuration level.

**Step 1: Create a dedicated read-only database user**

```sql
-- Run as DBADMIN in SAP HANA Cloud Central
CREATE USER MCP_READER PASSWORD 'your-password';
GRANT SELECT ON SCHEMA YOUR_HDI_SCHEMA TO MCP_READER;

-- Revoke tables you do not want queryable
REVOKE SELECT ON "YOUR_HDI_SCHEMA"."your.AuditLog" FROM MCP_READER;
REVOKE SELECT ON "YOUR_HDI_SCHEMA"."your.RegulatoryDocuments" FROM MCP_READER;
```

This user can only read. No write access. HANA itself enforces it, independently of this package.

**Step 2: Point the server at it with `MCP_DB_USER`/`MCP_DB_PASSWORD`**

The server connects with these credentials instead of inheriting your app's own
database connection. Host, port, and schema are reused automatically, only the
user/password are overridden:

```json
"env": {
  "MCP_DB_USER": "MCP_READER",
  "MCP_DB_PASSWORD": "your-password"
}
```

If you keep these in a separate gitignored file instead of directly in `.mcp.json`,
that's fine too. The server just reads `process.env`, same as any other variable here.

**Step 3: Set `MCP_ALLOWED_ENTITIES`**

```json
"env": {
  "MCP_ALLOWED_ENTITIES": "Customers,Orders,Products"
}
```

This is enforced on the entity you query directly **and** on any entity reached via
an association join in `select`/`where`. For example, if `Customers` isn't in the allowlist,
a query against `Orders` can't read `Customers` data through a `customer.NAME` join
path either. The database user restricts access at the HANA level;
`MCP_ALLOWED_ENTITIES` adds a second layer at the application level. Use both.

---

## Joins

The server reads CDS associations from your schema. When the LLM references `customer.BU_SORT1` in a query, CDS generates a real SQL JOIN, executed by the database.

**Multiple associations in one query work:**

> *"Show loans in the MINING sector with borrower name and current DTI"*

Generates a single SQL statement joining `Loans → BusinessPartners → BCA_DTI` in one database round-trip.

**One constraint:** do not select the same column name from two different entities in the same query (e.g. `LOAN_ID` from both the main entity and a joined entity). The database rejects duplicate column names. Claude is instructed to avoid this, but worth being aware of.

### Comparing two columns to each other

Most filters compare a column to a fixed value (`DTI_RATIO > 5`). For questions like *"which loans have collateral worth less than the loan amount"*, the comparison is between two columns instead. Use `valCol` in place of `val`:

```json
{ "col": "collateral.VALUE", "op": "<", "valCol": "AMOUNT" }
```

Either side can be an association path. This is handled by the same join mechanism as everything else. No separate query, no JavaScript-side comparison.

### Filtering by a coded value's human meaning

If a column has a `@Common.Text` value-help association (see [Coded values](#coded-values--what-does-status--c-mean)), filter via the text field directly rather than guessing the underlying code:

```json
{ "col": "status.TEXT", "op": "like", "val": "Active" }
```

`like` is case-insensitive (enforced via `UPPER()` on both sides, not relying on database collation), so the exact case of the value doesn't need to match.

---

## Column and entity labels

The LLM only sees what's in your CDS model: column names, types, and any labels you've annotated. Plain code comments (`// customer name`) are invisible to it. Without a label, an ambiguous column name can cause the LLM to guess wrong, regardless of how capable the model is.

### `@title`: reused automatically, zero extra work

If your schema already has SAP's standard `@title` annotation (common in projects with a Fiori UI or OData service), the server picks it up automatically. You don't need to do anything:

```cds
entity Customers {
  key PARTNER  : String(10);
  @title: 'Customer Name'
  BU_SORT1     : String(40);
}
```

### `@NLP.label`: for disambiguation `@title` isn't meant for

Use this when you need to tell the LLM something a UI-facing label shouldn't say, e.g. "don't use this column for X." This was a real bug we hit: a `BU_TYPE` code column (`1`=person, `2`=organisation) was being picked by the LLM whenever a question asked for a customer's "name," because nothing told it otherwise. The fix:

```cds
entity Customers {
  key PARTNER  : String(10);
  @NLP.label: 'Partner type code: 1=person, 2=organisation. NOT a name, never use for name lookups'
  BU_TYPE      : String(2);
  @NLP.label: 'Customer / business partner full name, use this whenever a question asks for a name'
  BU_SORT1     : String(40);
}
```

After adding these two labels, even the cheapest tier model (`claude-haiku-4-5`) picked the right column every time. **Fix ambiguity at the schema level, not by tweaking prompts per-bug.** It's permanent and works regardless of which LLM provider or model you use.

**Precedence:** `@NLP.label` is checked first, falls back to `@title`, falls back to the raw column/entity name if neither is set.

### Other `@NLP` annotations

```cds
entity Customers @(NLP.label: 'Active borrowers, loan customers with income and sector data') {
  dti : Association to BCA_DTI on dti.PARTNER = PARTNER
        @NLP.joinType: 'LEFT';
}
```

| Annotation | Where | Effect |
|---|---|---|
| `@NLP.label` | Entity or column | Description shown to the LLM. Falls back to `@title`, then the name. |
| `@NLP.joinType` | Association | Override join type: `'LEFT'` or `'INNER'`. Auto-detected from cardinality if not set. |
| `@NLP.alias` | Association | Override the association name used in queries |

All optional. The package works without any of them. But for any column whose name alone could be misread (codes, abbreviations, anything that looks like one thing but means another), a label is the difference between the LLM guessing and the LLM knowing.

---

## Coded values: what does `STATUS = 'C'` mean?

Labels solve "what does this column mean." A separate problem: what does a *coded
value* in that column mean? `STATUS = 'C'`. Closed? Cancelled? Confirmed?

There are two ways to tell the LLM, and **which one to use depends on whether the
value list can change without a code deploy.**

### `@Common.Text`: for business-configurable codes (the common case)

Most status/type codes are business data. Someone in operations might introduce a
new value next quarter, and that should never require touching the schema file. The
SAP-standard mechanism for this is `@Common.Text`, pointing through an association to
a small lookup/check table, the same pattern Fiori elements uses for value-help
dropdowns:

```cds
entity LoanStatusCodes {
  key CODE : String(1);
  TEXT     : String(20);
}

entity Loans {
  @Common.Text: status.TEXT
  STATUS : String(1);
  status : Association to LoanStatusCodes on status.CODE = STATUS;
}
```

Seed it with `{CODE: 'A', TEXT: 'Active'}`, `{CODE: 'C', TEXT: 'Closed'}`. Adding a
new status later is an `INSERT` into `LoanStatusCodes`, no schema change, no
redeploy. The server detects `@Common.Text`, tells the LLM a readable value is
available via the association path, and the LLM includes it in `select` using the
normal join mechanism. No extra code on our side, it's the same association-path
JOIN used everywhere else in this package.

### CDS `enum`: only for sets that are genuinely fixed forever

```cds
STATUS : String(1) enum { active = 'A'; closed = 'C'; };
```

This is compile-time: adding a value means editing `schema.cds` and redeploying.
Appropriate only for values that are tied to actual program logic anyway (so a code
change would be required regardless), not for business classifications. We initially
used `enum` for our own demo's status fields and walked it back to `@Common.Text` for
exactly this reason. It's documented here as a contrast, not a recommendation.

**Rule of thumb: reach for `@Common.Text` by default. Use `enum` only when you're sure
the list can never grow without code changing anyway.**

When a column has `@Common.Text`, query results get the raw code back as normal.
Presentation (showing "Closed" instead of "C") is up to whichever LLM renders the
final answer, using the readable value it fetched via the join.

---

## Startup log

When the server starts, check the output panel in Claude Code:

```
[cds-db-nlquery-mcp] Schema loaded — 12 entities
[cds-db-nlquery-mcp] WARNING: MCP_ALLOWED_ENTITIES not set — all entities are queryable. Set in .mcp.json for production.
[cds-db-nlquery-mcp] WARNING: MCP_DB_USER not set — using the project's default DB connection (likely the main app's full-access user). Set MCP_DB_USER/MCP_DB_PASSWORD to a restricted read-only user for production use.
[cds-db-nlquery-mcp] LLM provider: anthropic
[cds-db-nlquery-mcp] Ready (stdio)
```

**`0 entities` at startup?** Check that `cwd` in `.mcp.json` points to your CAP project root and that `MCP_MODEL_PATH` matches your schema folder name.

**`WARNING: No LLM provider configured`?** Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the `.mcp.json` `env` block, see [LLM provider](#llm-provider).

**`WARNING: MCP_DB_USER not set`?** Expected during development, the server is using the same database connection as your CAP app. Before production use, see [Security → Production](#production) for creating a dedicated read-only user.

---

## Testing this against your own deployment

`npm install` gives you `src/`, the MCP server, and nothing else. That's the
entire published package. The GitHub repository also has an
`examples/capability-demo/` folder with a real CDS schema, seed data, ~35
example queries with verified expected results, and four scripts to actually
exercise them against your own database (not just read about it): one runs the
example queries directly against the internal functions, one lets you ask your
own question end-to-end through a real LLM, one runs every example question's
natural-language text through a real LLM and checks the result, and one spawns
`src/mcp-server.js` itself as a real child process and drives it through the
actual MCP stdio protocol, the same way Claude Code or Claude Desktop would,
rather than calling internal functions directly. None of this ships with
`npm install`. Clone the repo if you want it. See that folder's own README for details.

---

## How releases are tested

`npm test` (126 unit tests) runs against a mocked database. Fast, but it can't
catch backend-specific behavior (a real HANA deployment has rejected things the
mocks happily accepted, more than once). Before tagging a release, `npm run
test:deployment` is run against a real CAP project connected to live HANA
Cloud. It requires real credentials and a deployed `examples/capability-demo/`
schema, so it isn't part of `npm test` or CI, but it is a required manual step,
not an optional one. `examples/capability-demo/smoke-test-server.js` is also
run. It spawns `src/mcp-server.js` itself and drives it over the real MCP
stdio protocol with a real LLM call, not just the internal functions directly.

[RELEASE_VERIFICATION.md](./RELEASE_VERIFICATION.md) is the actual, append-only
record of this: real output from a real run against live BTP HANA, captured
and committed before each release, not just claimed.

---

## License

MIT
