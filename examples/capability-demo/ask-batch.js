'use strict';
// Runs every capability-demo question through the REAL NL pipeline (planQuery with
// a real LLM, then executeDescriptor against WHATEVER database your CAP project is
// connected to) — not hand-written descriptors like validate-deployment.js.
// Compares against the same results.json golden reference. This is how every "LLM
// mistake vs package bug" distinction in README.md/BLOG.md was actually
// established — by running this, not by guessing.
//
// Prerequisite: same as validate-deployment.js.
//
// Run: node <path-to-this-file>/ask-batch.js [--provider=openai|anthropic] [idFilter]
//   --provider=openai    default; also how DeepSeek/Groq/any OpenAI-compatible
//                        endpoint connects, via OPENAI_BASE_URL (needs OPENAI_API_KEY)
//   --provider=anthropic needs ANTHROPIC_API_KEY
//   idFilter             optional — run just one entry by id, e.g. "old-01-plain-where"

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
const queries = require(path.join(__dirname, 'queries.js'));
const expectedArr = require(path.join(__dirname, 'results.json'));
const expected = Object.fromEntries(expectedArr.map(e => [e.id, e]));

function normVal(v) {
  if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}

// The golden reference (results.json) used a deliberately narrow, hand-picked
// "select" list — an LLM asked the same NL question may reasonably choose a
// DIFFERENT column set (broader OR narrower, e.g. omitting ID when not asked for
// it, or including ORDER_DATE when asked for "open orders" without specifying
// fields) at ANY nesting level, including inside "expand". Strict full-row/
// full-tree equality, or even a strict "every expected key must be present"
// check, would flag that as a failure even though every value that IS present
// and comparable is correct. Compare on the INTERSECTION of keys actually
// present in both sides, recursively — this checks "is the data that's there
// right", not "did the LLM pick the exact same columns a human happened to pick
// for the fixture". (An empty intersection can't be considered a match — that's
// not "no information to compare", it's "these two rows share nothing at all".)
function valuesEqual(actual, expected) {
  if (Array.isArray(expected)) return rowsEqual(actual, expected);
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && rowSubsetEqual(actual, expected);
  }
  return normVal(actual) === normVal(expected);
}
function rowSubsetEqual(actualRow, expectedRow) {
  const sharedKeys = Object.keys(expectedRow).filter(k => k in actualRow);
  if (sharedKeys.length === 0) return false;
  return sharedKeys.every(k => valuesEqual(actualRow[k], expectedRow[k]));
}
function rowsEqual(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const usedIdx = new Set();
  return b.every(expRow => a.some((actRow, i) => {
    if (usedIdx.has(i)) return false;
    if (rowSubsetEqual(actRow, expRow)) { usedIdx.add(i); return true; }
    return false;
  }));
}

async function run() {
  const args = process.argv.slice(2);
  const providerArg = args.find(a => a.startsWith('--provider='));
  const provider = providerArg?.split('=')[1] || 'openai';
  const idFilter = args.find(a => !a.startsWith('--provider='));

  cds.model = cds.linked(await cds.load('db'));
  await cds.connect.to('db');
  const schema = buildSchema(cds.model);
  const schemaText = buildSchemaPrompt(schema);

  const callConfig = {};
  if (provider === 'anthropic') { callConfig.provider = 'anthropic'; callConfig.apiKey = process.env.ANTHROPIC_API_KEY; }
  else { callConfig.provider = 'openai'; callConfig.apiKey = process.env.OPENAI_API_KEY; }

  // These 3 entries' "nl" field is a test-suite LABEL describing what the
  // hand-written descriptor is meant to validate (e.g. "(validation demo)
  // ..."), not a real question a user would ask an LLM — running them through
  // planQuery doesn't test anything meaningful, so exclude them from this batch.
  const VALIDATION_DEMO_IDS = new Set([
    'old-15-persistence-skip-rejected',
    'new-08-hierarchy-rejects-non-recursive-assoc',
    'new-09-window-rejects-combo-with-aggregate',
  ]);
  const targets = (idFilter ? queries.filter(q => q.id === idFilter) : queries)
    .filter(q => !VALIDATION_DEMO_IDS.has(q.id));
  console.log(`\n=== Running ${targets.length} NL questions through the REAL LLM pipeline (provider: ${provider}) ===\n`);

  let pass = 0, fail = 0, skip = 0;
  const failures = [];

  for (const entry of targets) {
    const exp = expected[entry.id];
    if (!exp) { console.log(`SKIP  ${entry.id}`); skip++; continue; }

    let descriptor;
    try {
      descriptor = await planQuery(entry.nl, schemaText, callConfig);
    } catch (e) {
      console.log(`FAIL  ${entry.id} — LLM call itself failed: ${e.message}`);
      fail++; failures.push({ entry, stage: 'llm', error: e.message });
      continue;
    }

    const expectRejection = exp.error != null;
    try {
      const rows = await executeDescriptor(descriptor, schema, callConfig.blockedColumns ? { blockedColumns: callConfig.blockedColumns } : {});
      if (expectRejection) {
        console.log(`FAIL  ${entry.id} — expected rejection, LLM's descriptor succeeded instead — "${entry.nl}"`);
        fail++; failures.push({ entry, stage: 'execute', descriptor, note: 'expected rejection but got rows' });
        continue;
      }
      const expRows = exp.rows || [];
      if (rowsEqual(rows, expRows)) {
        console.log(`PASS  ${entry.id} (${rows.length} rows) — "${entry.nl}"`);
        pass++;
      } else {
        console.log(`FAIL  ${entry.id} — row mismatch — "${entry.nl}"`);
        fail++; failures.push({ entry, stage: 'mismatch', descriptor, got: rows, expected: expRows });
      }
    } catch (e) {
      if (expectRejection) {
        console.log(`PASS  ${entry.id} — correctly rejected — "${entry.nl}"`);
        pass++;
      } else {
        console.log(`FAIL  ${entry.id} — threw unexpectedly: ${e.message} — "${entry.nl}"`);
        fail++; failures.push({ entry, stage: 'execute', descriptor, error: e.message });
      }
    }
  }

  console.log(`\n=== Summary (${provider}): ${pass} passed, ${fail} failed, ${skip} skipped (of ${targets.length}) ===\n`);

  if (failures.length) {
    console.log('--- Failure details (for diagnosing LLM-mistake vs package-bug) ---\n');
    for (const f of failures) {
      console.log(`[${f.entry.id}] "${f.entry.nl}"`);
      console.log('  descriptor:', JSON.stringify(f.descriptor));
      if (f.error) console.log('  error:', f.error);
      if (f.got) console.log('  got:', JSON.stringify(f.got).slice(0, 300));
      if (f.expected) console.log('  expected:', JSON.stringify(f.expected).slice(0, 300));
      console.log('');
    }
  }

  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
