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

// Resolves an exists/notExists alias path (e.g. 'payments' or 'customer.payments')
// hop by hop through the schema's join metadata, the same way collectJoinedEntities
// does for ordinary path refs.
function resolveAliasChain(aliasPath, startEntityDef, schema) {
  const parts = aliasPath.split('.');
  let currentDef = startEntityDef;
  for (const part of parts) {
    const join = currentDef?.joins?.[part];
    if (!join) {
      throw new Error(`Cannot resolve association path "${aliasPath}" for exists/notExists — unknown alias "${part}"`);
    }
    currentDef = schema[join.entity];
  }
  return parts;
}

// Builds the CQN token for an exists/notExists node, e.g.:
//   { xpr: ['exists', { ref: ['payments', { id: 'STATUS'-filtered alias, where: [...] }] }] }
// EXISTS over an association's infix filter is a native CQL/CQN construct — confirmed
// against cds.parse.expr('exists payments[STATUS=\'OPEN\']'), which produces exactly
// this { ref: [..., { id, where }] } shape; chained aliases (e.g. 'customer.payments')
// resolve to extra leading ref segments the same way.
function buildExistsTokens(node, startEntityDef, schema) {
  const aliasPath = node.exists || node.notExists;
  const aliasParts = resolveAliasChain(aliasPath, startEntityDef, schema);

  const innerConditions = node.where || [];
  // Known CQL limitation: paths inside an exists/notExists infix filter are not
  // supported — the filter can only reference the target entity's own direct
  // columns. Reject rather than silently sending an invalid query to the DB.
  for (const col of collectWhereCols(innerConditions)) {
    if (col.includes('.')) {
      throw new Error(
        `exists/notExists filter column "${col}" must be a plain column of "${aliasPath}" — ` +
        `paths inside an exists/notExists filter are not supported by CQL.`
      );
    }
  }
  const innerWhere = buildWhereExpr(innerConditions);

  const lastAlias = aliasParts[aliasParts.length - 1];
  const refParts = [...aliasParts.slice(0, -1), innerWhere ? { id: lastAlias, where: innerWhere } : lastAlias];

  return node.exists
    ? [{ xpr: ['exists', { ref: refParts }] }]
    : [{ xpr: ['not', 'exists', { ref: refParts }] }];
}

// Resolves a single where-descriptor node (leaf, {any:[...]}/{all:[...]} group, or
// {exists:...}/{notExists:...}) into a token array. Groups are wrapped in {xpr:[...]}
// — CQN's parenthesization — so precedence against sibling conditions at the
// enclosing level is preserved (confirmed against cds.parse.expr's own output for
// parenthesized expressions).
function toTokens(node, startEntityDef, schema) {
  if (node.any) return [{ xpr: joinTokens('or', node.any.map(n => toTokens(n, startEntityDef, schema))) }];
  if (node.all) return [{ xpr: joinTokens('and', node.all.map(n => toTokens(n, startEntityDef, schema))) }];
  if (node.exists || node.notExists) return buildExistsTokens(node, startEntityDef, schema);
  return buildLeafTokens(node);
}

/**
 * Build a CQN WHERE predicate array from descriptor conditions.
 * Supports association path refs ('assoc.COL') — CDS generates SQL JOINs for them.
 * Supports OR/AND grouping via {any:[...]}/{all:[...]} nodes (can nest).
 * Supports {exists:alias,where:[...]} / {notExists:alias,where:[...]} for to-many
 * association existence checks (startEntityDef/schema only needed for these).
 * Top-level conditions (and 'all' groups) are AND-ed together.
 *
 * Returns a flat CQN expression array compatible with SELECT.where([...]).
 */
function buildWhereExpr(conditions, startEntityDef, schema) {
  if (!conditions?.length) return null;
  const tokens = joinTokens('and', conditions.map(n => toTokens(n, startEntityDef, schema)));
  return tokens;
}

// Recursively collects every 'col'/'valCol' path referenced anywhere in a where
// tree, including inside nested any/all groups — used by the entity allowlist
// check so a disallowed entity can't be reached by hiding its column inside a group.
// exists/notExists nodes are skipped here (their inner where is in a different
// column scope, relative to the joined entity) — see collectExistsPaths instead.
function collectWhereCols(conditions) {
  return (conditions || []).flatMap(node => {
    if (node.any) return collectWhereCols(node.any);
    if (node.all) return collectWhereCols(node.all);
    if (node.exists || node.notExists) return [];
    return node.valCol ? [node.col, node.valCol] : [node.col];
  });
}

// Recursively collects every exists/notExists association alias path referenced
// anywhere in a where tree — used to extend the entity-allowlist check so a
// disallowed entity can't be read indirectly via an exists filter.
function collectExistsPaths(conditions) {
  return (conditions || []).flatMap(node => {
    if (node.any) return collectExistsPaths(node.any);
    if (node.all) return collectExistsPaths(node.all);
    if (node.exists) return [node.exists];
    if (node.notExists) return [node.notExists];
    return [];
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

// Builds an OR-of-LIKE token group across an entity's @cds.search columns, e.g.
// {"search": "acme"} on an entity with searchable: NAME, NOTES becomes
// (upper(NAME) like '%ACME%' or upper(NOTES) like '%ACME%') — reuses the same
// case-insensitive 'like' leaf shape as a normal where condition.
function buildSearchExpr(term, searchableColumns) {
  const tokens = joinTokens('or', searchableColumns.map(col => buildLeafTokens({ col, op: 'like', val: term })));
  return [{ xpr: tokens }];
}

// Recursively collects every entity reached via an "expand" tree — used to extend
// the entity allowlist check the same way collectJoinedEntities does for flat paths.
function collectExpandEntities(expandList, parentEntityDef, schema) {
  const entities = new Set();
  for (const node of expandList || []) {
    const join = parentEntityDef?.joins?.[node.assoc];
    if (!join) continue; // unresolvable alias — query will fail later anyway
    entities.add(join.entity);
    if (node.expand?.length) {
      for (const e of collectExpandEntities(node.expand, schema[join.entity], schema)) entities.add(e);
    }
  }
  return entities;
}

// CAP/CQL does not support nested expands where BOTH the parent and the child
// association are to-many (e.g. Orders.items{to-many}.parts{to-many}) — only
// to-many → to-one nesting is supported (e.g. Orders.items{to-many}.product{to-one}).
// Confirmed against CAP's own CQL docs; reject up front with a clear error instead
// of sending a query CAP would reject at a less obvious point.
function validateExpandNesting(expandList, parentEntityDef, schema, ancestorToMany) {
  for (const node of expandList || []) {
    const join = parentEntityDef?.joins?.[node.assoc];
    if (!join) {
      throw new Error(`Unknown association "${node.assoc}" for expand — not found on "${parentEntityDef?.fqn}"`);
    }
    if (ancestorToMany && join.toMany) {
      throw new Error(
        `expand "${node.assoc}" is nested under another to-many expand — CAP/CQL does not support ` +
        `nested expands where both the parent and child association are to-many. Flatten one level ` +
        `(e.g. select a to-one scalar instead, or split into two separate queries).`
      );
    }
    if (node.expand?.length) {
      validateExpandNesting(node.expand, schema[join.entity], schema, join.toMany);
    }
  }
}

// Builds the CQN { ref, expand, where?, limit } column nodes for a descriptor's
// "expand" entries, recursing into nested expand levels. Each level's plain "select"
// columns and nested expand columns are combined into a single flat "expand" array —
// confirmed against cds.ql's own builder output for o.items(i => { i.product; i.qty }).
function buildExpandCols(expandList, parentEntityDef, schema, allBlocked, maxExpandRows) {
  return (expandList || []).map(node => {
    const join = parentEntityDef.joins[node.assoc];
    const targetDef = schema[join.entity];

    const filteredSelect = (node.select?.length ? node.select : Object.keys(targetDef.columns))
      .filter(c => !allBlocked.has(c.split('.').pop()));
    const subCols     = filteredSelect.map(colRef);
    const nestedCols   = node.expand?.length
      ? buildExpandCols(node.expand, targetDef, schema, allBlocked, maxExpandRows)
      : [];

    const expandCol = { ref: [node.assoc], expand: [...subCols, ...nestedCols] };

    const whereExpr = buildWhereExpr(node.where, targetDef, schema);
    if (whereExpr) expandCol.where = whereExpr;

    expandCol.limit = { rows: { val: Math.min(node.limit || maxExpandRows, maxExpandRows) } };

    return expandCol;
  });
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
 *   search    — free-text term matched against the entity's @cds.search columns (AND-ed
 *               with any other where conditions); errors if the entity declares none
 *   expand    — [{ assoc, select, where, limit, expand }] — nests a to-many association/
 *               composition's rows instead of flattening them (one parent object with a
 *               nested array, via CAP's native expand). Can nest, but not two to-many
 *               levels deep (CQL limitation, validated up front).
 *   orderBy   — column or 'assoc.COL'
 *   orderDir  — 'ASC' | 'DESC'
 *   limit     — rows requested (capped by server maxRows, enforced at SQL LIMIT)
 *   offset    — rows to skip for pagination (capped by server maxOffset, default 0)
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
    search,
    expand,
    orderBy, orderDir,
    limit: rawLimit = 50,
    offset: rawOffset = 0,
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

  if (expand?.length) validateExpandNesting(expand, entityDef, schema, false);

  // Enforce the allowlist on entities reached via association-path joins too —
  // e.g. querying "BCA_DTI" but selecting "customer.BU_SORT1" reads BusinessPartners,
  // which must independently pass the same allowlist check as the top-level entity.
  const allPaths = [
    ...(select || []),
    ...collectWhereCols(where),
    // Append a dummy trailing segment so collectJoinedEntities (which treats the
    // last path segment as the leaf column) resolves every alias hop, including
    // the exists/notExists target itself, not just the hops before it.
    ...collectExistsPaths(where).map(p => `${p}.__exists_target__`),
    ...(aggregate || []).filter(a => a.col !== '*').map(a => a.col),
    ...(groupBy || []),
    ...(having || []).filter(h => h.col !== '*').map(h => h.col),
    ...(orderBy ? [orderBy] : []),
  ];
  const joinedEntities = collectJoinedEntities(allPaths, entityDef, schema);
  for (const e of collectExpandEntities(expand, entityDef, schema)) joinedEntities.add(e);
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

  // Clamp offset server-side too — an unbounded offset is an unintentional deep-
  // pagination table-scan vector against the DB.
  const effectiveOffset = Math.min(rawOffset, serverCfg.maxOffset);

  // ── Column blocklist — union of server + per-call ────────────────────────────

  const allBlocked = new Set([
    ...serverCfg.blockedColumns,
    ...(callConfig.blockedColumns || []),
  ]);

  // ── Build CQN column refs ───────────────────────────────────────────────────
  // Strip blocked columns at the source (before sending to HANA)
  // Path refs like { ref: ['customer', 'BU_SORT1'] } → CDS generates a SQL JOIN

  let cols = null;
  if (select?.length || aggregate?.length || expand?.length) {
    // When "expand" is used without an explicit "select", default to all of the
    // parent entity's own columns (mirrors the no-select-no-expand "all columns"
    // behavior below) — q.columns() must be called explicitly once any nested
    // expand column is added, so there's no implicit "SELECT *" fallback here.
    const effectiveSelect = select?.length ? select : (aggregate?.length ? [] : Object.keys(entityDef.columns));
    const filteredSelect = effectiveSelect.filter(c => !allBlocked.has(c.split('.').pop()));
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
    const expandCols = expand?.length
      ? buildExpandCols(expand, entityDef, schema, allBlocked, serverCfg.maxExpandRows)
      : [];
    cols = [...selectCols, ...aggregateCols, ...expandCols];
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

  let whereExpr = buildWhereExpr(where, entityDef, schema);

  if (search != null && search !== '') {
    if (!entityDef.searchableColumns?.length) {
      throw new Error(
        `Entity "${entity}" has no @cds.search columns declared — free-text "search" is not supported for it. ` +
        `Use an explicit "where" condition instead.`
      );
    }
    const searchExpr = buildSearchExpr(search, entityDef.searchableColumns);
    whereExpr = whereExpr ? joinTokens('and', [whereExpr, searchExpr]) : searchExpr;
  }

  if (whereExpr) q.where(whereExpr);

  if (groupBy?.length) q.groupBy(...groupBy);

  const havingExpr = buildHavingExpr(having);
  if (havingExpr) q.having(havingExpr);

  if (orderBy) {
    q.orderBy([{ ...colRef(orderBy), sort: (orderDir || 'ASC').toLowerCase() }]);
  }

  q.limit(effectiveLimit, effectiveOffset);   // single SQL LIMIT/OFFSET — HANA enforces it, not Node.js

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
