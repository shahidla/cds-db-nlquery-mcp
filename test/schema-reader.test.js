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
