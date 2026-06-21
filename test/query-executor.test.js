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
