'use strict';

function parseList(envVar) {
  return envVar
    ? envVar.split(',').map(s => s.trim()).filter(Boolean)
    : [];
}

/**
 * Server-level configuration — read once at startup from environment.
 * Set these via the .mcp.json "env" block, not the consumer project's .env.
 *
 * MCP_MODEL_PATH        — path to the CDS model folder/file (default: "db").
 *                          Change if your schema is at "model/", "srv/", etc.
 * MCP_ALLOWED_ENTITIES  — comma-separated entity short names that are queryable.
 *                          Empty = all entities accessible (warns at startup).
 *                          Recommended for production: set explicitly.
 * MCP_BLOCKED_COLUMNS   — comma-separated column names never returned (e.g. EMBEDDING,PASSWORD).
 * MCP_MAX_ROWS          — hard SQL LIMIT cap per query (default 500).
 * MCP_MAX_OFFSET        — hard cap on pagination offset (default 100000), to bound
 *                          deep-pagination table scans against the DB.
 * MCP_MAX_EXPAND_ROWS    — hard cap on child rows per "expand" nesting level (default 20),
 *                          so a parent page of MCP_MAX_ROWS rows can't fan out into an
 *                          unbounded number of child rows per parent.
 * MCP_DB_USER/MCP_DB_PASSWORD — connect with a different (ideally restricted, read-only)
 *                          HANA user than the consumer app's own runtime user. Host/port/
 *                          schema are reused from the project's existing DB config —
 *                          only user/password are overridden. Recommended for production:
 *                          create a dedicated read-only user and use it here instead of
 *                          inheriting the main app's full-access credentials.
 *
 * LLM provider — bring your own model. Pick ONE:
 *   LLM_PROVIDER        — "anthropic" | "openai". Auto-detected from which API key is set if omitted.
 *   ANTHROPIC_API_KEY    + ANTHROPIC_MODEL  (default: claude-haiku-4-5-20251001)
 *   OPENAI_API_KEY       + OPENAI_MODEL     (default: gpt-4o-mini)
 *                        + OPENAI_BASE_URL  — point at any OpenAI-compatible endpoint
 *                          (Azure OpenAI, Ollama, Groq, local LLMs, etc.)
 */
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || null;
const openaiApiKey    = process.env.OPENAI_API_KEY    || null;

module.exports = {
  modelPath:       process.env.MCP_MODEL_PATH || 'db',
  allowedEntities: parseList(process.env.MCP_ALLOWED_ENTITIES),
  blockedColumns:  parseList(process.env.MCP_BLOCKED_COLUMNS),
  maxRows:         parseInt(process.env.MCP_MAX_ROWS || '500', 10),
  maxOffset:       parseInt(process.env.MCP_MAX_OFFSET || '100000', 10),
  maxExpandRows:   parseInt(process.env.MCP_MAX_EXPAND_ROWS || '20', 10),
  dbUser:          process.env.MCP_DB_USER || null,
  dbPassword:      process.env.MCP_DB_PASSWORD || null,

  llmProvider: process.env.LLM_PROVIDER
    || (anthropicApiKey ? 'anthropic' : openaiApiKey ? 'openai' : null),

  anthropicApiKey,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',

  openaiApiKey,
  openaiModel:   process.env.OPENAI_MODEL   || 'gpt-4o-mini',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || null,
};
