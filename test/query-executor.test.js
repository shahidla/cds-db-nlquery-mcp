'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { executeDescriptor } = require('../src/query-executor');

// Minimal synthetic schema matching what schema-reader.js would produce.
const schema = {
  Orders: {
    key: 'ID', fqn: 'app.Orders',
    columns: { ID: { type: 'String' }, AMOUNT: { type: 'Decimal' }, SECRET: { type: 'String' } },
    joins: { customer: { entity: 'Customers', from: 'CUSTOMER', to: 'ID', type: 'INNER' } },
  },
  Customers: {
    key: 'ID', fqn: 'app.Customers',
    columns: { ID: { type: 'String' }, NAME: { type: 'String' } },
    joins: {},
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

test('unknown entity throws a clear error', async () => {
  await assert.rejects(
    () => executeDescriptor({ entity: 'DoesNotExist' }, schema, {}),
    /Unknown entity/
  );
});
