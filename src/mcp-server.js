#!/usr/bin/env node
'use strict';

const { Server }               = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Resolve @sap/cds from the caller's CAP project root so their @sap/hana-client
// and other platform-specific adapters are found. Falls back to local install.
const cds = (() => {
  try { return require(require.resolve('@sap/cds', { paths: [process.cwd()] })); }
  catch { return require('@sap/cds'); }
})();

const serverConfig                       = require('./config');
const { buildSchema, buildSchemaPrompt, hasNameCollisions } = require('./schema-reader');
const { planQuery }                      = require('./llm-planner');
const { executeDescriptor }              = require('./query-executor');

// ── Bootstrap ────────────────────────────────────────────────────────────────

let schema     = null;
let schemaText = null;

async function bootstrap() {
  // cds.linked() adds isAssociation/isComposition flags required by schema-reader.
  // cds.model must be set before cds.connect.to('db') so cds.db registers correctly.
  cds.model = cds.linked(await cds.load(serverConfig.modelPath));

  // Fail loudly on a half-configured restricted-user setup rather than silently
  // falling back to the consumer app's full-access connection — a partially set
  // MCP_DB_USER/MCP_DB_PASSWORD (typo, missing secret) must never degrade into
  // "use the unrestricted default" without the operator noticing.
  if (Boolean(serverConfig.dbUser) !== Boolean(serverConfig.dbPassword)) {
    throw new Error(
      'MCP_DB_USER and MCP_DB_PASSWORD must both be set, or neither. ' +
      'Only one was provided — refusing to start rather than silently falling back ' +
      'to the default (likely full-access) database connection.'
    );
  }

  if (serverConfig.dbUser && serverConfig.dbPassword) {
    // Connect with a different (ideally restricted, read-only) user than the
    // consumer app's own runtime user — reuse host/port/schema from the project's
    // existing DB config, override only user/password.
    const baseCreds = cds.env.requires?.db?.credentials || {};
    await cds.connect.to('db', {
      kind: baseCreds.kind || 'hana',
      credentials: { ...baseCreds, user: serverConfig.dbUser, password: serverConfig.dbPassword },
    });
  } else {
    await cds.connect.to('db');
  }

  schema     = buildSchema(cds.model);
  schemaText = buildSchemaPrompt(schema);

  const entityCount = Object.keys(schema).length;
  process.stderr.write(`[cds-db-nlquery-mcp] Schema loaded — ${entityCount} entities\n`);

  if (entityCount === 0) {
    process.stderr.write('[cds-db-nlquery-mcp] WARNING: No entities found. Run from your CAP project root.\n');
  }
  if (hasNameCollisions(cds.model)) {
    process.stderr.write(
      '[cds-db-nlquery-mcp] WARNING: multiple entities share the same short name across ' +
      'different namespaces. The colliding entities are addressed by their fully-qualified ' +
      'name (e.g. "sales.Order") instead of the short name, to avoid silently querying the ' +
      'wrong one. Check the schema (list_entities) if a query seems to be using an ' +
      'unexpectedly qualified entity name.\n'
    );
  }
  if (serverConfig.allowedEntities.length === 0) {
    process.stderr.write(
      '[cds-db-nlquery-mcp] WARNING: MCP_ALLOWED_ENTITIES not set — all entities are queryable. ' +
      'Set MCP_ALLOWED_ENTITIES in your .mcp.json env block for production use.\n'
    );
  } else {
    process.stderr.write(
      `[cds-db-nlquery-mcp] Allowed entities: ${serverConfig.allowedEntities.join(', ')}\n`
    );
  }
  if (serverConfig.blockedColumns.length > 0) {
    process.stderr.write(
      `[cds-db-nlquery-mcp] Blocked columns: ${serverConfig.blockedColumns.join(', ')}\n`
    );
  }
  if (serverConfig.dbUser) {
    process.stderr.write(`[cds-db-nlquery-mcp] DB user: ${serverConfig.dbUser} (MCP_DB_USER override)\n`);
  } else {
    process.stderr.write(
      '[cds-db-nlquery-mcp] WARNING: MCP_DB_USER not set — using the project\'s default DB ' +
      'connection (likely the main app\'s full-access user). Set MCP_DB_USER/MCP_DB_PASSWORD ' +
      'to a restricted read-only user for production use.\n'
    );
  }
  if (serverConfig.llmProvider) {
    process.stderr.write(`[cds-db-nlquery-mcp] LLM provider: ${serverConfig.llmProvider}\n`);
  } else {
    process.stderr.write(
      '[cds-db-nlquery-mcp] WARNING: No LLM provider configured. ' +
      'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your .mcp.json env block — ' +
      'natural_language_query will fail until one is set.\n'
    );
  }
}

// ── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'cds-db-nlquery-mcp', version: '0.5.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'natural_language_query',
      description: [
        'Query CDS db-layer entities using natural language.',
        'Targets raw db/schema.cds entities via cds.run() — NOT OData service entities.',
        'Uses CDS association path expressions for real SQL JOINs (scales to billions of rows).',
        'Returns an array of matching rows.',
        'Note: bypasses CAP service-layer authorization — ensure MCP_ALLOWED_ENTITIES is set for production.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type:        'string',
            description: 'Natural language question, e.g. "Which customers have a DTI above 5?"',
          },
          allowed_entities: {
            type:        'array',
            items:       { type: 'string' },
            description: [
              'Restrict this query to these entity names (intersects with server MCP_ALLOWED_ENTITIES).',
              'Useful when the caller wants to limit scope further than the server default.',
              'Example: ["Customers", "Orders"]',
            ].join(' '),
          },
          blocked_columns: {
            type:        'array',
            items:       { type: 'string' },
            description: [
              'Column names to exclude from results for this call (adds to server MCP_BLOCKED_COLUMNS).',
              'Example: ["SALARY", "CREDIT_SCORE"]',
            ].join(' '),
          },
          max_rows: {
            type:        'integer',
            minimum:     1,
            maximum:     10000,
            description: 'Maximum rows to return for this call (cannot exceed server MCP_MAX_ROWS). Default: 50.',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'list_entities',
      description: [
        'List all queryable CDS db-layer entities, their columns, and available associations.',
        'Use this to explore the schema before querying.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!schema) {
    return { content: [{ type: 'text', text: 'Schema not loaded yet — CDS model is still initialising.' }] };
  }

  // ── list_entities ──────────────────────────────────────────────────────────
  if (name === 'list_entities') {
    const lines = Object.entries(schema).map(([n, def]) => {
      const cols  = Object.keys(def.columns).join(', ');
      const assocs = Object.entries(def.joins || {})
        .map(([alias, j]) => `${alias}→${j.entity}`)
        .join(', ');
      return assocs
        ? `${n} [${def.label}]\n  columns: ${cols}\n  assoc: ${assocs}`
        : `${n} [${def.label}]\n  columns: ${cols}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }

  // ── natural_language_query ─────────────────────────────────────────────────
  if (name === 'natural_language_query') {
    const { question, allowed_entities, blocked_columns, max_rows } = args;

    if (!question?.trim()) {
      return { content: [{ type: 'text', text: 'question is required' }], isError: true };
    }

    // Per-call config — merged with server config inside executor/planner
    const callConfig = {
      allowedEntities: allowed_entities || [],
      blockedColumns:  blocked_columns  || [],
      maxRows:         max_rows         || Infinity,
    };

    let descriptor;
    try {
      descriptor = await planQuery(question, schemaText, callConfig);
      if (!descriptor?.entity) throw new Error('LLM did not return a valid entity descriptor');
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Query planning failed: ${e.message}` }],
        isError: true,
      };
    }

    process.stderr.write(`[cds-db-nlquery-mcp] ── Descriptor ──────────────────\n`);
    process.stderr.write(`  entity : ${descriptor.entity}\n`);
    if (descriptor.select) process.stderr.write(`  select : ${descriptor.select.join(', ')}\n`);
    (descriptor.where || []).forEach(w =>
      process.stderr.write(`  where  : ${w.col} ${w.op} ${JSON.stringify(w.val)}\n`)
    );
    if (descriptor.orderBy) process.stderr.write(`  order  : ${descriptor.orderBy} ${descriptor.orderDir || 'ASC'}\n`);
    process.stderr.write(`  limit  : ${descriptor.limit || 50}\n`);
    if (callConfig.allowedEntities.length) process.stderr.write(`  call-allowed : ${callConfig.allowedEntities.join(', ')}\n`);
    if (callConfig.blockedColumns.length)  process.stderr.write(`  call-blocked : ${callConfig.blockedColumns.join(', ')}\n`);
    process.stderr.write(`[cds-db-nlquery-mcp] ──────────────────────────────────\n`);

    let rows;
    try {
      rows = await executeDescriptor(descriptor, schema, callConfig);
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Query execution failed: ${e.message}` }],
        isError: true,
      };
    }

    process.stderr.write(`[cds-db-nlquery-mcp] → ${rows.length} rows returned\n`);

    const instructions = [
      'IMPORTANT — formatting instructions for presenting the data below:',
      '1. Use a vertical "Field: value" list per record, one field per line. Do NOT use a markdown table — no "|" characters, no "|---|" separator rows.',
      '2. Every field shown below came directly from the query. Never say a value is "not provided" — if you cannot find a field you expected, it simply was not selected; do not claim it is missing from the data.',
      '3. If a field has a matching "<col>_text" key (e.g. STATUS and STATUS_text), show the "_text" value, not the raw code.',
    ].join('\n');

    return {
      content: [
        { type: 'text', text: instructions },
        { type: 'text', text: JSON.stringify({ question, rowCount: rows.length, rows }, null, 2) },
      ],
    };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  await bootstrap();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[cds-db-nlquery-mcp] Ready (stdio)\n');
}

main().catch(err => {
  process.stderr.write(`[cds-db-nlquery-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
