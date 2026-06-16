'use strict';

const SYSTEM_PROMPT = (schemaText) => `You are a query planner for a CDS (SAP Cloud Application Programming Model) database.

BACKEND:
- Database: SAP HANA Cloud (or SQLite in dev)
- Query layer: SAP CAP / CDS — you do NOT write SQL
- You output a JSON descriptor. The framework builds CDS queries from it.

YOUR JOB: Translate the user's natural language question into a JSON query descriptor.

DESCRIPTOR FORMAT:
{
  "entity":   "<entity name from schema>",
  "join":     "<join alias from entity's joins list>" or null,
  "select":   ["COL", "alias.COL", ...] or null,
  "where":    [{ "col": "COL or alias.COL", "op": "...", "val": ... }],
  "orderBy":  "COL" or null,
  "orderDir": "ASC" | "DESC",
  "limit":    50
}

JOIN TYPES (declared in schema, applied automatically — do not specify):
  INNER = mandatory relationship (both sides guaranteed to exist)
  LEFT  = optional relationship (main row kept even with no join match)

OPERATORS:
  "="  "!="  ">"  "<"  ">="  "<="  — standard comparison
  "like"        — case-insensitive string contains
  "within_days" — date is between today and today+N days (use for expiry/maturity dates)
  "days_ago"    — date fell within the last N days

RULES:
1. Use ONLY entity names and column names from the schema below.
2. To reference a joined entity's column in select or where: "alias.COLUMN"
3. One join maximum per query.
4. Boolean columns: pass val as true or false (not "true").
5. Return ONLY the JSON object — no markdown, no explanation.

SCHEMA:
${schemaText}`;

/**
 * Uses MCP sampling to ask the host client (Claude) to translate a
 * natural language question into a query descriptor JSON.
 *
 * Falls back to direct Anthropic API call if ANTHROPIC_API_KEY is set
 * and the host doesn't support sampling.
 */
async function planQuery(question, schemaText, mcpServer) {
  const prompt = `${SYSTEM_PROMPT(schemaText)}\n\nQuestion: ${question}`;

  // Primary: MCP sampling — host client (Claude) does the LLM call
  try {
    const result = await mcpServer.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
      maxTokens: 800,
    });
    return extractJson(result.content?.text || '');
  } catch (samplingErr) {
    // Fallback: direct Anthropic API call if API key is available
    if (process.env.ANTHROPIC_API_KEY) {
      return await planWithAnthropicApi(prompt);
    }
    throw new Error(
      `MCP sampling failed and no ANTHROPIC_API_KEY set. ` +
      `Either use a sampling-capable MCP client (Claude) or set ANTHROPIC_API_KEY. ` +
      `Sampling error: ${samplingErr.message}`
    );
  }
}

async function planWithAnthropicApi(prompt) {
  // Lazy-require to avoid hard dependency — only used as fallback
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { throw new Error('Install @anthropic-ai/sdk or use a sampling-capable MCP client'); }

  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model:      process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages:   [{ role: 'user', content: prompt }],
  });
  return extractJson(msg.content[0]?.text || '');
}

/** Extracts the first balanced JSON object from a string */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  return null;
}

module.exports = { planQuery };
