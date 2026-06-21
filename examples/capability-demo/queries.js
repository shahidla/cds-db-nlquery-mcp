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
];
