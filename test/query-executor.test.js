'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { executeDescriptor } = require('../src/query-executor');

// Window functions require a modern @cap-js/db-service-based adapter (confirmed
// against real HANA: the legacy @sap/hana-client runtime silently drops the OVER
// clause). The executor detects this via db.cqn2sql — present on modern adapters,
// absent on the legacy one. Every test in this file assumes a modern adapter is
// connected unless it explicitly says otherwise (see the dedicated rejection test).
cds.db = { cqn2sql: () => {} };

// Minimal synthetic schema matching what schema-reader.js would produce.
const schema = {
  Orders: {
    key: 'ID', fqn: 'app.Orders',
    columns: { ID: { type: 'String' }, AMOUNT: { type: 'Decimal' }, SECRET: { type: 'String' } },
    joins: {
      customer: { entity: 'Customers', from: 'CUSTOMER', to: 'ID', type: 'INNER' },
      items:    { entity: 'Items', from: 'ID', to: 'ORDER_ID', type: 'LEFT', toMany: true },
    },
    searchableColumns: ['ID'],
  },
  Customers: {
    key: 'ID', fqn: 'app.Customers',
    columns: { ID: { type: 'String' }, NAME: { type: 'String' } },
    joins: {},
  },
  Items: {
    key: 'ID', fqn: 'app.Items',
    columns: {
      ID: { type: 'String' }, PRODUCT: { type: 'String' }, QTY: { type: 'Integer' }, SECRET: { type: 'String' },
      STATUS: { type: 'String', enum: { O: 'open', C: 'closed' } },
    },
    joins: {
      productRef: { entity: 'Products', from: 'PRODUCT', to: 'ID', type: 'INNER', toMany: false },
      parts:      { entity: 'Parts', from: 'ID', to: 'ITEM_ID', type: 'LEFT', toMany: true },
    },
  },
  Products: {
    key: 'ID', fqn: 'app.Products',
    columns: { ID: { type: 'String' }, NAME: { type: 'String' } },
    joins: {},
  },
  Parts: {
    key: 'ID', fqn: 'app.Parts',
    columns: { ID: { type: 'String' }, NAME: { type: 'String' } },
    joins: {},
  },
  Accounts: {
    key: 'ID', fqn: 'app.Accounts',
    columns: { ID: { type: 'String' }, NAME: { type: 'String' }, PARENT_ID: { type: 'String' } },
    joins: {
      parent:   { entity: 'Accounts', from: 'PARENT_ID', to: 'ID', type: 'INNER', toMany: false, recursive: true },
      children: { entity: 'Accounts', from: 'ID', to: 'PARENT_ID', type: 'LEFT', toMany: true, recursive: true },
    },
  },
  WorkAssignments: {
    key: 'ID', fqn: 'app.WorkAssignments',
    columns: { ID: { type: 'String' }, ROLE: { type: 'String' }, validFrom: { type: 'Timestamp' }, validTo: { type: 'Timestamp' } },
    joins: {},
    temporal: { from: 'validFrom', to: 'validTo' },
  },
};

// Intercepts cds.run() so we can assert on the CQN query that would have been
// sent to the database, without needing a live connection.
function captureQuery() {
  const original = cds.run;
  let captured = null;
  cds.run = async q => { captured = q; return []; };
  return {
    get: () => captured,
    restore: () => { cds.run = original; },
  };
}

// Mocks cds.run to return one canned response per call, in order — used by the
// "hierarchy" tests where each tree level issues its own SELECT.
function mockRunSequence(responses) {
  const original = cds.run;
  let i = 0;
  const calls = [];
  cds.run = async q => { calls.push(q); return responses[i++] || []; };
  return { calls, restore: () => { cds.run = original; } };
}

test('blocked columns are never sent to SQL, even with no explicit select', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor({ entity: 'Orders' }, schema, { blockedColumns: ['SECRET'] });
    const cols = capture.get().SELECT.columns.map(c => c.ref.join('.'));
    assert.ok(!cols.includes('SECRET'), 'SECRET must not appear in the SQL column list');
    assert.ok(cols.includes('ID') && cols.includes('AMOUNT'));
  } finally {
    capture.restore();
  }
});

test('entity allowlist blocks the top-level entity', async () => {
  await assert.rejects(
    () => executeDescriptor({ entity: 'Orders' }, schema, { allowedEntities: ['Customers'] }),
    /not in the per-call allowed_entities list/
  );
});

test('entity allowlist also blocks entities reached via association join', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID', 'customer.NAME'] },
      schema,
      { allowedEntities: ['Orders'] } // Customers deliberately excluded
    ),
    /reached via association join/
  );
});

test('allowlist permits a join when both entities are listed', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', select: ['ID', 'customer.NAME'] },
      schema,
      { allowedEntities: ['Orders', 'Customers'] }
    );
    assert.ok(capture.get(), 'query should have been built and executed');
  } finally {
    capture.restore();
  }
});

test('valCol compares two columns instead of a literal', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', where: [{ col: 'AMOUNT', op: '<', valCol: 'ID' }] },
      schema, {}
    );
    const where = capture.get().SELECT.where;
    // [ {ref:['AMOUNT']}, '<', {ref:['ID']} ] — rhs must be a ref, not a literal val
    assert.ok(where[2].ref, 'right-hand side of valCol comparison must be a column ref, not a literal');
  } finally {
    capture.restore();
  }
});

test('like operator wraps both sides in UPPER() for case-insensitive matching', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', where: [{ col: 'ID', op: 'like', val: 'abc' }] },
      schema, {}
    );
    const where = capture.get().SELECT.where;
    assert.equal(where[0].func, 'upper');
    assert.equal(where[2].val, '%ABC%');
  } finally {
    capture.restore();
  }
});

test('any group produces an OR-ed, parenthesized (xpr) condition', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        where: [
          { any: [
            { col: 'ID', op: '=', val: 'A' },
            { col: 'ID', op: '=', val: 'B' },
          ] },
          { col: 'AMOUNT', op: '>', val: 10 },
        ],
      },
      schema, {}
    );
    const where = capture.get().SELECT.where;
    assert.ok(where[0].xpr, 'OR group must be wrapped in {xpr:[...]} for correct precedence');
    assert.ok(where[0].xpr.includes('or'));
    assert.equal(where[1], 'and');
  } finally {
    capture.restore();
  }
});

test('any group referencing a blocked-via-allowlist joined entity is still caught', async () => {
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Orders',
        where: [
          { any: [{ col: 'customer.NAME', op: '=', val: 'X' }] },
        ],
      },
      schema,
      { allowedEntities: ['Orders'] } // Customers deliberately excluded
    ),
    /reached via association join/
  );
});

test('aggregate produces a CQN function-call column with groupBy and having', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['customer.NAME'],
        aggregate: [{ fn: 'count', col: 'ID', as: 'order_count' }],
        groupBy: ['customer.NAME'],
        having: [{ fn: 'count', col: 'ID', op: '>', val: 5 }],
      },
      schema, {}
    );
    const sel = capture.get().SELECT;
    const countCol = sel.columns.find(c => c.func === 'count');
    assert.ok(countCol, 'aggregate column must be a {func,args} CQN node');
    assert.equal(countCol.as, 'order_count');
    assert.deepEqual(countCol.args, [{ ref: ['ID'] }]);
    assert.ok(sel.groupBy.some(g => g.ref.join('.') === 'customer.NAME'));
    assert.equal(sel.having[0].func, 'count');
    assert.equal(sel.having[1], '>');
    assert.equal(sel.having[2].val, 5);
  } finally {
    capture.restore();
  }
});

test('aggregate with col "*" maps to count(1)', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', aggregate: [{ fn: 'count', col: '*', as: 'total' }] },
      schema, {}
    );
    const countCol = capture.get().SELECT.columns.find(c => c.func === 'count');
    assert.deepEqual(countCol.args, [{ val: 1 }]);
  } finally {
    capture.restore();
  }
});

test('aggregate referencing a column blocked via blockedColumns is stripped', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', aggregate: [{ fn: 'sum', col: 'SECRET' }] },
      schema, { blockedColumns: ['SECRET'] }
    );
    const cols = capture.get().SELECT.columns || [];
    assert.equal(cols.length, 0, 'aggregate over a blocked column must not reach SQL');
  } finally {
    capture.restore();
  }
});

test('aggregate referencing a joined entity is enforced by the allowlist', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', aggregate: [{ fn: 'count', col: 'customer.ID' }] },
      schema,
      { allowedEntities: ['Orders'] } // Customers deliberately excluded
    ),
    /reached via association join/
  );
});

test('exists produces a native EXISTS infix-filter CQN node', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', where: [{ exists: 'customer', where: [{ col: 'NAME', op: '=', val: 'Acme' }] }] },
      schema, {}
    );
    const where = capture.get().SELECT.where;
    assert.equal(where[0].xpr[0], 'exists');
    assert.deepEqual(where[0].xpr[1].ref[0].id, 'customer');
    assert.deepEqual(where[0].xpr[1].ref[0].where, [{ ref: ['NAME'] }, '=', { val: 'Acme' }]);
  } finally {
    capture.restore();
  }
});

test('notExists produces a native NOT EXISTS infix-filter CQN node', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', where: [{ notExists: 'customer', where: [{ col: 'NAME', op: '=', val: 'Acme' }] }] },
      schema, {}
    );
    const where = capture.get().SELECT.where;
    assert.deepEqual(where[0].xpr.slice(0, 2), ['not', 'exists']);
  } finally {
    capture.restore();
  }
});

test('exists rejects a path-valued column inside the inner filter', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', where: [{ exists: 'customer', where: [{ col: 'loan.STATUS', op: '=', val: 'A' }] }] },
      schema, {}
    ),
    /paths inside an exists\/notExists filter are not supported/
  );
});

test('exists target entity is enforced by the allowlist', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', where: [{ exists: 'customer', where: [{ col: 'NAME', op: '=', val: 'Acme' }] }] },
      schema,
      { allowedEntities: ['Orders'] } // Customers deliberately excluded
    ),
    /reached via association join/
  );
});

test('row limit is capped by server maxRows', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor({ entity: 'Orders', limit: 1000 }, schema, { maxRows: 10 });
    assert.equal(capture.get().SELECT.limit.rows.val, 10);
  } finally {
    capture.restore();
  }
});

test('offset is passed through to the SQL LIMIT/OFFSET clause', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor({ entity: 'Orders', limit: 50, offset: 100 }, schema, {});
    assert.equal(capture.get().SELECT.limit.offset.val, 100);
  } finally {
    capture.restore();
  }
});

test('offset is capped by server maxOffset', async () => {
  const capture = captureQuery();
  const config = require('../src/config');
  const original = config.maxOffset;
  config.maxOffset = 1000;
  try {
    await executeDescriptor({ entity: 'Orders', offset: 999999 }, schema, {});
    assert.equal(capture.get().SELECT.limit.offset.val, 1000);
  } finally {
    config.maxOffset = original;
    capture.restore();
  }
});

test('unknown entity throws a clear error', async () => {
  await assert.rejects(
    () => executeDescriptor({ entity: 'DoesNotExist' }, schema, {}),
    /Unknown entity/
  );
});

test('search builds an OR-of-LIKE condition across searchableColumns', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor({ entity: 'Orders', search: 'abc' }, schema, {});
    const where = capture.get().SELECT.where;
    assert.ok(where[0].xpr, 'search must be wrapped in (xpr) for correct precedence');
    assert.equal(where[0].xpr[0].func, 'upper');
    assert.equal(where[0].xpr[2].val, '%ABC%');
  } finally {
    capture.restore();
  }
});

test('search is AND-ed with other where conditions', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', where: [{ col: 'AMOUNT', op: '>', val: 10 }], search: 'abc' },
      schema, {}
    );
    const where = capture.get().SELECT.where;
    assert.equal(where[3], 'and');
    assert.ok(where[4].xpr, 'search group must follow the other where conditions, AND-ed');
  } finally {
    capture.restore();
  }
});

test('search on an entity with no searchableColumns throws a clear error', async () => {
  await assert.rejects(
    () => executeDescriptor({ entity: 'Customers', search: 'abc' }, schema, {}),
    /has no @cds\.search columns declared/
  );
});

test('expand produces a nested { ref, expand } CQN column', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', select: ['ID'], expand: [{ assoc: 'items', select: ['PRODUCT', 'QTY'] }] },
      schema, {}
    );
    const cols = capture.get().SELECT.columns;
    const expandCol = cols.find(c => c.ref?.[0] === 'items');
    assert.ok(expandCol, 'expand column must be present');
    assert.deepEqual(expandCol.expand.map(c => c.ref[0]), ['PRODUCT', 'QTY']);
    // Confirmed against real HANA: a "limit" on a nested expand column makes CDS's
    // own join-based expand rewriter throw "Pagination is not supported in expand".
    // The row cap is enforced post-fetch instead (see the row-cap test below) — the
    // CQN itself must never carry a limit on an expand column.
    assert.equal(expandCol.limit, undefined, 'expand column must NOT carry a limit in the CQN');
  } finally {
    capture.restore();
  }
});

test('expand defaults to all parent columns when no top-level select is given', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor({ entity: 'Orders', expand: [{ assoc: 'items', select: ['PRODUCT'] }] }, schema, {});
    const cols = capture.get().SELECT.columns;
    assert.ok(cols.some(c => c.ref?.[0] === 'ID'), 'plain parent columns must still be selected');
    assert.ok(cols.some(c => c.ref?.[0] === 'AMOUNT'));
  } finally {
    capture.restore();
  }
});

test('expand strips blocked columns from the nested select', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', select: ['ID'], expand: [{ assoc: 'items', select: ['PRODUCT', 'SECRET'] }] },
      schema, { blockedColumns: ['SECRET'] }
    );
    const expandCol = capture.get().SELECT.columns.find(c => c.ref?.[0] === 'items');
    assert.ok(!expandCol.expand.some(c => c.ref[0] === 'SECRET'), 'blocked column must not appear inside expand');
  } finally {
    capture.restore();
  }
});

test('expand row cap is bounded by server maxExpandRows (enforced post-fetch)', async () => {
  // The cap can no longer be pushed into the query itself (see the test above) —
  // it's enforced by truncating each row's nested array after cds.run() returns.
  const mock = mockRunSequence([[
    { ID: 'O1', items: [{ PRODUCT: 'P1' }, { PRODUCT: 'P2' }, { PRODUCT: 'P3' }, { PRODUCT: 'P4' }, { PRODUCT: 'P5' }] },
  ]]);
  const config = require('../src/config');
  const original = config.maxExpandRows;
  config.maxExpandRows = 3;
  try {
    const rows = await executeDescriptor(
      { entity: 'Orders', select: ['ID'], expand: [{ assoc: 'items', select: ['PRODUCT'], limit: 999 }] },
      schema, {}
    );
    assert.equal(rows[0].items.length, 3, 'nested array must be truncated to maxExpandRows regardless of the requested limit');
  } finally {
    config.maxExpandRows = original;
    mock.restore();
  }
});

test('expand orderBy sorts before limit is applied — keeps the actual largest, not an arbitrary row', async () => {
  // Found via real NL testing: an LLM asked for "each customer's single largest
  // order" and produced an expand entry with orderBy/orderDir + limit:1 — a field
  // this code never read at all before this fix, silently dropping it and
  // truncating to whatever row happened to come back first (a real, wrong answer
  // that looked plausible). DB returns items out of amount order on purpose here,
  // to prove the sort — not the cap alone — is what selects the right one.
  const mock = mockRunSequence([[
    { ID: 'O1', items: [{ PRODUCT: 'cheap', AMOUNT: 10 }, { PRODUCT: 'expensive', AMOUNT: 999 }, { PRODUCT: 'mid', AMOUNT: 50 }] },
  ]]);
  try {
    const rows = await executeDescriptor(
      {
        entity: 'Orders', select: ['ID'],
        expand: [{ assoc: 'items', select: ['PRODUCT', 'AMOUNT'], orderBy: 'AMOUNT', orderDir: 'DESC', limit: 1 }],
      },
      schema, {}
    );
    assert.deepEqual(rows[0].items, [{ PRODUCT: 'expensive', AMOUNT: 999 }]);
  } finally {
    mock.restore();
  }
});

test('expand orderBy rejects an association path — only a plain column is supported', async () => {
  const capture = captureQuery();
  try {
    await assert.rejects(
      () => executeDescriptor(
        { entity: 'Orders', select: ['ID'], expand: [{ assoc: 'items', orderBy: 'productRef.NAME' }] },
        schema, {}
      ),
      /orderBy "productRef\.NAME" must be a plain column/
    );
  } finally {
    capture.restore();
  }
});

test('enum-to-text translation recurses into expand\'s nested rows', async () => {
  // Found via real NL testing: the original implementation only translated the
  // TOP-LEVEL entity's own enum columns. Orders.STATUS got its _text sibling when
  // Orders was queried directly, but not when reached via expand from Customers —
  // same root-cause class as the orderBy bug above (a per-row JS post-processing
  // step that never recursed into expand's children).
  const mock = mockRunSequence([[
    { ID: 'O1', items: [{ ID: 'I1', STATUS: 'O' }, { ID: 'I2', STATUS: 'C' }] },
  ]]);
  try {
    const rows = await executeDescriptor(
      { entity: 'Orders', select: ['ID'], expand: [{ assoc: 'items', select: ['ID', 'STATUS'] }] },
      schema, {}
    );
    assert.deepEqual(rows[0].items, [
      { ID: 'I1', STATUS: 'O', STATUS_text: 'open' },
      { ID: 'I2', STATUS: 'C', STATUS_text: 'closed' },
    ]);
  } finally {
    mock.restore();
  }
});

test('nested expand is allowed when the nested association is to-one', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders', select: ['ID'],
        expand: [{ assoc: 'items', select: ['PRODUCT'], expand: [{ assoc: 'productRef', select: ['NAME'] }] }],
      },
      schema, {}
    );
    const itemsCol = capture.get().SELECT.columns.find(c => c.ref?.[0] === 'items');
    const nested = itemsCol.expand.find(c => c.ref?.[0] === 'productRef');
    assert.ok(nested, 'to-many → to-one nested expand must be allowed');
  } finally {
    capture.restore();
  }
});

test('nested expand is rejected when both levels are to-many', async () => {
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Orders', select: ['ID'],
        expand: [{ assoc: 'items', select: ['PRODUCT'], expand: [{ assoc: 'parts', select: ['NAME'] }] }],
      },
      schema, {}
    ),
    /both the parent and child association are to-many/
  );
});

test('expand target entity is enforced by the allowlist', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID'], expand: [{ assoc: 'items', select: ['PRODUCT'] }] },
      schema,
      { allowedEntities: ['Orders'] } // Items deliberately excluded
    ),
    /reached via association join/
  );
});

test('expand on an unknown association throws a clear error', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID'], expand: [{ assoc: 'doesNotExist', select: ['X'] }] },
      schema, {}
    ),
    /Unknown association "doesNotExist"/
  );
});

test('viaFiltered in aggregate.col is rejected on the legacy adapter (confirmed broken against real HANA)', async () => {
  // Was previously expected to always succeed — the CQN shape itself is valid, but
  // real HANA testing found the LEGACY @sap/hana-client runtime's generateAliases
  // utility crashes ("table.startsWith is not a function") the moment a viaFiltered
  // ref appears as an aggregate argument, with or without groupBy. Rejecting
  // explicitly on that adapter instead of letting the cryptic internal error
  // surface. (Confirmed separately that a modern @cap-js/hana adapter does NOT hit
  // this — see the "...is allowed on a modern adapter" test below — so the guard
  // must be conditional, not universal.)
  const originalDb = cds.db;
  cds.db = undefined; // simulate the legacy adapter (no cqn2sql)
  try {
    await assert.rejects(
      () => executeDescriptor(
        {
          entity: 'Orders', select: ['ID'],
          aggregate: [{
            fn: 'sum',
            col: { col: 'QTY', viaFiltered: { assoc: 'items', where: [{ col: 'PRODUCT', op: '=', val: 'X' }] } },
            as: 'qty_for_x',
          }],
          groupBy: ['ID'],
        },
        schema, {}
      ),
      /viaFiltered is not supported as an "aggregate" or "having" column/
    );
  } finally {
    cds.db = originalDb;
  }
});

test('viaFiltered in having.col is rejected on the legacy adapter (same root cause as aggregate.col)', async () => {
  // buildHavingExpr() calls into the same buildAggregateCol()/resolveColSpec() path
  // as a plain aggregate — confirmed hands-on with a correctly-formed { fn, col, op,
  // val } having entry (an earlier ad-hoc test without "fn" hit a different,
  // self-inflicted error from a malformed descriptor, not this real one).
  const originalDb = cds.db;
  cds.db = undefined; // simulate the legacy adapter (no cqn2sql)
  try {
    await assert.rejects(
      () => executeDescriptor(
        {
          entity: 'Orders', select: ['ID'], groupBy: ['ID'],
          having: [{
            fn: 'sum',
            col: { col: 'QTY', viaFiltered: { assoc: 'items', where: [{ col: 'PRODUCT', op: '=', val: 'X' }] } },
            op: '>', val: 10,
          }],
        },
        schema, {}
      ),
      /viaFiltered is not supported as an "aggregate" or "having" column/
    );
  } finally {
    cds.db = originalDb;
  }
});

test('viaFiltered in aggregate.col is allowed on a modern adapter (confirmed correct against real HANA via @cap-js/hana)', async () => {
  // Re-ran the identical CQN directly against a real BTP HANA deployment with the
  // modern @cap-js/hana adapter installed instead of @sap/hana-client: it returned
  // correct, mathematically-verified filtered sums — no crash. The module-level
  // cds.db stub (set at the top of this file) simulates that modern adapter for
  // every test by default, so no special setup is needed here — just confirming it
  // does NOT throw and builds the expected CQN.
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders', select: ['ID'],
        aggregate: [{
          fn: 'sum',
          col: { col: 'QTY', viaFiltered: { assoc: 'items', where: [{ col: 'PRODUCT', op: '=', val: 'X' }] } },
          as: 'qty_for_x',
        }],
        groupBy: ['ID'],
      },
      schema, {}
    );
    const sumCol = capture.get().SELECT.columns.find(c => c.func === 'sum');
    assert.equal(sumCol.args[0].ref[0].id, 'items');
  } finally {
    capture.restore();
  }
});

test('viaFiltered in select attaches the filter to the join hop', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID', { col: 'QTY', viaFiltered: { assoc: 'items', where: [{ col: 'PRODUCT', op: '=', val: 'X' }] } }],
      },
      schema, {}
    );
    const cols = capture.get().SELECT.columns;
    const filteredCol = cols.find(c => c.ref?.[0]?.id === 'items');
    assert.ok(filteredCol, 'filtered select column must be present');
    assert.equal(filteredCol.ref[1], 'QTY');
  } finally {
    capture.restore();
  }
});

test('viaFiltered rejects a path-valued column inside its own filter', async () => {
  // Moved off "aggregate" (now unconditionally rejected for viaFiltered, see above) —
  // this nested-path restriction is a general viaFiltered behavior, still real and
  // still worth covering via "select".
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Orders',
        select: [{ col: 'QTY', viaFiltered: { assoc: 'items', where: [{ col: 'productRef.NAME', op: '=', val: 'X' }] } }],
      },
      schema, {}
    ),
    /paths inside a viaFiltered filter are not supported/
  );
});

test('viaFiltered association target is enforced by the allowlist', async () => {
  // Moved off "aggregate" for the same reason as above — allowlist enforcement on
  // the viaFiltered target is a general behavior, still real and worth covering.
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Orders',
        select: [{ col: 'QTY', viaFiltered: { assoc: 'items', where: [{ col: 'PRODUCT', op: '=', val: 'X' }] } }],
      },
      schema,
      { allowedEntities: ['Orders'] } // Items deliberately excluded
    ),
    /reached via association join/
  );
});

test('viaFiltered column blocked via blockedColumns is stripped from select', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID', { col: 'SECRET', viaFiltered: { assoc: 'items', where: [{ col: 'PRODUCT', op: '=', val: 'X' }] } }],
      },
      schema, { blockedColumns: ['SECRET'] }
    );
    const cols = capture.get().SELECT.columns;
    assert.ok(!cols.some(c => c.ref?.[0]?.id === 'items'), 'blocked viaFiltered column must not reach SQL');
  } finally {
    capture.restore();
  }
});

test('viaFiltered is rejected in groupBy and orderBy', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', groupBy: [{ col: 'QTY', viaFiltered: { assoc: 'items', where: [] } }] },
      schema, {}
    ),
    /viaFiltered is not supported in "groupBy" or "orderBy"/
  );
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', orderBy: { col: 'QTY', viaFiltered: { assoc: 'items', where: [] } } },
      schema, {}
    ),
    /viaFiltered is not supported in "groupBy" or "orderBy"/
  );
});

test('hierarchy: descendants walks the tree level by level until empty', async () => {
  const mock = mockRunSequence([
    [{ ID: 'A1', NAME: 'Region-North', PARENT_ID: null }],
    [{ ID: 'A2', NAME: 'Sub1', PARENT_ID: 'A1' }, { ID: 'A3', NAME: 'Sub2', PARENT_ID: 'A1' }],
    [],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        entity: 'Accounts',
        hierarchy: { assoc: 'children', direction: 'descendants', startWhere: [{ col: 'NAME', op: '=', val: 'Region-North' }] },
        select: ['ID', 'NAME'],
      },
      schema, {}
    );
    assert.deepEqual(rows, [
      { ID: 'A1', NAME: 'Region-North' },
      { ID: 'A2', NAME: 'Sub1' },
      { ID: 'A3', NAME: 'Sub2' },
    ]);
    assert.equal(mock.calls.length, 3);
  } finally {
    mock.restore();
  }
});

test('hierarchy: ancestors walks up via the "parent" alias', async () => {
  const mock = mockRunSequence([
    [{ ID: 'A3', NAME: 'Sub2', PARENT_ID: 'A1' }],
    [{ ID: 'A1', NAME: 'Region-North', PARENT_ID: null }],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        entity: 'Accounts',
        hierarchy: { assoc: 'parent', direction: 'ancestors', startWhere: [{ col: 'ID', op: '=', val: 'A3' }] },
        select: ['ID', 'NAME'],
      },
      schema, {}
    );
    assert.deepEqual(rows, [
      { ID: 'A3', NAME: 'Sub2' },
      { ID: 'A1', NAME: 'Region-North' },
    ]);
  } finally {
    mock.restore();
  }
});

test('hierarchy: cycles are not collected twice', async () => {
  const mock = mockRunSequence([
    [{ ID: 'A1', NAME: 'Root', PARENT_ID: 'A2' }],
    [{ ID: 'A2', NAME: 'Loop', PARENT_ID: 'A1' }],
    [{ ID: 'A1', NAME: 'Root', PARENT_ID: 'A2' }], // would re-visit A1 — must be dropped
  ]);
  try {
    const rows = await executeDescriptor(
      {
        entity: 'Accounts',
        hierarchy: { assoc: 'children', direction: 'descendants', startWhere: [{ col: 'ID', op: '=', val: 'A1' }] },
        select: ['ID'],
      },
      schema, {}
    );
    assert.deepEqual(rows.map(r => r.ID), ['A1', 'A2']);
  } finally {
    mock.restore();
  }
});

test('hierarchy: maxDepth caps traversal regardless of remaining data', async () => {
  const mock = mockRunSequence([
    [{ ID: 'A1', NAME: 'L0', PARENT_ID: null }],
    [{ ID: 'A2', NAME: 'L1', PARENT_ID: 'A1' }],
    [{ ID: 'A3', NAME: 'L2', PARENT_ID: 'A2' }],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        entity: 'Accounts',
        hierarchy: { assoc: 'children', direction: 'descendants', startWhere: [{ col: 'ID', op: '=', val: 'A1' }], maxDepth: 1 },
        select: ['ID'],
      },
      schema, {}
    );
    assert.deepEqual(rows.map(r => r.ID), ['A1', 'A2']);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('hierarchy: rejects a non-self-referencing association', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', hierarchy: { assoc: 'customer', direction: 'descendants', startWhere: [{ col: 'ID', op: '=', val: 'X' }] } },
      schema, {}
    ),
    /not a self-referencing association/
  );
});

test('hierarchy: rejects an invalid direction', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Accounts', hierarchy: { assoc: 'children', direction: 'sideways', startWhere: [{ col: 'ID', op: '=', val: 'X' }] } },
      schema, {}
    ),
    /"hierarchy.direction" must be/
  );
});

test('hierarchy: rejects a missing startWhere', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Accounts', hierarchy: { assoc: 'children', direction: 'descendants' } },
      schema, {}
    ),
    /startWhere.*must specify/
  );
});

test('hierarchy: rejects an association-path column in startWhere', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Accounts', hierarchy: { assoc: 'children', direction: 'descendants', startWhere: [{ col: 'parent.NAME', op: '=', val: 'X' }] } },
      schema, {}
    ),
    /must be a plain column/
  );
});

test('hierarchy: rejects being combined with where/aggregate/expand/etc', async () => {
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Accounts',
        hierarchy: { assoc: 'children', direction: 'descendants', startWhere: [{ col: 'ID', op: '=', val: 'X' }] },
        where: [{ col: 'NAME', op: '=', val: 'Y' }],
      },
      schema, {}
    ),
    /cannot be combined with/
  );
});

test('window functions are rejected when the connected db lacks a modern cqn2sql adapter', async () => {
  // Confirmed against a real HANA deployment: the legacy @sap/hana-client-based
  // runtime silently drops the OVER clause (no error at the CQN level — the query
  // just comes back wrong), producing a downstream "incorrect syntax near AS" from
  // HANA itself. Detect the legacy adapter (no db.cqn2sql) and reject up front with
  // an actionable message instead. Every other test in this file assumes a modern
  // adapter via the module-level cds.db stub set above — this test is the one place
  // that deliberately simulates the legacy case.
  const original = cds.db;
  cds.db = undefined;
  try {
    await assert.rejects(
      () => executeDescriptor(
        { entity: 'Orders', select: ['ID', 'AMOUNT'], window: [{ fn: 'rank', as: 'r', partitionBy: ['CUSTOMER_ID'] }] },
        schema, {}
      ),
      /window.*functions are not supported against this database connection/
    );
  } finally {
    cds.db = original;
  }
});

test('window: rank() over (partition by ... order by ...) builds the expected CQN column', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID', 'AMOUNT'],
        window: [{ fn: 'rank', as: 'amount_rank', partitionBy: ['customer.ID'], orderBy: [{ col: 'AMOUNT', dir: 'DESC' }] }],
      },
      schema, {}
    );
    const cols = capture.get().SELECT.columns;
    const win = cols.find(c => c.as === 'amount_rank');
    assert.deepEqual(win, {
      func: 'rank',
      args: [],
      xpr: ['over', { xpr: [
        'partition', 'by', { ref: ['customer', 'ID'] },
        'order', 'by', { ref: ['AMOUNT'] }, 'desc',
      ] }],
      as: 'amount_rank',
    });
  } finally {
    capture.restore();
  }
});

test('window: sum() running total requires "col" and partitions/orders correctly', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID'],
        window: [{ fn: 'sum', col: 'AMOUNT', as: 'running_total', partitionBy: ['customer.ID'], orderBy: [{ col: 'ID', dir: 'ASC' }] }],
      },
      schema, {}
    );
    const win = capture.get().SELECT.columns.find(c => c.as === 'running_total');
    assert.equal(win.func, 'sum');
    assert.deepEqual(win.args, [{ ref: ['AMOUNT'] }]);
  } finally {
    capture.restore();
  }
});

test('window: lag/lead require "col"; ntile requires "buckets"', async () => {
  await assert.rejects(
    () => executeDescriptor({ entity: 'Orders', select: ['ID'], window: [{ fn: 'lag', as: 'prev' }] }, schema, {}),
    /window fn "lag" requires "col"/
  );
  await assert.rejects(
    () => executeDescriptor({ entity: 'Orders', select: ['ID'], window: [{ fn: 'ntile', as: 'bucket' }] }, schema, {}),
    /window fn "ntile" requires "buckets"/
  );
});

test('window: rejects being combined with aggregate/groupBy/having/expand', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', window: [{ fn: 'rank', as: 'r', orderBy: [{ col: 'ID' }] }], aggregate: [{ fn: 'count', col: 'ID', as: 'c' }] },
      schema, {}
    ),
    /"window" cannot be combined with/
  );
});

test('windowFilter wraps the query in a derived-table SELECT and filters on the alias', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID', 'AMOUNT'],
        window: [{ fn: 'rank', as: 'amount_rank', partitionBy: ['customer.ID'], orderBy: [{ col: 'AMOUNT', dir: 'DESC' }] }],
        windowFilter: [{ col: 'amount_rank', op: '<=', val: 3 }],
      },
      schema, {}
    );
    const outer = capture.get().SELECT;
    assert.ok(outer.from.SELECT, 'outer query must select FROM a derived-table SELECT');
    assert.deepEqual(outer.where, [{ ref: ['amount_rank'] }, '<=', { val: 3 }]);
  } finally {
    capture.restore();
  }
});

test('windowFilter requires "window" and a declared alias', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID'], windowFilter: [{ col: 'amount_rank', op: '<=', val: 3 }] },
      schema, {}
    ),
    /"windowFilter" requires "window"/
  );
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Orders', select: ['ID'],
        window: [{ fn: 'rank', as: 'amount_rank', orderBy: [{ col: 'ID' }] }],
        windowFilter: [{ col: 'not_declared', op: '<=', val: 3 }],
      },
      schema, {}
    ),
    /must reference a declared "window" alias/
  );
});

test('orderBy applies to the outer query when windowFilter wraps the SELECT', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID', 'AMOUNT'],
        window: [{ fn: 'rank', as: 'amount_rank', partitionBy: ['customer.ID'], orderBy: [{ col: 'AMOUNT', dir: 'DESC' }] }],
        windowFilter: [{ col: 'amount_rank', op: '<=', val: 3 }],
        orderBy: 'amount_rank', orderDir: 'ASC',
      },
      schema, {}
    );
    const outer = capture.get().SELECT;
    assert.deepEqual(outer.orderBy, [{ ref: ['amount_rank'], sort: 'asc' }]);
  } finally {
    capture.restore();
  }
});

test('caseWhen: builds a CQN case/when/then/else/end xpr column', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID'],
        caseWhen: [{
          as: 'amount_band',
          when: [
            { where: [{ col: 'AMOUNT', op: '<=', val: 0 }], then: 'Healthy' },
            { where: [{ col: 'AMOUNT', op: '<=', val: 30 }], then: 'Watch' },
          ],
          else: 'Default',
        }],
      },
      schema, {}
    );
    const col = capture.get().SELECT.columns.find(c => c.as === 'amount_band');
    assert.deepEqual(col, {
      xpr: [
        'case',
        'when', { ref: ['AMOUNT'] }, '<=', { val: 0 }, 'then', { val: 'Healthy' },
        'when', { ref: ['AMOUNT'] }, '<=', { val: 30 }, 'then', { val: 'Watch' },
        'else', { val: 'Default' },
        'end',
      ],
      as: 'amount_band',
    });
  } finally {
    capture.restore();
  }
});

test('caseWhen: branches without "else" omit the else token', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID'],
        caseWhen: [{
          as: 'status_label',
          when: [{ where: [{ col: 'AMOUNT', op: '>', val: 100 }], then: 'Big' }],
        }],
      },
      schema, {}
    );
    const col = capture.get().SELECT.columns.find(c => c.as === 'status_label');
    assert.deepEqual(col.xpr, [
      'case',
      'when', { ref: ['AMOUNT'] }, '>', { val: 100 }, 'then', { val: 'Big' },
      'end',
    ]);
  } finally {
    capture.restore();
  }
});

test('caseWhen: supports multi-condition (AND-ed) branch where clauses', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID'],
        caseWhen: [{
          as: 'band',
          when: [{
            where: [
              { col: 'AMOUNT', op: '>=', val: 10 },
              { col: 'AMOUNT', op: '<=', val: 20 },
            ],
            then: 'Mid',
          }],
          else: 'Other',
        }],
      },
      schema, {}
    );
    const col = capture.get().SELECT.columns.find(c => c.as === 'band');
    assert.deepEqual(col.xpr, [
      'case',
      'when', { ref: ['AMOUNT'] }, '>=', { val: 10 }, 'and', { ref: ['AMOUNT'] }, '<=', { val: 20 }, 'then', { val: 'Mid' },
      'else', { val: 'Other' },
      'end',
    ]);
  } finally {
    capture.restore();
  }
});

test('caseWhen: requires "as"', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID'], caseWhen: [{ when: [{ where: [{ col: 'AMOUNT', op: '>', val: 1 }], then: 'X' }] }] },
      schema, {}
    ),
    /"caseWhen" entries require an "as" alias/
  );
});

test('caseWhen: requires at least one "when" branch', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID'], caseWhen: [{ as: 'x', when: [] }] },
      schema, {}
    ),
    /requires at least one "when" branch/
  );
});

test('caseWhen: each branch requires "where" conditions', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID'], caseWhen: [{ as: 'x', when: [{ then: 'Y' }] }] },
      schema, {}
    ),
    /has a "when" branch with no "where" conditions/
  );
});

test('caseWhen: each branch requires a "then" value', async () => {
  await assert.rejects(
    () => executeDescriptor(
      { entity: 'Orders', select: ['ID'], caseWhen: [{ as: 'x', when: [{ where: [{ col: 'AMOUNT', op: '>', val: 1 }] }] }] },
      schema, {}
    ),
    /has a "when" branch with no "then" value/
  );
});

test('caseWhen: a column referenced only inside a "when" where clause still extends the entity allowlist walk', async () => {
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID'],
        caseWhen: [{
          as: 'cust_band',
          when: [{ where: [{ col: 'customer.NAME', op: '=', val: 'Acme' }], then: 'Known' }],
          else: 'Unknown',
        }],
      },
      schema,
      { allowedEntities: ['Orders'] } // Customers deliberately excluded
    ),
    /reached via association join/
  );
});

test('caseWhen columns can coexist with plain "select" columns', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'Orders',
        select: ['ID', 'AMOUNT'],
        caseWhen: [{
          as: 'band',
          when: [{ where: [{ col: 'AMOUNT', op: '>', val: 0 }], then: 'Pos' }],
          else: 'NonPos',
        }],
      },
      schema, {}
    );
    const cols = capture.get().SELECT.columns;
    assert.ok(cols.some(c => c.ref?.join('.') === 'ID'));
    assert.ok(cols.some(c => c.ref?.join('.') === 'AMOUNT'));
    assert.ok(cols.some(c => c.as === 'band'));
  } finally {
    capture.restore();
  }
});

test('select entry { col, as } renames the output column explicitly', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'Orders', select: [{ col: 'ID', as: 'id' }, 'AMOUNT'] },
      schema, {}
    );
    const cols = capture.get().SELECT.columns;
    assert.deepEqual(cols.find(c => c.as === 'id'), { ref: ['ID'], as: 'id' });
    assert.ok(cols.some(c => c.ref?.join('.') === 'AMOUNT'));
  } finally {
    capture.restore();
  }
});

test('union: concatenates rows from both branches (UNION ALL semantics by default)', async () => {
  const mock = mockRunSequence([
    [{ id: 'O1' }, { id: 'O2' }],
    [{ id: 'C1' }],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        union: [
          { entity: 'Orders', select: [{ col: 'ID', as: 'id' }] },
          { entity: 'Customers', select: [{ col: 'ID', as: 'id' }] },
        ],
      },
      schema, {}
    );
    assert.deepEqual(rows, [{ id: 'O1' }, { id: 'O2' }, { id: 'C1' }]);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('union: distinct:true dedupes identical rows across branches', async () => {
  const mock = mockRunSequence([
    [{ id: 'X' }, { id: 'Y' }],
    [{ id: 'X' }],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        union: [
          { entity: 'Orders', select: [{ col: 'ID', as: 'id' }] },
          { entity: 'Customers', select: [{ col: 'ID', as: 'id' }] },
        ],
        distinct: true,
      },
      schema, {}
    );
    assert.deepEqual(rows, [{ id: 'X' }, { id: 'Y' }]);
  } finally {
    mock.restore();
  }
});

test('intersect: returns only rows present in every branch', async () => {
  const mock = mockRunSequence([
    [{ id: 'X' }, { id: 'Y' }, { id: 'Z' }],
    [{ id: 'Y' }, { id: 'Z' }],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        intersect: [
          { entity: 'Orders', select: [{ col: 'ID', as: 'id' }] },
          { entity: 'Customers', select: [{ col: 'ID', as: 'id' }] },
        ],
      },
      schema, {}
    );
    assert.deepEqual(rows, [{ id: 'Y' }, { id: 'Z' }]);
  } finally {
    mock.restore();
  }
});

test('except: returns rows in the first branch absent from every other branch', async () => {
  const mock = mockRunSequence([
    [{ id: 'X' }, { id: 'Y' }, { id: 'Z' }],
    [{ id: 'Y' }],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        except: [
          { entity: 'Orders', select: [{ col: 'ID', as: 'id' }] },
          { entity: 'Customers', select: [{ col: 'ID', as: 'id' }] },
        ],
      },
      schema, {}
    );
    assert.deepEqual(rows, [{ id: 'X' }, { id: 'Z' }]);
  } finally {
    mock.restore();
  }
});

test('union: requires at least 2 branches', async () => {
  await assert.rejects(
    () => executeDescriptor({ union: [{ entity: 'Orders', select: ['ID'] }] }, schema, {}),
    /requires an array of at least 2 branch descriptors/
  );
});

test('union: branches must select the same number of columns', async () => {
  await assert.rejects(
    () => executeDescriptor(
      {
        union: [
          { entity: 'Orders', select: ['ID', 'AMOUNT'] },
          { entity: 'Customers', select: ['ID'] },
        ],
      },
      schema, {}
    ),
    /branches must all select the same number of columns/
  );
});

test('union: cannot be combined with top-level entity/select', async () => {
  await assert.rejects(
    () => executeDescriptor(
      {
        entity: 'Orders',
        union: [
          { entity: 'Orders', select: ['ID'] },
          { entity: 'Customers', select: ['ID'] },
        ],
      },
      schema, {}
    ),
    /cannot be combined with top-level "entity"/
  );
});

test('union/intersect/except: only one set-op key may be used at a time', async () => {
  await assert.rejects(
    () => executeDescriptor(
      {
        union: [{ entity: 'Orders', select: ['ID'] }, { entity: 'Customers', select: ['ID'] }],
        intersect: [{ entity: 'Orders', select: ['ID'] }, { entity: 'Customers', select: ['ID'] }],
      },
      schema, {}
    ),
    /can only use one of "union", "intersect", or "except"/
  );
});

test('union: combined result respects "limit", and each branch is capped before combining', async () => {
  const mock = mockRunSequence([
    [{ id: 'O1' }, { id: 'O2' }, { id: 'O3' }],
    [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }],
  ]);
  try {
    const rows = await executeDescriptor(
      {
        union: [
          { entity: 'Orders', select: [{ col: 'ID', as: 'id' }] },
          { entity: 'Customers', select: [{ col: 'ID', as: 'id' }] },
        ],
        limit: 4,
      },
      schema, {}
    );
    assert.equal(rows.length, 4);
    const branchLimits = mock.calls.map(q => q.SELECT.limit.rows.val);
    assert.deepEqual(branchLimits, [4, 4]);
  } finally {
    mock.restore();
  }
});

test('union/intersect/except: respects per-call entity allowlist on each branch', async () => {
  const capture = captureQuery();
  try {
    await assert.rejects(
      () => executeDescriptor(
        {
          union: [
            { entity: 'Orders', select: ['ID'] },
            { entity: 'Customers', select: ['ID'] },
          ],
        },
        schema,
        { allowedEntities: ['Orders'] }
      ),
      /not in the per-call allowed_entities list/
    );
  } finally {
    capture.restore();
  }
});

test('asOf: adds a closed-open temporal where condition on a temporal entity', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      { entity: 'WorkAssignments', select: ['ID', 'ROLE'], asOf: '2017-01-01' },
      schema, {}
    );
    assert.deepEqual(capture.get().SELECT.where, [
      { ref: ['validFrom'] }, '<=', { val: '2017-01-01' },
      'and',
      { ref: ['validTo'] }, '>', { val: '2017-01-01' },
    ]);
  } finally {
    capture.restore();
  }
});

test('asOf: combines with an explicit "where" via AND', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor(
      {
        entity: 'WorkAssignments',
        select: ['ID'],
        where: [{ col: 'ROLE', op: '=', val: 'Manager' }],
        asOf: '2017-01-01',
      },
      schema, {}
    );
    assert.deepEqual(capture.get().SELECT.where, [
      { ref: ['ROLE'] }, '=', { val: 'Manager' },
      'and',
      { ref: ['validFrom'] }, '<=', { val: '2017-01-01' }, 'and', { ref: ['validTo'] }, '>', { val: '2017-01-01' },
    ]);
  } finally {
    capture.restore();
  }
});

test('a temporal entity with no "asOf" still gets a current-moment temporal filter (a plain read otherwise returns every time slice)', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor({ entity: 'WorkAssignments', select: ['ID'] }, schema, {});
    const w = capture.get().SELECT.where;
    assert.equal(w[0].ref[0], 'validFrom');
    assert.equal(w[1], '<=');
    assert.equal(w[3], 'and');
    assert.equal(w[4].ref[0], 'validTo');
    assert.equal(w[5], '>');
    // The asOf value defaults to "now" — just assert it's a non-empty ISO-ish string, not a fixed date.
    assert.ok(typeof w[2].val === 'string' && w[2].val.length > 0);
  } finally {
    capture.restore();
  }
});

test('asOf is rejected on a non-temporal entity', async () => {
  await assert.rejects(
    () => executeDescriptor({ entity: 'Orders', select: ['ID'], asOf: '2017-01-01' }, schema, {}),
    /"asOf" was given but entity "Orders" is not temporal/
  );
});

test('a non-temporal entity is queried exactly as before — no temporal filter added', async () => {
  const capture = captureQuery();
  try {
    await executeDescriptor({ entity: 'Orders', select: ['ID'] }, schema, {});
    assert.equal(capture.get().SELECT.where, undefined);
  } finally {
    capture.restore();
  }
});
