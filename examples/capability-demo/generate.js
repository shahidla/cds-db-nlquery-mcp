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

// Turns a parameterized SQL string + its bind values (both straight from
// db.cqn2sql()) into a single self-contained, human-readable statement —
// literal values substituted in place of "?", and keywords broken onto
// their own lines. For eyeballing/comparing against a BTP deployment by hand,
// not for re-execution (the literal-substitution here is not SQL-injection-safe
// and must never be used to build a query that actually runs).
function sqlLiteral(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

function toReadableSql(sql, values) {
  // Break onto separate lines on the placeholder-only SQL (so " and "/" or "
  // splitting can never misfire on a literal value's text), THEN inline the
  // actual bind values — order matters.
  const broken = sql
    .replace(/\bFROM\b/g, '\nFROM')
    .replace(/\bWHERE\b/g, '\nWHERE')
    .replace(/\bGROUP BY\b/g, '\nGROUP BY')
    .replace(/\bHAVING\b/g, '\nHAVING')
    .replace(/\bORDER BY\b/g, '\nORDER BY')
    .replace(/\bLIMIT\b/g, '\nLIMIT')
    .replace(/ and /g, '\n  AND ')
    .replace(/ or /g, '\n  OR ');
  let i = 0;
  return broken.replace(/\?/g, () => sqlLiteral(values[i++]));
}

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
    // Declared OUTSIDE the try block (not "const realRun" inside it) so the catch
    // block below can actually see it — a try block's const/let declarations are
    // not visible in its own catch block. This is exactly why the original code
    // wrote the no-op `cds.run = cds.run` in catch instead of `cds.run = realRun`:
    // that reference genuinely wasn't in scope there as originally structured.
    const realRun = cds.run.bind(cds);
    try {
      // Capture every CQN query the executor issues for this descriptor (hierarchy
      // queries issue one per tree level) by intercepting cds.run.
      const capturedCqn = [];
      cds.run = async (query) => { capturedCqn.push(query); return realRun(query); };

      const rows = await executeDescriptor(q.descriptor, schema, q.callConfig || {});
      cds.run = realRun;

      entry.cqn = capturedCqn;
      entry.sql = capturedCqn.map(c => {
        try { return db.cqn2sql(c).sql; } catch (e) { return `<sql generation failed: ${e.message}>`; }
      });
      entry.readableSql = capturedCqn.map(c => {
        try {
          const { sql, values } = db.cqn2sql(c);
          return toReadableSql(sql, values);
        } catch (e) { return `<sql generation failed: ${e.message}>`; }
      });
      entry.rows = rows;
      entry.error = null;
    } catch (e) {
      cds.run = realRun; // restore even on the throw path above — found via ESLint's
      // no-self-assign rule: this was `cds.run = cds.run` (a no-op) instead, so any
      // descriptor that threw left cds.run wrapped for every subsequent iteration —
      // each one would then capture through a compounding chain of stale wrappers
      // instead of the true original. No actual row-data corruption (each wrapper
      // still delegates through to the real cds.run eventually), but the captured
      // cqn/sql for later entries could include leftover capture-array references
      // from earlier iterations. First real catch from adding lint to this repo.
      entry.cqn = null;
      entry.sql = null;
      entry.readableSql = null;
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
