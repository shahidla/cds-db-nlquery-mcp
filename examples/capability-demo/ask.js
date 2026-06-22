'use strict';
// Full end-to-end manual test: real NL question -> real LLM call (planQuery) ->
// real descriptor -> real executeDescriptor() against WHATEVER database your CAP
// project is connected to. Unlike validate-deployment.js (which bypasses the LLM
// with hand-written descriptors), this exercises Stage 1 (question -> descriptor)
// too — useful for trying your own questions against your own schema/data.
//
// Prerequisite: same as validate-deployment.js — deploy schema.cds + data/*.csv
// to your target database, and have your project's cds config pointing at it.
//
// Run: node <path-to-this-file>/ask.js "Which loans have a DTI above 50?"
// Pick a provider per-run instead of relying on env-var auto-detection:
//   node ask.js --provider=anthropic "..."   (needs ANTHROPIC_API_KEY)
//   node ask.js --provider=openai "..."      (needs OPENAI_API_KEY; also how
//                                              DeepSeek/Groq/any OpenAI-compatible
//                                              endpoint connects, via OPENAI_BASE_URL)

const path = require('path');
// Resolve @sap/cds from the consuming project's root, not this script's own
// location — see validate-deployment.js for why (two different module
// instances otherwise, and connecting one never connects the other).
const cds = (() => {
  try { return require(require.resolve('@sap/cds', { paths: [process.cwd()] })); }
  catch { return require('@sap/cds'); }
})();

const { buildSchema, buildSchemaPrompt } = require(path.join(__dirname, '..', '..', 'src', 'schema-reader'));
const { executeDescriptor } = require(path.join(__dirname, '..', '..', 'src', 'query-executor'));
const { planQuery } = require(path.join(__dirname, '..', '..', 'src', 'llm-planner'));

async function run() {
  const args = process.argv.slice(2);
  const providerArg = args.find(a => a.startsWith('--provider='));
  const provider = providerArg?.split('=')[1];
  const question = args.filter(a => !a.startsWith('--provider=')).join(' ');
  if (!question) {
    console.error('Usage: node ask.js [--provider=anthropic|openai] "your natural language question"');
    process.exit(1);
  }

  cds.model = cds.linked(await cds.load('db'));
  await cds.connect.to('db');
  const schema = buildSchema(cds.model);
  const schemaText = buildSchemaPrompt(schema);

  console.log(`\nQuestion: "${question}"${provider ? ` (provider: ${provider})` : ''}\n`);

  const callConfig = {};
  if (provider === 'anthropic') { callConfig.provider = 'anthropic'; callConfig.apiKey = process.env.ANTHROPIC_API_KEY; }
  if (provider === 'openai') { callConfig.provider = 'openai'; callConfig.apiKey = process.env.OPENAI_API_KEY; }

  const descriptor = await planQuery(question, schemaText, callConfig);
  console.log('--- Descriptor from LLM ---');
  console.log(JSON.stringify(descriptor, null, 2));

  console.log('\n--- Executing against your database ---');
  try {
    const rows = await executeDescriptor(descriptor, schema);
    console.log(`${rows.length} row(s):`);
    console.log(JSON.stringify(rows, null, 2));
  } catch (e) {
    console.log('Execution failed:', e.message);
  }

  process.exit(0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
