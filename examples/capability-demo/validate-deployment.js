'use strict';
// Runs every entry in queries.js through this package's real executeDescriptor()
// against WHATEVER database your CAP project is currently connected to (HANA on
// BTP, or anywhere else) — not the in-memory SQLite used by generate.js — and
// compares the result against results.json (generated against SQLite). This is
// the actual implementation of the "How to use this to validate a deployed app"
// workflow described in README.md.
//
// Prerequisite: deploy schema.cds + data/*.csv to your target database first
// (e.g. `cds deploy --to hana` from a CAP project wrapping this folder), and make
// sure your project's cds config (.cdsrc.json / .cdsrc-private.json / bound
// service) points at it.
//
// Run from a CAP project connected to your deployment:
//   node <path-to-this-file>/validate-deployment.js
//
// If you're on the LEGACY @sap/hana-client runtime (not the modern @cap-js/hana
// adapter), 4 entries are confirmed to fail there — see README.md's adapter
// comparison section. Set LEGACY_HANA_CLIENT=true to treat those as expected
// limitations instead of failures:
//   LEGACY_HANA_CLIENT=true node validate-deployment.js

const path = require('path');
// Resolve @sap/cds from the consuming project's root (process.cwd()), not from
// this script's own location — otherwise this script's "cds" and
// query-executor.js's internally-resolved "cds" (see src/query-executor.js's own
// top-of-file comment) end up being two DIFFERENT module instances, and
// connecting one never connects the other ("Not connected to primary
// datasource!" even though cds.connect.to('db') above appeared to succeed).
const cds = (() => {
  try { return require(require.resolve('@sap/cds', { paths: [process.cwd()] })); }
  catch { return require('@sap/cds'); }
})();

const { buildSchema } = require(path.join(__dirname, '..', '..', 'src', 'schema-reader'));
const { executeDescriptor } = require(path.join(__dirname, '..', '..', 'src', 'query-executor'));
const queries = require(path.join(__dirname, 'queries.js'));
const expectedArr = require(path.join(__dirname, 'results.json'));
const expected = Object.fromEntries(expectedArr.map(e => [e.id, e]));

// HANA's driver returns Decimal columns as strings ("1500.00") to preserve
// precision; SQLite's driver returns JS numbers (1500). Same value, different
// driver representation — normalize numeric-looking strings before comparing so
// this doesn't masquerade as a real row mismatch.
function normVal(v) {
  if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}
// Recurse into every nested value (an "expand" result is a tree, not a flat row) —
// a comparator that only normalizes top-level keys will report an "expand" query
// as a mismatch even when its data is genuinely correct at a deeper level.
function deepNormVal(v) {
  if (Array.isArray(v)) return v.map(deepNormVal);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, deepNormVal(x)]).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return normVal(v);
}
function rowsEqual(a, b) {
  if (a.length !== b.length) return false;
  const norm = rows => rows.map(r => JSON.stringify(deepNormVal(r))).sort();
  const na = norm(a), nb = norm(b);
  return na.every((v, i) => v === nb[i]);
}

// Entries confirmed to be rejected specifically on the legacy @sap/hana-client
// runtime, but confirmed to work correctly (real, mathematically-verified
// results) on the modern @cap-js/hana adapter. See README.md for the full
// before/after comparison and root causes.
const KNOWN_BACKEND_LIMITATIONS = process.env.LEGACY_HANA_CLIENT === 'true' ? {
  'new-04-via-filtered-aggregate': /viaFiltered is not supported as an "aggregate" or "having" column/,
  'new-05-window-rank-per-partition': /window.*functions are not supported against this database connection/,
  'new-06-window-filter-top-n-per-group': /window.*functions are not supported against this database connection/,
  'new-07-window-running-total': /window.*functions are not supported against this database connection/,
} : {};

async function run() {
  cds.model = cds.linked(await cds.load('db'));
  await cds.connect.to('db');
  const schema = buildSchema(cds.model);

  console.log(`\n=== Validating ${queries.length} capability-demo queries against your deployment ===\n`);

  let pass = 0, fail = 0, skip = 0, limitation = 0;

  for (const entry of queries) {
    const exp = expected[entry.id];
    if (!exp) { console.log(`SKIP  ${entry.id} — no expected result found`); skip++; continue; }

    if (KNOWN_BACKEND_LIMITATIONS[entry.id]) {
      try {
        await executeDescriptor(entry.descriptor, schema, entry.callConfig || {});
        console.log(`FAIL  ${entry.id} — expected a known-limitation rejection but query succeeded`);
        fail++;
      } catch (e) {
        if (KNOWN_BACKEND_LIMITATIONS[entry.id].test(e.message)) {
          console.log(`LIMIT ${entry.id} — known HANA-runtime limitation, correctly rejected: ${e.message.slice(0, 80)}`);
          limitation++;
        } else {
          console.log(`FAIL  ${entry.id} — rejected, but NOT with the expected known-limitation message: ${e.message.slice(0, 100)}`);
          fail++;
        }
      }
      continue;
    }

    if (exp.error) {
      // Validation-rejection demo entries: confirm the executor still rejects it.
      try {
        await executeDescriptor(entry.descriptor, schema, entry.callConfig || {});
        console.log(`FAIL  ${entry.id} — expected rejection but query succeeded`);
        fail++;
      } catch (e) {
        console.log(`PASS  ${entry.id} — correctly rejected: ${e.message.slice(0, 80)}`);
        pass++;
      }
      continue;
    }

    try {
      const rows = await executeDescriptor(entry.descriptor, schema, entry.callConfig || {});
      const expRows = exp.rows || [];
      if (rowsEqual(rows, expRows)) {
        console.log(`PASS  ${entry.id} (${rows.length} rows) — "${entry.nl}"`);
        pass++;
      } else {
        console.log(`FAIL  ${entry.id} — row mismatch. Got ${rows.length}, expected ${expRows.length}`);
        console.log(`      got:      ${JSON.stringify(rows.slice(0, 2))}`);
        console.log(`      expected: ${JSON.stringify(expRows.slice(0, 2))}`);
        fail++;
      }
    } catch (e) {
      console.log(`FAIL  ${entry.id} — threw unexpectedly: ${e.message}`);
      fail++;
    }
  }

  console.log(`\n=== Summary: ${pass} passed, ${fail} failed, ${limitation} known HANA limitations, ${skip} skipped (of ${queries.length}) ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
