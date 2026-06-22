'use strict';
// The other scripts in this folder (validate-deployment.js, ask.js, ask-batch.js)
// all call this package's internal functions directly via require() — they never
// exercise the actual published artifact: src/mcp-server.js, spoken to over the
// real MCP stdio/JSON-RPC protocol, the way a real consumer (Claude Code, Claude
// Desktop, `npx -y @shahid.la/cds-db-nlquery-mcp`) actually invokes it. This
// script closes that gap — it spawns the server as a real child process and
// drives it through the @modelcontextprotocol/sdk Client, the same way
// Banking-Sentinel's srv/agents/simple-query.js does in production.
//
// Prerequisite: same as validate-deployment.js — your project must already be
// connected to a deployed examples/capability-demo schema.
//
// Run: node <path-to-this-file>/smoke-test-server.js

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER_ENTRY = path.join(__dirname, '..', '..', 'src', 'mcp-server.js');

const QUESTIONS = [
  'How many orders does each customer have, and what is the total amount?',
  'Show me all descendants of account A1',
  'Show me each order with its line items nested inside',
];

async function main() {
  const client = new Client({ name: 'smoke-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    cwd: process.cwd(), // the real consumer project — same as a real .mcp.json "cwd"
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => process.stderr.write(`[server] ${chunk}`));

  await client.connect(transport);
  console.log('Connected to MCP server over stdio.\n');

  const tools = await client.listTools();
  console.log(`Tools advertised: ${tools.tools.map(t => t.name).join(', ')}\n`);

  let failed = 0;
  for (const question of QUESTIONS) {
    console.log(`--- "${question}" ---`);
    try {
      const result = await client.callTool({ name: 'natural_language_query', arguments: { question } });
      const text = (result.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (result.isError) {
        console.log('Tool returned an error:', text);
        failed++;
      } else {
        console.log(text.slice(0, 500));
      }
    } catch (e) {
      console.log('Call failed:', e.message);
      failed++;
    }
    console.log('');
  }

  await client.close();
  console.log(failed ? `${failed} of ${QUESTIONS.length} questions failed.` : 'All questions answered without error.');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
