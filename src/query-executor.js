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

// A "column spec" anywhere in a descriptor (select entry, where col/valCol,
// aggregate.col, having.col) is either a plain dotted-path string, or a structured
// filtered-association form: { col: 'AMOUNT', viaFiltered: { assoc, where } } —
// "AMOUNT of this entity's OPEN payments", filtering the join itself rather than
// the outer row. Confirmed CQN shape against cds.parse.expr("payments[STATUS='OPEN'].AMOUNT"):
// { ref: [{ id: 'payments', where: [...] }, 'AMOUNT'] }.
function isFilteredSpec(spec) {
  return typeof spec === 'object' && spec !== null && spec.viaFiltered != null;
}

// A select-entry spec may also be a plain explicit-alias form { col: 'AMOUNT', as: 'total' } —
// no filtered join, just a rename. Useful on its own, and required by "union"/"intersect"/
// "except" branches whose underlying columns are named differently but represent the same thing.
function isObjSpec(spec) {
  return typeof spec === 'object' && spec !== null && spec.col != null;
}

// The explicit "as" alias of a select-entry spec, if any (only the { col, as } form carries one).
function specAlias(spec) {
  return isObjSpec(spec) ? spec.as : undefined;
}

// The dotted-path-string equivalent of a column spec, used wherever paths are
// treated as plain strings (entity-allowlist walking, column blocklist matching).
function specPath(spec) {
  if (isFilteredSpec(spec)) return `${spec.viaFiltered.assoc}.${spec.col}`;
  return isObjSpec(spec) ? spec.col : spec;
}

// Resolves a column spec into its actual CQN ref, attaching the inline filter to
// the join hop for the structured form.
function resolveColSpec(spec) {
  if (isObjSpec(spec) && !isFilteredSpec(spec)) return colRef(spec.col);
  if (!isFilteredSpec(spec)) return colRef(spec);

  const { assoc, where } = spec.viaFiltered;
  // Known CQL limitation: paths inside a viaFiltered filter are not supported —
  // the filter can only reference the filtered association's own direct columns.
  for (const col of collectWhereCols(where)) {
    if (col.includes('.')) {
      throw new Error(
        `viaFiltered filter column "${col}" on "${assoc}" must be a plain column — ` +
        `paths inside a viaFiltered filter are not supported by CQL.`
      );
    }
  }
  const innerWhere = buildWhereExpr(where);
  const hop = innerWhere ? { id: assoc, where: innerWhere } : assoc;
  return { ref: [hop, spec.col] };
}

// CQN function-call column, e.g. count(LOAN_ID) as loan_count — official CQN shape
// per CAP's own reference: a function-call node is { func: String, args: expr[] }.
function buildAggregateCol({ fn, col, as }) {
  return {
    func: fn,
    args: col === '*' ? [{ val: 1 }] : [resolveColSpec(col)],
    as:   as || `${fn}_${col === '*' ? 'all' : specPath(col).split('.').pop()}`,
  };
}

// CQN shape for a window function column, e.g. RANK() OVER (PARTITION BY ... ORDER BY ...) —
// confirmed against cds.parse.expr('rank() over (partition by PARTNER order by AMOUNT desc)'):
// { func: 'rank', args: [...], xpr: ['over', { xpr: [...partition/order tokens...] }] }.
// Every identifier comes from resolveColSpec (the same validated path-resolution used
// everywhere else), never the LLM's raw strings — partitionBy/orderBy entries can be
// association paths (e.g. "customer.PARTNER") and go through the same join machinery.
const WINDOW_NO_ARG_FNS = new Set(['row_number', 'rank', 'dense_rank']);
const WINDOW_AGG_FNS    = new Set(['sum', 'avg', 'count', 'min', 'max']);

function buildOverXpr(partitionBy, orderBy) {
  const tokens = [];
  if (partitionBy?.length) {
    tokens.push('partition', 'by');
    partitionBy.forEach((c, i) => {
      if (i > 0) tokens.push(',');
      tokens.push(resolveColSpec(c));
    });
  }
  if (orderBy?.length) {
    tokens.push('order', 'by');
    orderBy.forEach((o, i) => {
      if (i > 0) tokens.push(',');
      tokens.push(resolveColSpec(o.col));
      if (o.dir) tokens.push(o.dir.toLowerCase());
    });
  }
  return ['over', { xpr: tokens }];
}

function buildWindowCol(spec) {
  const { fn, as, col, offset, buckets, partitionBy, orderBy } = spec;
  if (!as) throw new Error('"window" entries require an "as" alias.');

  let args;
  if (WINDOW_NO_ARG_FNS.has(fn)) {
    args = [];
  } else if (fn === 'ntile') {
    if (!buckets) throw new Error('window fn "ntile" requires "buckets".');
    args = [{ val: buckets }];
  } else if (fn === 'lag' || fn === 'lead') {
    if (!col) throw new Error(`window fn "${fn}" requires "col".`);
    args = [resolveColSpec(col), { val: offset ?? 1 }];
  } else if (WINDOW_AGG_FNS.has(fn)) {
    if (!col) throw new Error(`window fn "${fn}" requires "col".`);
    args = [col === '*' ? { val: 1 } : resolveColSpec(col)];
  } else {
    throw new Error(`Unsupported window function "${fn}".`);
  }

  return { func: fn, args, xpr: buildOverXpr(partitionBy, orderBy), as };
}

// Collects every column path referenced inside a "window" array's partitionBy/orderBy/col
// entries — used to extend the entity-allowlist walk the same way every other section does.
function collectWindowCols(windowList) {
  return (windowList || []).flatMap(w => [
    ...(w.col ? [w.col] : []),
    ...(w.partitionBy || []),
    ...(w.orderBy || []).map(o => o.col),
  ]);
}

// CQN shape for a CASE WHEN computed column, e.g.:
//   case when DAYS_OVERDUE <= 0 then 'Healthy' when DAYS_OVERDUE <= 30 then 'Watch' else 'Default' end
// confirmed against cds.parse.expr(...) — CQN's xpr escape hatch takes the keywords/branch
// conditions/values as a flat token array; each branch's condition tokens come from the
// same buildWhereExpr used for a normal "where" (full any/all/exists support, same column
// resolution/validation), never assembled from raw LLM strings.
function buildCaseWhenCol(spec, entityDef, schema) {
  const { as, when, else: elseVal } = spec;
  if (!as) throw new Error('"caseWhen" entries require an "as" alias.');
  if (!when?.length) throw new Error(`"caseWhen" entry "${as}" requires at least one "when" branch.`);

  const tokens = ['case'];
  for (const branch of when) {
    const condTokens = buildWhereExpr(branch.where, entityDef, schema);
    if (!condTokens) throw new Error(`"caseWhen" entry "${as}" has a "when" branch with no "where" conditions.`);
    if (branch.then === undefined) throw new Error(`"caseWhen" entry "${as}" has a "when" branch with no "then" value.`);
    tokens.push('when', ...condTokens, 'then', { val: branch.then });
  }
  if (elseVal !== undefined) tokens.push('else', { val: elseVal });
  tokens.push('end');

  return { xpr: tokens, as };
}

// Collects every column path referenced inside a "caseWhen" array's branch where-conditions —
// used to extend the entity-allowlist walk the same way every other section does.
function collectCaseWhenCols(caseWhenList) {
  return (caseWhenList || []).flatMap(c => (c.when || []).flatMap(branch => collectWhereCols(branch.where)));
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
  const ref = resolveColSpec(col);
  // valCol compares against another column instead of a literal (e.g. comparing
  // collateral.VALUE against AMOUNT on the same query) — CDS resolves it as a
  // normal path ref, generating a join the same way the main column would.
  const rhs = valCol ? resolveColSpec(valCol) : { val };

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
    return node.valCol ? [specPath(node.col), specPath(node.valCol)] : [specPath(node.col)];
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

// Builds the closed-open-interval WHERE condition for a temporal entity:
// from <= asOf AND to > asOf — same convention CDS's own temporal docs use.
// Confirmed hands-on against a real cds.deploy()'d temporal entity (both the
// `temporal` aspect and explicit @cds.valid.from/@cds.valid.to columns) that a
// plain read with no filter returns EVERY time slice, not just the one valid "now"
// — there is no implicit current-row filter at this query layer to rely on, so this
// applies regardless of whether the descriptor specifies "asOf" (defaulting to the
// current moment when it doesn't) rather than only when "asOf" is explicitly given.
function buildTemporalWhereExpr(temporal, asOf) {
  const asOfVal = asOf || new Date().toISOString();
  return [
    { ref: [temporal.from] }, '<=', { val: asOfVal },
    'and',
    { ref: [temporal.to] }, '>', { val: asOfVal },
  ];
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
    // Found via real NL testing: an LLM (correctly anticipating "single largest
    // order per customer" needs sorting) added "orderBy"/"orderDir" to an expand
    // node — a field this format never read at all, silently dropped, producing a
    // wrong (arbitrary-order, then truncated) result that looked plausible but
    // wasn't. Only a plain column is supported (sorting is done in JS post-fetch,
    // see truncateExpandRows) — reject a path explicitly rather than silently
    // misbehave the same way again.
    if (node.orderBy?.includes('.')) {
      throw new Error(`"expand" entry orderBy "${node.orderBy}" must be a plain column of "${node.assoc}" — paths are not supported here.`);
    }

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

    // NOT setting expandCol.limit here — confirmed against real HANA: CDS's
    // join-based expand rewriter (expandCQNToJoin.js) throws "Pagination is not
    // supported in expand" the moment a nested expand column carries a limit at
    // all. SQLite's expand implementation tolerates it, but we can't rely on
    // backend-specific behavior. The same maxExpandRows cap is enforced instead
    // by truncating each row's nested array post-fetch (see truncateExpandRows).

    return expandCol;
  });
}

// Generic comparator for the JS-side expand sort below: numeric comparison when
// both sides parse cleanly as finite numbers (covers HANA's decimal-as-string
// columns too), string comparison otherwise (works fine for dates — ISO strings
// sort correctly lexically — and plain text).
function compareForSort(a, b) {
  const na = Number(a), nb = Number(b);
  if (a != null && b != null && a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb;
  }
  return String(a).localeCompare(String(b));
}

// Enforces the same per-branch row cap that buildExpandCols used to push into the
// query itself (see comment above) — now applied client-side after cds.run(),
// since HANA's join-based expand engine rejects a limit on the nested column.
// Also applies "orderBy" (see buildExpandCols' validation comment for why this
// has to happen here, in JS, rather than in the query) — sort BEFORE truncating,
// so "single largest order per customer" (orderBy DESC + limit 1) actually keeps
// the largest one instead of an arbitrary row that happened to come back first.
function truncateExpandRows(rows, expandList, maxExpandRows) {
  if (!expandList?.length) return rows;
  for (const row of rows) {
    for (const node of expandList) {
      const cap = Math.min(node.limit || maxExpandRows, maxExpandRows);
      const nested = row[node.assoc];
      if (Array.isArray(nested)) {
        if (node.orderBy) {
          const dir = (node.orderDir || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
          nested.sort((a, b) => dir * compareForSort(a[node.orderBy], b[node.orderBy]));
        }
        if (nested.length > cap) nested.length = cap;
        if (node.expand?.length) truncateExpandRows(nested, node.expand, maxExpandRows);
      }
    }
  }
  return rows;
}

// Executes a "hierarchy" descriptor — unbounded traversal of a self-referencing
// association ("all descendants", "the full ancestor chain"), where a fixed-depth
// "assocAlias.assocAlias.COL" path can't reach an arbitrary number of hops.
//
// Implementation note: the extension plan's reference design proposes a single
// backend "WITH RECURSIVE" CTE (or HANA's HIERARCHY_DESCENDANTS/ANCESTORS table
// functions) executed via raw SQL. That requires knowing each backend's physical
// table-naming convention, which isn't reliably derivable from the CDS entity's
// logical fqn, and couldn't be verified hands-on against a live HANA/SQLite driver
// in this environment. Instead, this walks the tree level by level using the same
// validated cds.ql SELECT/where machinery as the rest of this module (an extra
// round trip per level, capped by maxHierarchyDepth) — slower than a single CTE on
// a deep tree, but reuses already-correct entity/column resolution instead of
// constructing raw SQL identifiers by hand.
//
// Algorithm: for a join { from, to } (column names on this same self-referencing
// entity), the next level's rows are those whose <to> column matches the current
// level's <from> column values — this holds for both directions, since it's just
// the join's own already-resolved key pair (works for "children" to walk down via
// from=ownKey/to=childFK, and for "parent" to walk up via from=ownFK/to=parentKey).
async function executeHierarchy(hierarchy, entityDef, schema, select, allBlocked, effectiveLimit, serverCfg) {
  const { assoc, direction, startWhere, maxDepth } = hierarchy;

  if (direction !== 'descendants' && direction !== 'ancestors') {
    throw new Error('"hierarchy.direction" must be "descendants" or "ancestors".');
  }
  const join = entityDef.joins?.[assoc];
  if (!join) {
    throw new Error(`Unknown association "${assoc}" for "hierarchy.assoc" — not found on "${entityDef.fqn}".`);
  }
  if (!join.recursive) {
    throw new Error(`"${assoc}" is not a self-referencing association — "hierarchy" requires one (see the schema's "self-referencing — hierarchy" marker).`);
  }
  if (!startWhere?.length) {
    throw new Error('"hierarchy.startWhere" must specify at least one condition to identify the root row(s).');
  }
  for (const col of collectWhereCols(startWhere)) {
    if (col.includes('.')) {
      throw new Error(`"hierarchy.startWhere" column "${col}" must be a plain column — paths are not supported here.`);
    }
  }

  const effectiveSelect = (select?.length ? select : Object.keys(entityDef.columns))
    .filter(c => !c.includes('.') && !allBlocked.has(c));
  if (!effectiveSelect.length) {
    throw new Error('"hierarchy" select columns must be plain columns of the entity (no association paths).');
  }

  // Track the join's own key columns across levels even if the caller didn't
  // request them in "select" — needed to find the next level — then strip them
  // back out of the rows actually returned.
  const fetchCols = [...new Set([join.from, join.to, entityDef.key, ...effectiveSelect])];

  const effectiveMaxDepth = Math.min(maxDepth ?? serverCfg.maxHierarchyDepth, serverCfg.maxHierarchyDepth);

  const seen = new Set();      // node keys already collected — guards against cycles
  const collected = [];
  let currentWhere = buildWhereExpr(startWhere, entityDef, schema);
  let depth = 0;

  while (currentWhere && depth <= effectiveMaxDepth && collected.length < effectiveLimit) {
    const q = SELECT.from(entityDef.fqn).columns(...fetchCols.map(colRef)).where(currentWhere)
      .limit(effectiveLimit - collected.length + 1);
    const levelRows = await cds.run(q);
    if (!levelRows.length) break;

    const newRows = levelRows.filter(row => {
      const key = row[entityDef.key];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!newRows.length) break;
    collected.push(...newRows);

    const nextIds = newRows.map(r => r[join.from]).filter(v => v != null);
    if (!nextIds.length) break;

    currentWhere = [{ ref: [join.to] }, 'in', { list: nextIds.map(v => ({ val: v })) }];
    depth++;
  }

  return collected.slice(0, effectiveLimit).map(row => {
    const out = {};
    for (const c of effectiveSelect) out[c] = row[c];
    return out;
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
 *   select    — columns, supports paths: ['PARTNER', 'customer.BU_SORT1', 'customer.dti.DTI_RATIO'].
 *               A select entry may also be { col: 'PARTNER', as: 'id' } to rename the output
 *               column explicitly — useful on its own, and required by "union"/"intersect"/
 *               "except" branches whose underlying column names differ but mean the same thing.
 *   where     — [{ col, op, val }]; col may be 'assoc.COL' for cross-entity conditions
 *   aggregate — [{ fn: 'count'|'sum'|'avg'|'min'|'max', col: 'COLUMN or assocAlias.COLUMN or *', as }]
 *
 *   Anywhere a "col"/"valCol" path is accepted in select/where/aggregate/having (NOT
 *   groupBy/orderBy), it may instead be a structured filtered-association form:
 *     { col: 'AMOUNT', viaFiltered: { assoc: 'payments', where: [{ col, op, val }] } }
 *   — applies the filter INSIDE the join to that association (e.g. "total of OPEN
 *   payments per loan"), not as a top-level WHERE. viaFiltered.where columns must be
 *   plain columns of the filtered association's own target entity (no further paths).
 *   groupBy   — ['COLUMN or assocAlias.COLUMN', ...]
 *   having    — [{ fn, col, op, val }] — filters on an aggregate value (e.g. count(LOAN_ID) > 5)
 *   search    — free-text term matched against the entity's @cds.search columns (AND-ed
 *               with any other where conditions); errors if the entity declares none
 *   expand    — [{ assoc, select, where, limit, expand }] — nests a to-many association/
 *               composition's rows instead of flattening them (one parent object with a
 *               nested array, via CAP's native expand). Can nest, but not two to-many
 *               levels deep (CQL limitation, validated up front).
 *   hierarchy — { assoc, direction: 'descendants'|'ancestors', startWhere, maxDepth } —
 *               unbounded traversal of a self-referencing association (org charts,
 *               account trees, BOMs) starting from the row(s) matched by startWhere.
 *               Mutually exclusive with where/aggregate/groupBy/having/search/expand/
 *               orderBy — only "select" and "limit" apply alongside it. maxDepth is
 *               capped server-side regardless of what's requested.
 *   window    — [{ fn, as, col?, offset?, buckets?, partitionBy?, orderBy? }] — per-row
 *               ranking/running-value columns (RANK/ROW_NUMBER/DENSE_RANK/NTILE/LAG/LEAD,
 *               or SUM/AVG/COUNT/MIN/MAX used as a running aggregate) computed OVER a
 *               partition — unlike "aggregate"+"groupBy", every row is kept. Cannot be
 *               combined with aggregate/groupBy/having/expand.
 *   windowFilter — [{ col, op, val }] — filters on a "window" column's alias (e.g. "top 3
 *               per group"); a plain top-level "where" cannot reference a window-function
 *               result (standard SQL evaluates WHERE before window functions), so this
 *               wraps the query in a derived-table SELECT instead. Requires "window".
 *   caseWhen  — [{ as, when: [{ where, then }], else }] — a computed CASE WHEN column;
 *               "where" uses the same condition shape (incl. any/all/exists) as a normal
 *               "where" clause; branches are evaluated in order, first match wins.
 *   asOf      — 'YYYY-MM-DD' (or full ISO timestamp) — time-travel read for a temporal
 *               entity (one whose schema shows "[temporal: valid from X to Y]"): adds
 *               an explicit "from <= asOf AND to > asOf" condition. Only valid on a
 *               temporal entity. If omitted on a temporal entity, defaults to the
 *               current moment — a plain read of a temporal entity with no filter at
 *               all returns EVERY time slice, not just the current one (confirmed
 *               against a real cds.deploy()'d temporal entity), so this default is
 *               applied even when "asOf" isn't given.
 *   orderBy   — column or 'assoc.COL'
 *   orderDir  — 'ASC' | 'DESC'
 *   limit     — rows requested (capped by server maxRows, enforced at SQL LIMIT)
 *   offset    — rows to skip for pagination (capped by server maxOffset, default 0)
 *
 * Alternatively, a top-level "union"/"intersect"/"except" array of ORDINARY branch
 * descriptors (each one is everything above, recursively) combines independently-run
 * result sets in plain JS — mutually exclusive with entity/select/where/etc. at the top
 * level, and with each other (only one of the three set-ops per descriptor):
 *   union     — [<descriptor>, <descriptor>, ...] (2+) — concatenates branch results.
 *               "distinct": true|false (default false) controls UNION vs UNION ALL semantics.
 *   intersect — same shape — rows present in EVERY branch (deduped, like real INTERSECT).
 *   except    — same shape — rows in the FIRST branch absent from every other branch.
 *   Every branch must resolve to the same number of output columns (validated up front);
 *   alias columns with select's { col, as } form if the underlying names differ.
 *   "limit" still applies (to the combined result); each branch is independently capped
 *   to that same limit before combining so one branch can't return unbounded rows.
 *
 * callConfig (per-call input param overrides — merged with server config):
 *   allowedEntities — restrict queryable entities for this call (intersects with server list)
 *   blockedColumns  — additional columns to strip for this call (unions with server list)
 *   maxRows         — lower the row cap for this call
 */
async function executeDescriptor(descriptor, schema, callConfig = {}) {
  const setOp = SET_OPS.find(op => descriptor[op] !== undefined);
  if (setOp) return executeSetOp(setOp, descriptor, schema, callConfig);

  const {
    entity,
    select,
    where,
    aggregate,
    groupBy,
    having,
    search,
    expand,
    hierarchy,
    window: windowList,
    windowFilter,
    caseWhen,
    asOf,
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

  if (hierarchy) {
    if (where?.length || aggregate?.length || groupBy?.length || having?.length || search || expand?.length || orderBy) {
      throw new Error('"hierarchy" cannot be combined with where, aggregate, groupBy, having, search, expand, or orderBy — only "select" and "limit".');
    }
    const callMax = callConfig.maxRows || Infinity;
    const effectiveLimit = Math.min(rawLimit, serverCfg.maxRows, callMax);
    const allBlocked = new Set([...serverCfg.blockedColumns, ...(callConfig.blockedColumns || [])]);
    return executeHierarchy(hierarchy, entityDef, schema, select, allBlocked, effectiveLimit, serverCfg);
  }

  if (expand?.length) validateExpandNesting(expand, entityDef, schema, false);

  // groupBy/orderBy are passed to cds.ql's builder as plain path strings — it does
  // not accept a structured ref there, so viaFiltered (only meaningful as a value
  // being selected/aggregated/compared, not as a grouping/sort key) is rejected here
  // with a clear error instead of producing a broken query.
  if ((groupBy || []).some(isFilteredSpec) || isFilteredSpec(orderBy)) {
    throw new Error('viaFiltered is not supported in "groupBy" or "orderBy" — only in "select" and "where".');
  }

  // Confirmed against real HANA: when a viaFiltered ref is used as an aggregate
  // function's argument, the LEGACY @sap/hana-client-based runtime's internal
  // generateAliases utility crashes with "table.startsWith is not a function" — it
  // assumes ref[0] is always a plain string table alias, but viaFiltered produces a
  // structured { id, where } hop there. Reproduces with or without "groupBy"
  // present. "having" hits the identical crash via the same buildAggregateCol()
  // path buildHavingExpr() calls into (re-tested hands-on with a correctly-formed
  // { fn, col, op, val } having entry, not just inferred from the aggregate case).
  //
  // Confirmed this is specifically a legacy-runtime bug, not a fundamental CQN
  // incompatibility: re-ran the identical CQN directly against a real BTP HANA
  // deployment with the modern @cap-js/hana adapter installed instead, and it
  // returned correct, mathematically-verified results (filtered sums matching
  // hand-computed totals) — no crash. So gate this the same way as the "window"
  // check below: only reject on the legacy runtime (no db.cqn2sql), not universally.
  if (
    typeof cds.db?.cqn2sql !== 'function' &&
    ((aggregate || []).some(a => isFilteredSpec(a.col)) || (having || []).some(h => isFilteredSpec(h.col)))
  ) {
    throw new Error('viaFiltered is not supported as an "aggregate" or "having" column on the legacy @sap/hana-client-based HANA runtime — its query builder cannot resolve a filtered-association argument inside an aggregate function. A modern @cap-js/db-service-based adapter (e.g. @cap-js/hana) supports this correctly. Use "select"/"where" instead if you can\'t switch adapters.');
  }

  // "window" keeps every row and attaches a per-row computed value — a different query
  // shape than "aggregate"+"groupBy" (which collapses rows), so the two can't be mixed.
  if (windowList?.length && (aggregate?.length || groupBy?.length || having?.length || expand?.length)) {
    throw new Error('"window" cannot be combined with aggregate, groupBy, having, or expand.');
  }

  // Confirmed against real HANA (not caught by the SQLite-based test suite, which
  // uses @cap-js/sqlite — a modern @cap-js/db-service-based adapter): the CQN shape
  // this package builds for window functions ({func, args, xpr: ['over', ...]}) is
  // correct per CAP's current standard — @cap-js/db-service's shared func() renderer
  // explicitly handles the xpr sibling. But @sap/cds's legacy, @sap/hana-client-based
  // HANA runtime (still the default/peer-dep target for this package, and what most
  // existing CAP+HANA projects use today) silently drops that xpr sibling, producing
  // a function call with no OVER clause at all and a downstream HANA syntax error.
  // A modern adapter (@cap-js/hana, built on the same @cap-js/db-service base as
  // @cap-js/sqlite) would very likely render this correctly, but switching HANA
  // drivers is the consuming project's decision, not something this package can do
  // for them. Detect which kind of adapter is actually connected — modern
  // @cap-js/db-service-based services expose db.cqn2sql directly, the legacy one
  // does not — and reject with an actionable message rather than the SQL gets a step
  // further only to come back as a cryptic "incorrect syntax near AS" from HANA.
  if (windowList?.length && typeof cds.db?.cqn2sql !== 'function') {
    throw new Error(
      '"window" functions are not supported against this database connection. ' +
      'The legacy @sap/hana-client-based HANA runtime does not render the OVER clause ' +
      '— this requires a modern @cap-js/db-service-based adapter (e.g. @cap-js/hana for ' +
      'HANA, already the case for @cap-js/sqlite if that\'s what\'s connected). ' +
      'Use "aggregate"+"groupBy" instead if a per-group total/count is enough.'
    );
  }
  if (windowFilter?.length && !windowList?.length) {
    throw new Error('"windowFilter" requires "window" to be present.');
  }
  if (windowFilter?.length) {
    const windowAliases = new Set(windowList.map(w => w.as));
    for (const cond of windowFilter) {
      if (cond.any || cond.all || cond.exists || cond.notExists || cond.valCol) {
        throw new Error('"windowFilter" only supports plain { col, op, val } conditions referencing a "window" alias.');
      }
      if (!windowAliases.has(cond.col)) {
        throw new Error(`"windowFilter" column "${cond.col}" must reference a declared "window" alias.`);
      }
    }
  }

  // Enforce the allowlist on entities reached via association-path joins too —
  // e.g. querying "BCA_DTI" but selecting "customer.BU_SORT1" reads BusinessPartners,
  // which must independently pass the same allowlist check as the top-level entity.
  const allPaths = [
    ...(select || []).map(specPath),
    ...collectWhereCols(where),
    // Append a dummy trailing segment so collectJoinedEntities (which treats the
    // last path segment as the leaf column) resolves every alias hop, including
    // the exists/notExists target itself, not just the hops before it.
    ...collectExistsPaths(where).map(p => `${p}.__exists_target__`),
    ...(aggregate || []).filter(a => a.col !== '*').map(a => specPath(a.col)),
    ...(groupBy || []),
    ...(having || []).filter(h => h.col !== '*').map(h => specPath(h.col)),
    ...(orderBy ? [orderBy] : []),
    ...collectWindowCols(windowList),
    ...collectCaseWhenCols(caseWhen),
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
  if (select?.length || aggregate?.length || expand?.length || windowList?.length || caseWhen?.length) {
    // When "expand" is used without an explicit "select", default to all of the
    // parent entity's own columns (mirrors the no-select-no-expand "all columns"
    // behavior below) — q.columns() must be called explicitly once any nested
    // expand column is added, so there's no implicit "SELECT *" fallback here.
    const effectiveSelect = select?.length ? select : (aggregate?.length ? [] : Object.keys(entityDef.columns));
    const filteredSelect = effectiveSelect.filter(c => !allBlocked.has(specPath(c).split('.').pop()));
    const filteredAggregate = (aggregate || []).filter(a => a.col === '*' || !allBlocked.has(specPath(a.col).split('.').pop()));

    // The LLM is told (rule 7) never to select the same leaf column name twice
    // (e.g. "CURRENCY" via the top-level entity AND via "loan.CURRENCY"), but a
    // cheap model occasionally does it anyway — HANA then rejects the query with
    // "Duplicate column names". Rather than depend on prompt compliance, alias any
    // joined-path column (length > 1) whose leaf name collides with another
    // selected column, so the query is always valid regardless of what the LLM did.
    //
    // Note for callers: an UNALIASED joined column with no collision (e.g.
    // "sector.DESCRIPTION" selected alone) keeps its bare leaf name on this
    // backend's legacy HANA runtime ("DESCRIPTION"), but a modern @cap-js/db-
    // service-based adapter names it "sector_DESCRIPTION" by default — confirmed
    // against a real deployment, see examples/capability-demo/README.md. Pass an
    // explicit "as" whenever the result key needs to be stable across backends.
    const leafCounts = {};
    for (const c of filteredSelect) {
      const leaf = specPath(c).split('.').pop();
      leafCounts[leaf] = (leafCounts[leaf] || 0) + 1;
    }
    const selectCols = filteredSelect.map(c => {
      const explicitAlias = specAlias(c);
      const parts = specPath(c).split('.');
      const leaf = parts[parts.length - 1];

      // A calculated-on-read column (e.g. FULL = FIRST || ' ' || LAST) is not
      // guaranteed to be a real physical column on every backend — confirmed
      // against a real HANA deployment, which never materialized one. Substitute
      // the original expression directly instead of a column ref that may not
      // resolve. Only applies to plain top-level columns (parts.length === 1);
      // a calculated column reached via a join path isn't supported here.
      if (parts.length === 1 && !isFilteredSpec(c)) {
        const calcExpr = entityDef.columns[leaf]?.calcExpr;
        if (calcExpr) return { ...calcExpr, as: explicitAlias || leaf };
      }

      if (explicitAlias) return { ...resolveColSpec(c), as: explicitAlias };

      if (leafCounts[leaf] > 1 && parts.length > 1 && !isFilteredSpec(c)) {
        return { ref: parts, as: parts.join('_') };
      }
      const ref = resolveColSpec(c);
      return leafCounts[leaf] > 1 ? { ...ref, as: parts.join('_') } : ref;
    });
    const aggregateCols = filteredAggregate.map(buildAggregateCol);
    const expandCols = expand?.length
      ? buildExpandCols(expand, entityDef, schema, allBlocked, serverCfg.maxExpandRows)
      : [];
    const windowCols = windowList?.length ? windowList.map(buildWindowCol) : [];
    const caseWhenCols = caseWhen?.length ? caseWhen.map(c => buildCaseWhenCol(c, entityDef, schema)) : [];
    cols = [...selectCols, ...aggregateCols, ...expandCols, ...windowCols, ...caseWhenCols];
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

  if (entityDef.temporal) {
    const temporalExpr = buildTemporalWhereExpr(entityDef.temporal, asOf);
    whereExpr = whereExpr ? joinTokens('and', [whereExpr, temporalExpr]) : temporalExpr;
  } else if (asOf) {
    throw new Error(`"asOf" was given but entity "${entity}" is not temporal (no @cds.valid.from/@cds.valid.to columns).`);
  }

  if (whereExpr) q.where(whereExpr);

  if (groupBy?.length) q.groupBy(...groupBy);

  const havingExpr = buildHavingExpr(having);
  if (havingExpr) q.having(havingExpr);

  // A window function's result alias can't be referenced in a WHERE clause at the
  // same query level (standard SQL evaluates WHERE before window functions are
  // computed) — "top 3 per group" needs a derived-table wrap instead. Confirmed
  // SELECT.from(<built CQN SELECT>) works as a derived-table source against the
  // installed cds.ql. orderBy/limit apply to the OUTER query once wrapped, since
  // they're meant to control the final result, not the pre-filter row set.
  let finalQ = q;
  if (windowFilter?.length) {
    finalQ = SELECT.from(q).where(buildWhereExpr(windowFilter));
  }

  if (orderBy) {
    finalQ.orderBy([{ ...colRef(orderBy), sort: (orderDir || 'ASC').toLowerCase() }]);
  }

  finalQ.limit(effectiveLimit, effectiveOffset);   // single SQL LIMIT/OFFSET — HANA enforces it, not Node.js

  let rows = await cds.run(finalQ);
  if (expand?.length) rows = truncateExpandRows(rows, expand, serverCfg.maxExpandRows);

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

const SET_OPS = ['union', 'intersect', 'except'];

// Canonical row key for set-logic comparisons — sorts keys so two rows produced
// by differently-ordered branch selects (but the same logical column names, e.g.
// via "as" aliasing) still compare equal.
function rowKey(row) {
  return JSON.stringify(Object.keys(row).sort().map(k => row[k]));
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// Standard SQL INTERSECT/EXCEPT semantics: compare the first branch's rows against
// every other branch's row keys, and (like real INTERSECT/EXCEPT, which imply DISTINCT)
// dedupe the first branch's own rows too.
function combineSetOp(setOp, branchResults) {
  const [first, ...rest] = branchResults;
  const restKeySets = rest.map(rows => new Set(rows.map(rowKey)));
  const seen = new Set();
  const out = [];
  for (const row of first) {
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const matches = setOp === 'intersect'
      ? restKeySets.every(s => s.has(key))
      : restKeySets.every(s => !s.has(key));
    if (matches) out.push(row);
  }
  return out;
}

// Counts how many output columns a branch descriptor would resolve to, WITHOUT
// running it — mirrors executeDescriptor's own "cols?.length" condition and column-
// list assembly (select/aggregate/expand/window/caseWhen all contribute columns)
// closely enough to catch a column-count mismatch up front with a clear error,
// instead of letting it surface later as a confusing partial/misaligned result.
// Returns null for an unknown entity — executeDescriptor's own per-branch call
// will raise the real "Unknown entity" error for that case.
function countBranchColumns(branchDescriptor, schema) {
  const { entity, select, aggregate, expand, window: windowList, caseWhen } = branchDescriptor;
  const entityDef = schema[entity];
  if (!entityDef) return null;
  if (select?.length || aggregate?.length || expand?.length || windowList?.length || caseWhen?.length) {
    const selectCount = select?.length ? select.length : (aggregate?.length ? 0 : Object.keys(entityDef.columns).length);
    return selectCount + (aggregate?.length || 0) + (expand?.length || 0) + (windowList?.length || 0) + (caseWhen?.length || 0);
  }
  return Object.keys(entityDef.columns).length;
}

const NORMAL_DESCRIPTOR_KEYS = [
  'entity', 'select', 'where', 'aggregate', 'groupBy', 'having', 'search', 'expand',
  'hierarchy', 'window', 'windowFilter', 'caseWhen', 'orderBy', 'orderDir',
];

// Executes a "union"/"intersect"/"except" descriptor: each branch is an ordinary,
// already-supported descriptor, run through the existing, unmodified executeDescriptor()
// — every existing security check (entity allowlist, column blocklist, row cap) already
// applies per-branch with zero new code. Combining is then plain JS array/Set logic, never
// new SQL — confirmed lowest-risk per the extension plan, since this package already
// reduces every descriptor down to a plain row array before this point.
async function executeSetOp(setOp, descriptor, schema, callConfig) {
  const branches = descriptor[setOp];
  if (!Array.isArray(branches) || branches.length < 2) {
    throw new Error(`"${setOp}" requires an array of at least 2 branch descriptors.`);
  }
  for (const op of SET_OPS) {
    if (op !== setOp && descriptor[op] !== undefined) {
      throw new Error('A descriptor can only use one of "union", "intersect", or "except" at a time.');
    }
  }
  for (const key of NORMAL_DESCRIPTOR_KEYS) {
    if (descriptor[key] !== undefined) {
      throw new Error(`"${setOp}" cannot be combined with top-level "${key}" — each branch is its own descriptor.`);
    }
  }

  const serverCfg = require('./config');
  const callMax = callConfig.maxRows || Infinity;
  const effectiveLimit = Math.min(descriptor.limit ?? 50, serverCfg.maxRows, callMax);

  const counts = branches.map(b => countBranchColumns(b, schema));
  if (counts.every(c => c != null) && new Set(counts).size > 1) {
    throw new Error(
      `"${setOp}" branches must all select the same number of columns (got: ${counts.join(', ')}). ` +
      `Alias columns to a shared name with { "col": "...", "as": "..." } if the underlying column names differ.`
    );
  }

  const branchResults = [];
  for (const branch of branches) {
    const branchConfig = { ...callConfig, maxRows: effectiveLimit };
    const branchLimit = Math.min(branch.limit ?? effectiveLimit, effectiveLimit);
    branchResults.push(await executeDescriptor({ ...branch, limit: branchLimit }, schema, branchConfig));
  }

  let rows;
  if (setOp === 'union') {
    rows = branchResults.flat();
    if (descriptor.distinct) rows = dedupeRows(rows);
  } else {
    rows = combineSetOp(setOp, branchResults);
  }

  return rows.slice(0, effectiveLimit);
}

module.exports = { executeDescriptor };
