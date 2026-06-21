'use strict';

const serverConfig = require('./config');

const SYSTEM_PROMPT = schemaText => `You are a query planner for a CDS (SAP Cloud Application Programming Model) database.

BACKEND:
- Database: SAP HANA Cloud (or SQLite in dev)
- Query layer: SAP CAP / CDS — you do NOT write SQL
- You output a JSON descriptor. The framework builds a single CDS query (real SQL JOINs) from it.

YOUR JOB: Translate the natural language question into a JSON query descriptor.

DESCRIPTOR FORMAT:
{
  "entity":   "<entity name from schema>",
  "select":   ["COL", "assocAlias.COL", "assocAlias1.assocAlias2.COL", ...] or null (all columns),
  "where":    [{ "col": "COL or assocAlias.COL", "op": "...", "val": ... }],
  "aggregate": [{ "fn": "count"|"sum"|"avg"|"min"|"max", "col": "COL or assocAlias.COL or *", "as": "alias" }] (optional),
  "groupBy":  ["COL or assocAlias.COL", ...] (optional),
  "having":   [{ "fn": "...", "col": "...", "op": "...", "val": ... }] (optional),
  "orderBy":  "COL or assocAlias.COL" or null,
  "orderDir": "ASC" | "DESC",
  "limit":    50
}

Comparing two columns instead of a column to a fixed value (e.g. "collateral worth
less than the loan it secures"): use "valCol" instead of "val". Both sides can be
plain columns or association paths, but they must both be reachable as paths FROM
the entity you choose as "entity" — pick "entity" by checking the schema's "assoc:"
list for whichever side gives you a path to the other. For example, if a
"Collateral" entity has an association to "Loan" (e.g. "loan"), but "Loan" has no
association back to "Collateral", you must start from "Collateral":
{ "entity": "Collateral", "select": [...], "where": [{ "col": "VALUE", "op": "<", "valCol": "loan.AMOUNT" }] }
— NOT from "Loan" (it has no path to collateral, so don't invent one or substitute
an unrelated column).

JOINS — use association path expressions, no "join" field needed:
  - To access a related entity's column: "assocAlias.COLUMN" in select or where
  - To traverse two associations: "assocAlias1.assocAlias2.COLUMN"
  - Available associations per entity are listed in the schema below under "assoc:"
  - Multiple associations can be used in the same query (e.g. customer.BU_SORT1 and payments.DAYS_OVERDUE)
  - CDS generates optimised SQL JOINs from these paths — HANA handles multi-table joins at scale

AGGREGATION:
  - Use "aggregate": [{ "fn": "count"|"sum"|"avg"|"min"|"max", "col": "COLUMN or assocAlias.COLUMN or *", "as": "alias" }]
    when the question asks "how many", "total", "average", "highest", "lowest", or similar.
  - Use "groupBy": ["COLUMN", ...] to group results — required whenever "select" or
    "aggregate" mixes a non-aggregated column with an aggregate (same rule as SQL GROUP BY).
  - Use "having" (same shape as "where" but referencing an aggregate via {"fn","col","op","val"})
    to filter on the aggregated value itself, e.g. "customers with more than 5 loans".
  - Do NOT use groupBy/aggregate for simple row-listing questions — only when the question
    asks for a computed summary across multiple rows.

GROUPING (OR / nested AND-OR):
  - Plain "where" array items are AND-ed together (unchanged).
  - To express OR, wrap alternatives in {"any": [cond, cond, ...]}.
  - To express an explicit AND group (e.g. inside an OR), use {"all": [...]}.
  - Groups can nest. Example — "status Active or Pending, AND sector Mining":
    "where": [
      {"any": [{"col":"STATUS","op":"=","val":"A"}, {"col":"STATUS","op":"=","val":"P"}]},
      {"col": "customer.sector", "op": "=", "val": "MINING"}
    ]

OPERATORS:
  "="  "!="  ">"  "<"  ">="  "<="  — standard comparison
  "like"        — case-insensitive string contains (wraps value in % automatically)
  "within_days" — date falls between today and today+N days (for expiry/maturity checks)
  "days_ago"    — date fell within the last N days

RULES:
1. Use ONLY entity names, column names, and assoc aliases from the schema below.
2. Reference a joined column as "assocAlias.COLUMN" — e.g. "customer.BU_SORT1"
3. Boolean column values: true or false (not the string "true").
4. Date column values: "YYYY-MM-DD" strings.
5. "limit" controls how many rows to return — use what the question implies, default 50.
6. Return ONLY the JSON object — no markdown fences, no explanation, no comments.
7. Never select the same leaf column name twice (e.g. avoid selecting LOAN_ID and assocAlias.LOAN_ID in the same query — pick one).
8. If a column's schema entry says "readable text available via X" (a @Common.Text value-help column) and the question refers to the value by its human meaning (e.g. "active", "closed", "expired") rather than a raw code you already know, do NOT guess the raw code. Instead filter on the text association path directly using "like", e.g. {"col": "status.TEXT", "op": "like", "val": "Active"} — this is reliable regardless of what the underlying raw code actually is.
9. Do NOT add extra filters, conditions, joins, or business assumptions that the user did not ask for. Prefer the minimum query that answers the question.
10. Words like "active", "closed", or "expired" usually describe a status value only. Do NOT infer overdue payments, arrears, missed instalments, dunning, or delinquency unless the question explicitly asks for them.
11. If the question asks for "active loans with customer name and loan amount", that means filter loan status to active and select the customer name and loan amount. It does NOT imply any payment-status filter such as payments.DAYS_OVERDUE > 0.
12. Before picking "entity", check that every column/path you plan to use in select/where/orderBy is actually reachable from it via that entity's own "assoc:" list (directly, or hop by hop). If a needed column lives on an entity that only has an association TO your candidate entity (not FROM it), start from that other entity instead — never invent an association alias that isn't listed, and never substitute an unrelated column when the right path doesn't exist on your first choice of entity.
13. Entities/columns may show a short text after "—" (a description) and/or "(aka: ...)" (alternate business terms/synonyms). Use these to resolve ambiguous wording in the question to the correct column — e.g. if the question says "debt to income" and a column lists "(aka: debt to income, debt-to-income ratio)", that column is the match even though its name (e.g. "DTI") doesn't literally contain those words.

SCHEMA:
${schemaText}`;

/**
 * Translates a natural language question into a CDS query descriptor using
 * a directly-configured LLM provider (Anthropic or OpenAI-compatible).
 *
 * Bring your own model — set ANTHROPIC_API_KEY or OPENAI_API_KEY (+ optional
 * OPENAI_BASE_URL for Azure/Ollama/Groq/local LLMs) in the .mcp.json env block.
 *
 * callConfig.provider / callConfig.apiKey can override the server defaults per call.
 */
async function planQuery(question, schemaText, callConfig = {}) {
  const prompt = `${SYSTEM_PROMPT(schemaText)}\n\nQuestion: ${question}`;

  const provider = callConfig.provider || serverConfig.llmProvider;

  if (provider === 'anthropic') {
    const apiKey = callConfig.apiKey || serverConfig.anthropicApiKey;
    if (!apiKey) throw new Error('LLM_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set.');
    return planWithAnthropic(prompt, apiKey);
  }

  if (provider === 'openai') {
    const apiKey = callConfig.apiKey || serverConfig.openaiApiKey;
    if (!apiKey) throw new Error('LLM_PROVIDER is "openai" but OPENAI_API_KEY is not set.');
    return planWithOpenAI(prompt, apiKey);
  }

  throw new Error(
    'No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY ' +
    '(or OPENAI_BASE_URL for an OpenAI-compatible endpoint) in your .mcp.json env block.'
  );
}

// Resolve from the caller's CAP project root first — when this package runs via
// `npx`, it executes from npx's cache directory, completely separate from the
// consumer's project node_modules. A plain require() would miss a hoisted install
// there. Same fix already applied to @sap/cds in mcp-server.js/query-executor.js.
function resolveOptionalDep(pkgName) {
  try { return require(require.resolve(pkgName, { paths: [process.cwd()] })); }
  catch { return require(pkgName); }
}

async function planWithAnthropic(prompt, apiKey) {
  let Anthropic;
  try { Anthropic = resolveOptionalDep('@anthropic-ai/sdk'); }
  catch {
    throw new Error('@anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk');
  }

  const client = new Anthropic.default({ apiKey });
  const msg = await client.messages.create({
    model:      serverConfig.anthropicModel,
    max_tokens: 800,
    messages:   [{ role: 'user', content: prompt }],
  });
  return extractJson(msg.content[0]?.text || '');
}

async function planWithOpenAI(prompt, apiKey) {
  let OpenAI;
  try { OpenAI = resolveOptionalDep('openai'); }
  catch {
    throw new Error('openai package not installed. Run: npm install openai');
  }

  const client = new OpenAI.default({
    apiKey,
    baseURL: serverConfig.openaiBaseUrl || undefined,
  });
  const completion = await client.chat.completions.create({
    model:    serverConfig.openaiModel,
    messages: [{ role: 'user', content: prompt }],
  });
  return extractJson(completion.choices[0]?.message?.content || '');
}

/** Extracts the first balanced JSON object from a freeform LLM response. */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if      (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  return null;
}

module.exports = { planQuery };
