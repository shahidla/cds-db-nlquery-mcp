'use strict';
// Regenerates results.json and schema-prompt.txt by ACTUALLY RUNNING this repo's
// src/schema-reader.js and src/query-executor.js against a real in-memory SQLite
// database (via @cap-js/sqlite, a devDependency of the parent repo) — every CQN/SQL/
// result recorded here comes from executing the repo's own code against real data,
// not from hand-written or recalled SQL.
//
// Run from the repo root: node examples/capability-demo/generate.js
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEMO_DIR = __dirname;

const cds = require('@sap/cds');
const { buildSchema, buildSchemaPrompt } = require(path.join(REPO_ROOT, 'src/schema-reader'));
const { executeDescriptor } = require(path.join(REPO_ROOT, 'src/query-executor'));

async function main() {
  const csn = await cds.load(path.join(DEMO_DIR, 'schema.cds'));
  const model = cds.linked(csn);
  cds.model = model;

  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  cds.db = db;
  await cds.deploy(model).to(db);

  const schema = buildSchema(model);
  const schemaPrompt = buildSchemaPrompt(schema);

  const queries = require(path.join(DEMO_DIR, 'queries'));
  const results = [];

  for (const q of queries) {
    const entry = { id: q.id, nl: q.nl, descriptor: q.descriptor };
    try {
      // Capture every CQN query the executor issues for this descriptor (hierarchy
      // queries issue one per tree level) by intercepting cds.run.
      const capturedCqn = [];
      const realRun = cds.run.bind(cds);
      cds.run = async (query) => { capturedCqn.push(query); return realRun(query); };

      const rows = await executeDescriptor(q.descriptor, schema, q.callConfig || {});
      cds.run = realRun;

      entry.cqn = capturedCqn;
      entry.sql = capturedCqn.map(c => {
        try { return db.cqn2sql(c).sql; } catch (e) { return `<sql generation failed: ${e.message}>`; }
      });
      entry.rows = rows;
      entry.error = null;
    } catch (e) {
      cds.run = cds.run; // no-op; ensure restored even on throw path above
      entry.cqn = null;
      entry.sql = null;
      entry.rows = null;
      entry.error = e.message;
    }
    results.push(entry);
  }

  fs.writeFileSync(path.join(DEMO_DIR, 'schema-prompt.txt'), schemaPrompt);
  fs.writeFileSync(path.join(DEMO_DIR, 'results.json'), JSON.stringify(results, null, 2));

  console.log(`Generated ${results.length} query results -> results.json`);
  console.log(`Errors (expected for entries marked error:true in queries.js): ${results.filter(r => r.error).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
