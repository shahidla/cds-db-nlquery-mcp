'use strict';

// Resolve @sap/cds from the caller's CAP project root so their @sap/hana-client
// and platform adapters are found. Falls back to local install.
const cds = (() => {
  try { return require(require.resolve('@sap/cds', { paths: [process.cwd()] })); }
  catch { return require('@sap/cds'); }
})();

// Build a CQN column ref from a column string ('COL' or 'assoc.COL' or 'a.b.COL').
// CDS translates ref paths with length > 1 into SQL JOINs automatically.
function colRef(colStr) {
  return { ref: colStr.split('.') };
}

// CQN function-call column, e.g. count(LOAN_ID) as loan_count — official CQN shape
// per CAP's own reference: a function-call node is { func: String, args: expr[] }.
function buildAggregateCol({ fn, col, as }) {
  return {
    func: fn,
    args: col === '*' ? [{ val: 1 }] : [colRef(col)],
    as:   as || `${fn}_${col === '*' ? 'all' : col.split('.').pop()}`,
  };
}

function isoDate(d) { return d.toISOString().split('T')[0]; }

// Walks every path string (e.g. 'customer.dti.DTI_RATIO') and resolves every
// association alias along the way to its target entity name, using the schema's
// join metadata. Used to enforce the entity allowlist on JOINED entities too —
// not just the top-level entity — closing a bypass where a disallowed entity
// could be read via an association path instead of being queried directly.
function collectJoinedEntities(paths, startEntityDef, schema) {
  const entities = new Set();
  for (const path of paths) {
    const parts = path.split('.');
    if (parts.length < 2) continue; // plain column, no join involved
    let currentDef = startEntityDef;
    for (let i = 0; i < parts.length - 1; i++) {
      const join = currentDef?.joins?.[parts[i]];
      if (!join) break; // unresolvable alias — query will fail later anyway
      entities.add(join.entity);
      currentDef = schema[join.entity];
    }
  }
  return entities;
}

// Builds the flat token array for a single leaf condition (no any/all nesting).
// e.g. [ref, '=', {val}], or a multi-token 'and' pair for within_days/days_ago.
function buildLeafTokens({ col, op, val, valCol }) {
  const today = new Date();
  const ref = colRef(col);
  // valCol compares against another column instead of a literal (e.g. comparing
  // collateral.VALUE against AMOUNT on the same query) — CDS resolves it as a
  // normal path ref, generating a join the same way the main column would.
  const rhs = valCol ? colRef(valCol) : { val };

  switch (op) {
    case 'within_days': {
      const d0 = isoDate(today);
      const d1 = isoDate(new Date(today.getTime() + Number(val) * 86400000));
      return [ref, '>=', { val: d0 }, 'and', ref, '<=', { val: d1 }];
    }
    case 'days_ago': {
      const d0 = isoDate(new Date(today.getTime() - Number(val) * 86400000));
      const d1 = isoDate(today);
      return [ref, '>=', { val: d0 }, 'and', ref, '<=', { val: d1 }];
    }
    case 'like':
      // Genuinely case-insensitive — HANA's LIKE is case-sensitive by default,
      // so wrap both sides in UPPER() rather than relying on collation settings.
      return [{ func: 'upper', args: [ref] }, 'like', { val: `%${String(val).toUpperCase()}%` }];
    default:
      return [ref, op, rhs];
  }
}

// Joins an array of token-arrays with a boolean operator: [a] [op] [b] [op] [c] ...
function joinTokens(operator, tokenArrays) {
  const result = [];
  for (let i = 0; i < tokenArrays.length; i++) {
    if (i > 0) result.push(operator);
    result.push(...tokenArrays[i]);
  }
  return result;
}

// Resolves a single where-descriptor node (leaf, or {any:[...]}/{all:[...]} group)
// into a token array. Groups are wrapped in {xpr:[...]} — CQN's parenthesization —
// so precedence against sibling conditions at the enclosing level is preserved
// (confirmed against cds.parse.expr's own output for parenthesized expressions).
function toTokens(node) {
  if (node.any) return [{ xpr: joinTokens('or', node.any.map(toTokens)) }];
  if (node.all) return [{ xpr: joinTokens('and', node.all.map(toTokens)) }];
  return buildLeafTokens(node);
}

/**
 * Build a CQN WHERE predicate array from descriptor conditions.
 * Supports association path refs ('assoc.COL') — CDS generates SQL JOINs for them.
 * Supports OR/AND grouping via {any:[...]}/{all:[...]} nodes (can nest).
 * Top-level conditions (and 'all' groups) are AND-ed together.
 *
 * Returns a flat CQN expression array compatible with SELECT.where([...]).
 */
function buildWhereExpr(conditions) {
  if (!conditions?.length) return null;
  const tokens = joinTokens('and', conditions.map(toTokens));
  return tokens;
}

// Recursively collects every 'col'/'valCol' path referenced anywhere in a where
// tree, including inside nested any/all groups — used by the entity allowlist
// check so a disallowed entity can't be reached by hiding its column inside a group.
function collectWhereCols(conditions) {
  return (conditions || []).flatMap(node => {
    if (node.any) return collectWhereCols(node.any);
    if (node.all) return collectWhereCols(node.all);
    return node.valCol ? [node.col, node.valCol] : [node.col];
  });
}

// Builds a flat CQN HAVING expression from descriptor having-conditions, AND-ed
// together. Each leaf compares an aggregate function call to a literal, reusing
// the same {func,args} shape as buildAggregateCol — e.g. count(LOAN_ID) > 5.
function buildHavingExpr(conditions) {
  if (!conditions?.length) return null;
  const parts = conditions.map(({ fn, col, op, val }) => [buildAggregateCol({ fn, col }), op, { val }]);
  return joinTokens('and', parts);
}

/**
 * Execute a query descriptor against the CDS db layer.
 *
 * Architecture: single cds.run() with CDS association path expressions.
 * CDS translates 'assoc.COL' paths into real SQL JOINs in HANA — no JavaScript
 * merging, no separate SELECT per entity, no post-fetch filtering.
 * WHERE conditions and LIMIT are pushed to HANA SQL — scales to billions of rows.
 *
 * Descriptor shape:
 *   entity    — entity short name (must be in schema)
 *   select    — columns, supports paths: ['PARTNER', 'customer.BU_SORT1', 'customer.dti.DTI_RATIO']
 *   where     — [{ col, op, val }]; col may be 'assoc.COL' for cross-entity conditions
 *   aggregate — [{ fn: 'count'|'sum'|'avg'|'min'|'max', col: 'COLUMN or assocAlias.COLUMN or *', as }]
 *   groupBy   — ['COLUMN or assocAlias.COLUMN', ...]
 *   having    — [{ fn, col, op, val }] — filters on an aggregate value (e.g. count(LOAN_ID) > 5)
 *   orderBy   — column or 'assoc.COL'
 *   orderDir  — 'ASC' | 'DESC'
 *   limit     — rows requested (capped by server maxRows, enforced at SQL LIMIT)
 *
 * callConfig (per-call input param overrides — merged with server config):
 *   allowedEntities — restrict queryable entities for this call (intersects with server list)
 *   blockedColumns  — additional columns to strip for this call (unions with server list)
 *   maxRows         — lower the row cap for this call
 */
async function executeDescriptor(descriptor, schema, callConfig = {}) {
  const {
    entity,
    select,
    where,
    aggregate,
    groupBy,
    having,
    orderBy, orderDir,
    limit: rawLimit = 50,
  } = descriptor;

  const serverCfg = require('./config');

  // ── Access control ──────────────────────────────────────────────────────────

  const serverAllowed = serverCfg.allowedEntities;   // [] = no restriction (all allowed)
  const callAllowed   = callConfig.allowedEntities || [];

  if (serverAllowed.length > 0 && !serverAllowed.includes(entity)) {
    throw new Error(
      `Entity "${entity}" is not accessible. ` +
      `Allowed (server): ${serverAllowed.join(', ')}. ` +
      `Update MCP_ALLOWED_ENTITIES in .mcp.json to add it.`
    );
  }
  if (callAllowed.length > 0 && !callAllowed.includes(entity)) {
    throw new Error(`Entity "${entity}" is not in the per-call allowed_entities list`);
  }

  const entityDef = schema[entity];
  if (!entityDef) {
    throw new Error(`Unknown entity "${entity}". Known: ${Object.keys(schema).join(', ')}`);
  }

  // Enforce the allowlist on entities reached via association-path joins too —
  // e.g. querying "BCA_DTI" but selecting "customer.BU_SORT1" reads BusinessPartners,
  // which must independently pass the same allowlist check as the top-level entity.
  const allPaths = [
    ...(select || []),
    ...collectWhereCols(where),
    ...(aggregate || []).filter(a => a.col !== '*').map(a => a.col),
    ...(groupBy || []),
    ...(having || []).filter(h => h.col !== '*').map(h => h.col),
    ...(orderBy ? [orderBy] : []),
  ];
  const joinedEntities = collectJoinedEntities(allPaths, entityDef, schema);
  for (const joined of joinedEntities) {
    if (serverAllowed.length > 0 && !serverAllowed.includes(joined)) {
      throw new Error(
        `Entity "${joined}" (reached via association join) is not accessible. ` +
        `Allowed (server): ${serverAllowed.join(', ')}.`
      );
    }
    if (callAllowed.length > 0 && !callAllowed.includes(joined)) {
      throw new Error(`Entity "${joined}" (reached via association join) is not in the per-call allowed_entities list`);
    }
  }

  // ── Row cap — enforced at SQL LIMIT, not post-fetch ─────────────────────────

  const callMax      = callConfig.maxRows || Infinity;
  const effectiveLimit = Math.min(rawLimit, serverCfg.maxRows, callMax);

  // ── Column blocklist — union of server + per-call ────────────────────────────

  const allBlocked = new Set([
    ...serverCfg.blockedColumns,
    ...(callConfig.blockedColumns || []),
  ]);

  // ── Build CQN column refs ───────────────────────────────────────────────────
  // Strip blocked columns at the source (before sending to HANA)
  // Path refs like { ref: ['customer', 'BU_SORT1'] } → CDS generates a SQL JOIN

  let cols = null;
  if (select?.length || aggregate?.length) {
    const filteredSelect = (select || []).filter(c => !allBlocked.has(c.split('.').pop()));
    const filteredAggregate = (aggregate || []).filter(a => a.col === '*' || !allBlocked.has(a.col.split('.').pop()));

    // The LLM is told (rule 7) never to select the same leaf column name twice
    // (e.g. "CURRENCY" via the top-level entity AND via "loan.CURRENCY"), but a
    // cheap model occasionally does it anyway — HANA then rejects the query with
    // "Duplicate column names". Rather than depend on prompt compliance, alias any
    // joined-path column (length > 1) whose leaf name collides with another
    // selected column, so the query is always valid regardless of what the LLM did.
    const leafCounts = {};
    for (const c of filteredSelect) {
      const leaf = c.split('.').pop();
      leafCounts[leaf] = (leafCounts[leaf] || 0) + 1;
    }
    const selectCols = filteredSelect.map(c => {
      const parts = c.split('.');
      const leaf = parts[parts.length - 1];
      if (leafCounts[leaf] > 1 && parts.length > 1) {
        return { ref: parts, as: parts.join('_') };
      }
      return colRef(c);
    });
    const aggregateCols = filteredAggregate.map(buildAggregateCol);
    cols = [...selectCols, ...aggregateCols];
  } else if (allBlocked.size > 0) {
    // No explicit select ("all columns") but some columns are blocked. Without this,
    // the query would fall through to SELECT * — fetching blocked columns (e.g.
    // EMBEDDING, PASSWORD) from HANA over the wire before stripping them post-fetch.
    // Build an explicit allowed-column list instead so blocked columns are never
    // sent to HANA at all.
    const allowedCols = Object.keys(entityDef.columns).filter(c => !allBlocked.has(c));
    cols = allowedCols.map(colRef);
  }

  // ── Build single CDS query ──────────────────────────────────────────────────

  const q = SELECT.from(entityDef.fqn);
  if (cols?.length) q.columns(...cols);

  const whereExpr = buildWhereExpr(where);
  if (whereExpr) q.where(whereExpr);

  if (groupBy?.length) q.groupBy(...groupBy);

  const havingExpr = buildHavingExpr(having);
  if (havingExpr) q.having(havingExpr);

  if (orderBy) {
    q.orderBy([{ ...colRef(orderBy), sort: (orderDir || 'ASC').toLowerCase() }]);
  }

  q.limit(effectiveLimit);   // single SQL LIMIT — HANA enforces it, not Node.js

  let rows = await cds.run(q);

  // Translate enum raw values back to business terms (same mechanism Fiori uses for
  // coded value display) — e.g. STATUS: "C" also gets STATUS_text: "closed" alongside it.
  // Raw value is kept as-is; the _text sibling is additive, never replaces it.
  const enumCols = Object.entries(entityDef.columns).filter(([, meta]) => meta.enum);
  if (enumCols.length > 0) {
    rows = rows.map(row => {
      const out = { ...row };
      for (const [col, meta] of enumCols) {
        if (col in out && meta.enum[out[col]]) {
          out[`${col}_text`] = meta.enum[out[col]];
        }
      }
      return out;
    });
  }

  // Belt-and-suspenders: strip blocked columns from result rows (catches * selects)
  if (allBlocked.size > 0) {
    return rows.map(row => {
      const out = { ...row };
      for (const col of allBlocked) delete out[col];
      return out;
    });
  }

  return rows;
}

module.exports = { executeDescriptor };
