'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { buildSchema, buildSchemaPrompt, hasNameCollisions } = require('../src/schema-reader');

function linkedModel(definitions) {
  return cds.linked({ definitions });
}

test('buildSchema captures columns, types, and labels', () => {
  const csn = linkedModel({
    'app.Customers': {
      kind: 'entity',
      elements: {
        ID:   { type: 'cds.String', key: true },
        NAME: { type: 'cds.String', '@title': 'Customer Name' },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Customers.key, 'ID');
  assert.equal(schema.Customers.columns.NAME.type, 'String');
  assert.equal(schema.Customers.columns.NAME.label, 'Customer Name');
});

test('@NLP.label takes precedence over @title', () => {
  const csn = linkedModel({
    'app.Foo': {
      kind: 'entity',
      elements: {
        ID:   { type: 'cds.String', key: true },
        CODE: { type: 'cds.String', '@title': 'Code', '@NLP.label': 'Override text' },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Foo.columns.CODE.label, 'Override text');
});

test('associations become joins with correct cardinality-based type', () => {
  const csn = linkedModel({
    'app.Orders': {
      kind: 'entity',
      elements: {
        ID:       { type: 'cds.String', key: true },
        CUSTOMER: { type: 'cds.String' },
        customer: {
          type: 'cds.Association',
          isAssociation: true,
          target: 'app.Customers',
          cardinality: { max: 1 },
          on: [{ ref: ['customer', 'ID'] }, '=', { ref: ['CUSTOMER'] }],
        },
      },
    },
    'app.Customers': {
      kind: 'entity',
      elements: { ID: { type: 'cds.String', key: true } },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Orders.joins.customer.entity, 'Customers');
  assert.equal(schema.Orders.joins.customer.type, 'INNER');
});

test('to-many compositions are flagged with toMany:true on the join', () => {
  const csn = linkedModel({
    'app.Orders': {
      kind: 'entity',
      elements: {
        ID: { type: 'cds.String', key: true },
        items: {
          type: 'cds.Composition',
          isComposition: true,
          target: 'app.Items',
          cardinality: { max: '*' },
          on: [{ ref: ['items', 'ORDER_ID'] }, '=', { ref: ['ID'] }],
        },
      },
    },
    'app.Items': {
      kind: 'entity',
      elements: { ID: { type: 'cds.String', key: true }, ORDER_ID: { type: 'cds.String' } },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Orders.joins.items.toMany, true);
  const prompt = buildSchemaPrompt(schema);
  assert.match(prompt, /"items"→Items\([^)]*,toMany\)/);
});

test('native CDS enum is captured as value -> symbolic name', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      elements: {
        ID:     { type: 'cds.String', key: true },
        STATUS: { type: 'cds.String', enum: { active: { val: 'A' }, closed: { val: 'C' } } },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.deepEqual(schema.Loans.columns.STATUS.enum, { A: 'active', C: 'closed' });
});

test('@Common.Text is captured as a textVia path hint', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      elements: {
        ID:     { type: 'cds.String', key: true },
        STATUS: { type: 'cds.String', '@Common.Text': { '=': 'status.TEXT' } },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Loans.columns.STATUS.textVia, 'status.TEXT');
});

test('@description and @Core.Description are captured on columns and entities', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      '@description': 'Loan accounts held by the bank',
      elements: {
        ID:  { type: 'cds.String', key: true },
        DTI: { type: 'cds.Decimal', '@description': 'Debt-to-income ratio' },
        LTV: { type: 'cds.Decimal', '@Core.Description': 'Loan-to-value ratio' },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Loans.description, 'Loan accounts held by the bank');
  assert.equal(schema.Loans.columns.DTI.description, 'Debt-to-income ratio');
  assert.equal(schema.Loans.columns.LTV.description, 'Loan-to-value ratio');
});

test('@NLP.synonyms is captured as an array of alternate terms', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      elements: {
        ID:  { type: 'cds.String', key: true },
        DTI: { type: 'cds.Decimal', '@NLP.synonyms': ['debt to income', 'debt-to-income ratio'] },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.deepEqual(schema.Loans.columns.DTI.synonyms, ['debt to income', 'debt-to-income ratio']);
});

test('buildSchemaPrompt renders description and synonyms as text', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      '@description': 'Loan accounts',
      elements: {
        ID:  { type: 'cds.String', key: true },
        DTI: { type: 'cds.Decimal', '@description': 'Debt-to-income ratio', '@NLP.synonyms': ['DTI ratio'] },
      },
    },
  });
  const schema = buildSchema(csn);
  const prompt = buildSchemaPrompt(schema);
  assert.match(prompt, /Loan accounts/);
  assert.match(prompt, /Debt-to-income ratio/);
  assert.match(prompt, /aka: DTI ratio/);
});

test('entities marked @cds.persistence.skip are excluded from the schema', () => {
  const csn = linkedModel({
    'app.Customers': { kind: 'entity', elements: { ID: { type: 'cds.String', key: true } } },
    'app.ApiOnlyView': {
      kind: 'entity',
      '@cds.persistence.skip': true,
      elements: { ID: { type: 'cds.String', key: true } },
    },
  });
  const schema = buildSchema(csn);
  assert.deepEqual(Object.keys(schema), ['Customers']);
});

test('@assert.range is captured and rendered as [min..max]', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      elements: {
        ID:  { type: 'cds.String', key: true },
        DTI: { type: 'cds.Decimal', '@assert.range': [0, 50] },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.deepEqual(schema.Loans.columns.DTI.range, [0, 50]);
  const prompt = buildSchemaPrompt(schema);
  assert.match(prompt, /DTI:Decimal\[0\.\.50\]/);
});

test('@Semantics.amount.currencyCode pairs an amount column with its currency column', () => {
  const csn = linkedModel({
    'app.Orders': {
      kind: 'entity',
      elements: {
        ID:       { type: 'cds.String', key: true },
        AMOUNT:   { type: 'cds.Decimal', '@Semantics.amount.currencyCode': 'CURRENCY' },
        CURRENCY: { type: 'cds.String' },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Orders.columns.AMOUNT.pairedWith, 'CURRENCY');
  const prompt = buildSchemaPrompt(schema);
  assert.match(prompt, /pairs with CURRENCY/);
});

test('@Common.ValueList resolves to a textVia path via a matching association', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      elements: {
        ID: { type: 'cds.String', key: true },
        SECTOR: {
          type: 'cds.String',
          '@Common.ValueList': {
            CollectionPath: 'Sectors',
            Parameters: [
              { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: 'SECTOR', ValueListProperty: 'CODE' },
              { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DESCRIPTION' },
            ],
          },
        },
        sector: {
          type: 'cds.Association',
          isAssociation: true,
          target: 'app.Sectors',
          cardinality: { max: 1 },
          on: [{ ref: ['sector', 'CODE'] }, '=', { ref: ['SECTOR'] }],
        },
      },
    },
    'app.Sectors': {
      kind: 'entity',
      elements: {
        CODE:        { type: 'cds.String', key: true },
        DESCRIPTION: { type: 'cds.String' },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Loans.columns.SECTOR.textVia, 'sector.DESCRIPTION');
});

test('@Common.ValueList with no matching association is skipped, not crashed', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      elements: {
        ID: { type: 'cds.String', key: true },
        SECTOR: {
          type: 'cds.String',
          '@Common.ValueList': {
            CollectionPath: 'Sectors', // no association to Sectors exists on Loans
            Parameters: [
              { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DESCRIPTION' },
            ],
          },
        },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Loans.columns.SECTOR.textVia, undefined);
});

test('calculated-on-read elements are exposed with a calculated marker', () => {
  const csn = linkedModel({
    'app.Customers': {
      kind: 'entity',
      elements: {
        ID:    { type: 'cds.String', key: true },
        FIRST: { type: 'cds.String' },
        LAST:  { type: 'cds.String' },
        FULL:  {
          type: 'cds.String',
          value: { xpr: [{ ref: ['FIRST'] }, '||', { val: ' ' }, '||', { ref: ['LAST'] }] },
        },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Customers.columns.FULL.calculated, true);
  const prompt = buildSchemaPrompt(schema);
  assert.match(prompt, /FULL:String\[calculated\]/);
});

test('virtual elements are excluded from columns', () => {
  const csn = linkedModel({
    'app.Customers': {
      kind: 'entity',
      elements: {
        ID:     { type: 'cds.String', key: true },
        HIDDEN: { type: 'cds.String', virtual: true },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.equal(schema.Customers.columns.HIDDEN, undefined);
});

test('colliding short names fall back to fully-qualified keys', () => {
  const csn = linkedModel({
    'sales.Order':   { kind: 'entity', elements: { ID: { type: 'cds.String', key: true } } },
    'support.Order': { kind: 'entity', elements: { ID: { type: 'cds.String', key: true } } },
    'sales.Customer': { kind: 'entity', elements: { ID: { type: 'cds.String', key: true } } },
  });
  assert.equal(hasNameCollisions(csn), true);
  const schema = buildSchema(csn);
  assert.deepEqual(Object.keys(schema).sort(), ['Customer', 'sales.Order', 'support.Order'].sort());
});

test('non-colliding short names stay unqualified', () => {
  const csn = linkedModel({
    'app.Customers': { kind: 'entity', elements: { ID: { type: 'cds.String', key: true } } },
  });
  assert.equal(hasNameCollisions(csn), false);
});

test('buildSchemaPrompt renders columns, enum values, and joins as text', () => {
  const csn = linkedModel({
    'app.Loans': {
      kind: 'entity',
      elements: {
        ID:     { type: 'cds.String', key: true },
        STATUS: { type: 'cds.String', enum: { active: { val: 'A' } } },
      },
    },
  });
  const schema = buildSchema(csn);
  const prompt = buildSchemaPrompt(schema);
  assert.match(prompt, /Loans/);
  assert.match(prompt, /active="A"/);
});

test('@cds.search columns are captured as searchableColumns, excluding false entries', () => {
  const csn = linkedModel({
    'app.Customers': {
      kind: 'entity',
      '@cds.search': { NAME: true, NOTES: true, INTERNAL_ID: false },
      elements: {
        ID:          { type: 'cds.String', key: true },
        NAME:        { type: 'cds.String' },
        NOTES:       { type: 'cds.String' },
        INTERNAL_ID: { type: 'cds.String' },
      },
    },
  });
  const schema = buildSchema(csn);
  assert.deepEqual(schema.Customers.searchableColumns, ['NAME', 'NOTES']);
});

test('entities without @cds.search get an empty searchableColumns array', () => {
  const csn = linkedModel({
    'app.Customers': { kind: 'entity', elements: { ID: { type: 'cds.String', key: true } } },
  });
  const schema = buildSchema(csn);
  assert.deepEqual(schema.Customers.searchableColumns, []);
});

test('buildSchemaPrompt renders searchable columns on the entity header', () => {
  const csn = linkedModel({
    'app.Customers': {
      kind: 'entity',
      '@cds.search': { NAME: true },
      elements: {
        ID:   { type: 'cds.String', key: true },
        NAME: { type: 'cds.String' },
      },
    },
  });
  const schema = buildSchema(csn);
  const prompt = buildSchemaPrompt(schema);
  assert.match(prompt, /searchable: NAME/);
});
