#!/usr/bin/env node
'use strict';

const { Server }              = require('@modelcontextprotocol/sdk/server/index.js');
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
const { buildSchema, buildSchemaPrompt } = require('./schema-reader');
const { planQuery }                      = require('./llm-planner');
const { executeDescriptor }              = require('./query-executor');

// ── Bootstrap ────────────────────────────────────────────────────────────────

let schema     = null; // populated once CDS model is loaded
let schemaText = null;

async function bootstrap() {
  // Load + link the CDS model from the project in the current working directory.
  // cds.load() returns raw CSN (associations have type:'cds.Association' but no isAssociation flag).
  // cds.linked() adds isAssociation/isComposition flags needed by schema-reader.
  // Must set cds.model before cds.connect.to('db') so CDS registers cds.db as primary datasource.
  cds.model = cds.linked(await cds.load('db'));
  await cds.connect.to('db');
  schema     = buildSchema(cds.model);
  schemaText = buildSchemaPrompt(schema);

  const entityCount = Object.keys(schema).length;
  process.stderr.write(`[cds-db-nlquery-mcp] Schema loaded — ${entityCount} entities\n`);
  if (entityCount === 0) {
    process.stderr.write('[cds-db-nlquery-mcp] WARNING: No entities found. Run from your CAP project root.\n');
  }
}

// ── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'cds-db-nlquery-mcp', version: '0.1.0' },
  { capabilities: { tools: {}, sampling: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name:        'natural_language_query',
      description: [
        'Query CDS db-layer entities using natural language.',
        'Targets raw db/schema.cds entities via cds.run() — NOT OData service entities.',
        'Supports cross-entity joins, analytical conditions, and HANA-native operators.',
        'Returns an array of matching rows.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type:        'string',
            description: 'Natural language question about your data, e.g. "Which customers have a DTI above 5?"',
          },
        },
        required: ['question'],
      },
    },
    {
      name:        'list_entities',
      description: 'List all queryable CDS db-layer entities and their columns. Useful for exploring the schema before querying.',
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
      const cols = Object.keys(def.columns).join(', ');
      return `${n}: ${cols}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── natural_language_query ─────────────────────────────────────────────────
  if (name === 'natural_language_query') {
    const { question } = args;
    if (!question?.trim()) {
      return { content: [{ type: 'text', text: 'question is required' }], isError: true };
    }

    let descriptor;
    try {
      descriptor = await planQuery(question, schemaText, server);
      if (!descriptor?.entity) throw new Error('LLM did not return a valid descriptor');
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Query planning failed: ${e.message}` }],
        isError: true,
      };
    }

    // Log descriptor to stderr (visible in Claude Code terminal, not sent to client)
    process.stderr.write(`[cds-db-nlquery-mcp] ── Descriptor ──────────────────\n`);
    process.stderr.write(`  entity : ${descriptor.entity}\n`);
    if (descriptor.join)    process.stderr.write(`  join   : "${descriptor.join}"\n`);
    if (descriptor.select)  process.stderr.write(`  select : ${descriptor.select.join(', ')}\n`);
    (descriptor.where || []).forEach(w =>
      process.stderr.write(`  where  : ${w.col} ${w.op} ${JSON.stringify(w.val)}\n`)
    );
    if (descriptor.orderBy) process.stderr.write(`  order  : ${descriptor.orderBy} ${descriptor.orderDir || 'ASC'}\n`);
    process.stderr.write(`  limit  : ${descriptor.limit || 50}\n`);
    process.stderr.write(`[cds-db-nlquery-mcp] ──────────────────────────────────\n`);

    let rows;
    try {
      rows = await executeDescriptor(descriptor, schema);
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Query execution failed: ${e.message}` }],
        isError: true,
      };
    }

    process.stderr.write(`[cds-db-nlquery-mcp] → ${rows.length} rows returned\n`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ question, rowCount: rows.length, rows }, null, 2),
      }],
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
