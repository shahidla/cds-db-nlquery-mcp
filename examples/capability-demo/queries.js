'use strict';
// Every query below is run for real through src/query-executor.js's executeDescriptor()
// against a real in-memory SQLite DB (see ../generate.js). "nl" is the natural-language
// question a user might ask; "descriptor" is what the LLM planner (src/llm-planner.js)
// would be expected to produce for it. Entries marked error:true are expected to be
// rejected by the executor's own validation — included to demonstrate that behavior too.

module.exports = [
  // ── OLD capabilities (present before this extension round) ──────────────────

  {
    id: 'old-01-plain-where',
    nl: 'Show open orders for customer C1',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'CUSTOMER_ID', 'AMOUNT', 'CURRENCY', 'STATUS'],
      where: [{ col: 'CUSTOMER_ID', op: '=', val: 'C1' }, { col: 'STATUS', op: '=', val: 'O' }],
    },
  },
  {
    id: 'old-02-aggregation-groupby',
    nl: 'Total order amount per customer',
    descriptor: {
      entity: 'Orders',
      select: ['CUSTOMER_ID'],
      aggregate: [{ fn: 'sum', col: 'AMOUNT', as: 'TOTAL_AMOUNT' }],
      groupBy: ['CUSTOMER_ID'],
    },
  },
  {
    id: 'old-03-boolean-or-grouping',
    nl: 'Orders that are open or over 2000',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'STATUS', 'AMOUNT'],
      where: [{ any: [{ col: 'STATUS', op: '=', val: 'O' }, { col: 'AMOUNT', op: '>', val: 2000 }] }],
    },
  },
  {
    id: 'old-04-exists-to-many',
    nl: 'Customers who have at least one open order',
    descriptor: {
      entity: 'Customers',
      select: ['ID', 'NAME'],
      where: [{ exists: 'orders', where: [{ col: 'STATUS', op: '=', val: 'O' }] }],
    },
  },
  {
    id: 'old-05-not-exists',
    nl: 'Customers who have never placed an order',
    descriptor: {
      entity: 'Customers',
      select: ['ID', 'NAME'],
      where: [{ notExists: 'orders' }],
    },
  },
  {
    id: 'old-06-pagination-offset',
    nl: 'Second page of orders, 2 per page, ordered by ID',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'AMOUNT'],
      orderBy: 'ID', orderDir: 'ASC',
      limit: 2, offset: 2,
    },
  },
  {
    id: 'old-07-valuelist-text-join',
    nl: 'Loans with their sector description',
    descriptor: {
      entity: 'Loans',
      select: ['ID', 'SECTOR', 'sector.DESCRIPTION'],
    },
  },
  {
    id: 'old-08-semantics-amount-currency-pair',
    nl: 'Order amounts with their currency',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'AMOUNT', 'CURRENCY'],
    },
  },
  {
    id: 'old-09-assert-range-outlier',
    nl: 'Loans with a debt-to-income ratio above the normal 0-50 range',
    descriptor: {
      entity: 'Loans',
      select: ['ID', 'DTI'],
      where: [{ col: 'DTI', op: '>', val: 50 }],
    },
  },
  {
    id: 'old-10-cds-search',
    nl: 'Search customers for "acme"',
    descriptor: {
      entity: 'Customers',
      select: ['ID', 'NAME', 'NOTES'],
      search: 'acme',
    },
  },
  {
    id: 'old-11-enum-text-translation',
    nl: 'Orders with their status (raw code and business term)',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'STATUS'],
    },
  },
  {
    id: 'old-12-calculated-column',
    nl: "Customers' full names",
    descriptor: {
      entity: 'Customers',
      select: ['ID', 'FULL'],
    },
  },
  {
    id: 'old-13-having',
    nl: 'Customers with more than 1 order',
    descriptor: {
      entity: 'Orders',
      select: ['CUSTOMER_ID'],
      aggregate: [{ fn: 'count', col: 'ID', as: 'ORDER_COUNT' }],
      groupBy: ['CUSTOMER_ID'],
      having: [{ fn: 'count', col: 'ID', op: '>', val: 1 }],
    },
  },
  {
    id: 'old-14-date-within-days',
    nl: 'Orders placed in the last 60 days (relative to today)',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'ORDER_DATE'],
      where: [{ col: 'ORDER_DATE', op: 'days_ago', val: 60 }],
    },
  },
  {
    id: 'old-15-persistence-skip-rejected',
    nl: 'Show internal audit notes (entity is excluded from schema discovery)',
    descriptor: { entity: 'InternalAudit', select: ['ID', 'NOTE'] },
    error: true,
  },

  // ── NEW capabilities (this extension round) ──────────────────────────────────

  {
    id: 'new-01-hierarchy-descendants',
    nl: 'All descendants of account A1 (the full org tree below it)',
    descriptor: {
      entity: 'Accounts',
      select: ['ID', 'NAME', 'PARENT_ID'],
      hierarchy: { assoc: 'children', direction: 'descendants', startWhere: [{ col: 'ID', op: '=', val: 'A1' }] },
    },
  },
  {
    id: 'new-02-hierarchy-ancestors',
    nl: 'The full ancestor chain above account A5',
    descriptor: {
      entity: 'Accounts',
      select: ['ID', 'NAME', 'PARENT_ID'],
      hierarchy: { assoc: 'parent', direction: 'ancestors', startWhere: [{ col: 'ID', op: '=', val: 'A5' }] },
    },
  },
  {
    id: 'new-03-expand-composition',
    nl: 'Orders with their line items nested',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'CUSTOMER_ID'],
      expand: [{ assoc: 'items', select: ['PRODUCT', 'QTY'] }],
    },
  },
  {
    id: 'new-04-via-filtered-aggregate',
    nl: 'Total amount of OPEN orders per customer (filtering inside the join, not the outer rows)',
    descriptor: {
      entity: 'Customers',
      select: ['ID', 'NAME'],
      aggregate: [{
        fn: 'sum',
        col: { col: 'AMOUNT', viaFiltered: { assoc: 'orders', where: [{ col: 'STATUS', op: '=', val: 'O' }] } },
        as: 'OPEN_ORDERS_TOTAL',
      }],
      groupBy: ['ID', 'NAME'],
    },
  },
  {
    id: 'new-05-window-rank-per-partition',
    nl: 'Rank each order by amount within its customer (highest first)',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'CUSTOMER_ID', 'AMOUNT'],
      window: [{ fn: 'rank', as: 'RANK_IN_CUSTOMER', partitionBy: ['CUSTOMER_ID'], orderBy: [{ col: 'AMOUNT', dir: 'DESC' }] }],
    },
  },
  {
    id: 'new-06-window-filter-top-n-per-group',
    nl: "Each customer's single largest order (top 1 per group)",
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'CUSTOMER_ID', 'AMOUNT'],
      window: [{ fn: 'rank', as: 'RANK_IN_CUSTOMER', partitionBy: ['CUSTOMER_ID'], orderBy: [{ col: 'AMOUNT', dir: 'DESC' }] }],
      windowFilter: [{ col: 'RANK_IN_CUSTOMER', op: '=', val: 1 }],
    },
  },
  {
    id: 'new-07-window-running-total',
    nl: 'Running total of order amount per customer, ordered by date',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'CUSTOMER_ID', 'ORDER_DATE', 'AMOUNT'],
      window: [{ fn: 'sum', col: 'AMOUNT', as: 'RUNNING_TOTAL', partitionBy: ['CUSTOMER_ID'], orderBy: [{ col: 'ORDER_DATE', dir: 'ASC' }] }],
    },
  },
  {
    id: 'new-08-hierarchy-rejects-non-recursive-assoc',
    nl: '(validation demo) "Hierarchy" requested on a non-self-referencing association',
    descriptor: {
      entity: 'Orders',
      select: ['ID'],
      hierarchy: { assoc: 'customer', direction: 'descendants', startWhere: [{ col: 'ID', op: '=', val: 'O1' }] },
    },
    error: true,
  },
  {
    id: 'new-09-window-rejects-combo-with-aggregate',
    nl: '(validation demo) window function combined with aggregate/groupBy — rejected',
    descriptor: {
      entity: 'Orders',
      select: ['CUSTOMER_ID'],
      aggregate: [{ fn: 'sum', col: 'AMOUNT', as: 'TOTAL' }],
      groupBy: ['CUSTOMER_ID'],
      window: [{ fn: 'rank', as: 'R', orderBy: [{ col: 'AMOUNT' }] }],
    },
    error: true,
  },
  {
    id: 'new-10-case-when-label',
    nl: 'Orders labeled Large (over 2000) or Small',
    descriptor: {
      entity: 'Orders',
      select: ['ID', 'AMOUNT'],
      caseWhen: [{
        as: 'SIZE_LABEL',
        when: [
          { where: [{ col: 'AMOUNT', op: '>', val: 2000 }], then: 'Large' },
        ],
        else: 'Small',
      }],
    },
  },
  {
    id: 'new-11-union-two-branches',
    nl: 'Customers named Acme Corp, plus customers with an order over 4000',
    descriptor: {
      union: [
        { entity: 'Customers', select: ['ID', 'NAME'], where: [{ col: 'NAME', op: '=', val: 'Acme Corp' }] },
        { entity: 'Customers', select: ['ID', 'NAME'], where: [{ exists: 'orders', where: [{ col: 'AMOUNT', op: '>', val: 4000 }] }] },
      ],
    },
  },
  {
    id: 'new-12-intersect-two-branches',
    nl: 'Customers with an open order who also match the search term "Globex"',
    descriptor: {
      intersect: [
        { entity: 'Customers', select: ['ID', 'NAME'], where: [{ exists: 'orders', where: [{ col: 'STATUS', op: '=', val: 'O' }] }] },
        { entity: 'Customers', select: ['ID', 'NAME'], search: 'Globex' },
      ],
    },
  },
  {
    id: 'new-13-except-two-branches',
    nl: 'All customers except those who have never placed an order',
    descriptor: {
      except: [
        { entity: 'Customers', select: ['ID', 'NAME'] },
        { entity: 'Customers', select: ['ID', 'NAME'], where: [{ notExists: 'orders' }] },
      ],
    },
  },
  {
    id: 'new-14-temporal-as-of-past',
    nl: "What was Alice's role on 2026-02-15?",
    descriptor: {
      entity: 'WorkAssignments',
      select: ['EMPLOYEE', 'ROLE'],
      where: [{ col: 'EMPLOYEE', op: '=', val: 'Alice' }],
      asOf: '2026-02-15',
    },
  },
  {
    id: 'new-15-temporal-default-current',
    nl: "What is Alice's current role?",
    descriptor: {
      entity: 'WorkAssignments',
      select: ['EMPLOYEE', 'ROLE'],
      where: [{ col: 'EMPLOYEE', op: '=', val: 'Alice' }],
    },
  },

  // ── Systematic post-processing-recursion coverage (added after auditing every
  // JS post-fetch step for the same gap an earlier expand "orderBy" bug had: each
  // one originally only ever walked the TOP-LEVEL row, or only Array.isArray()
  // expand children, silently no-op'ing on anything deeper or to-one-shaped) ──

  {
    id: 'new-16-expand-enum-two-levels',
    nl: 'Show me each order with its line items nested inside, and each line item with its product nested inside that — including the status text at both the item and product level',
    descriptor: {
      entity: 'Orders',
      select: ['ID'],
      expand: [{
        assoc: 'items', select: ['ID', 'STATUS'],
        expand: [{ assoc: 'product', select: ['ID', 'STATUS'] }],
      }],
    },
  },
  {
    id: 'new-17-expand-blocked-columns-two-levels',
    nl: 'Show me each order with its line items nested inside, and each line item with its product nested inside that — excluding the SECRET column at both the item and product level',
    descriptor: {
      entity: 'Orders',
      select: ['ID'],
      expand: [{
        assoc: 'items', select: ['ID', 'STATUS'],
        expand: [{ assoc: 'product', select: ['ID', 'NAME', 'SECRET', 'STATUS'] }],
      }],
    },
    // Products.SECRET only exists at the level-2 (product) entity in this schema —
    // OrderItems has no SECRET column — so this exercises the to-one branch
    // specifically, which is the shape the original bug missed entirely.
    // (Explicit select, not null/"all columns" — null at 2 nested levels hits an
    // unrelated @cap-js/sqlite-internal "malformed JSON" error confirmed specific
    // to that test-only SQLite adapter; verified directly against live BTP HANA
    // with @cap-js/hana that select:null + this same blockedColumns config works
    // correctly there. Using explicit select here so the SQLite-based golden
    // reference can still be generated, without losing real coverage of the
    // thing this entry actually tests — blocked-column stripping at depth 2.)
    callConfig: { blockedColumns: ['SECRET'] },
  },
  {
    id: 'new-18-expand-orderby-limit-top-n-per-group',
    nl: "For each order, nest just its single largest line item by quantity inside it — one order row each, with only the top line item nested inside",
    descriptor: {
      entity: 'Orders',
      select: ['ID'],
      expand: [{ assoc: 'items', select: ['ID', 'PRODUCT', 'QTY'], orderBy: 'QTY', orderDir: 'DESC', limit: 1 }],
    },
  },
  {
    id: 'new-19-hierarchy-enum-translation',
    nl: 'All descendants of account A1, including their status text',
    descriptor: {
      entity: 'Accounts',
      select: ['ID', 'NAME', 'STATUS'],
      hierarchy: { assoc: 'children', direction: 'descendants', startWhere: [{ col: 'ID', op: '=', val: 'A1' }] },
    },
  },
  {
    id: 'new-20-expand-orderby-through-to-one-then-to-many',
    nl: "For each order, nest that order's customer inside it, and nest that customer's single largest order (by amount, among all of that customer's orders) inside the customer",
    descriptor: {
      entity: 'Orders',
      select: ['ID'],
      expand: [{
        assoc: 'customer', select: ['ID', 'NAME'],
        expand: [{ assoc: 'orders', select: ['ID', 'AMOUNT'], orderBy: 'AMOUNT', orderDir: 'DESC', limit: 1 }],
      }],
    },
  },
];
