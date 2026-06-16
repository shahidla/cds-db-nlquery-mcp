'use strict';

// Maps CDS built-in types to simplified type strings used in descriptors and conditions
const CDS_TYPE_MAP = {
  'cds.String':      'String',
  'cds.UUID':        'String',
  'cds.LargeString': 'String',
  'cds.Boolean':     'Boolean',
  'cds.Decimal':     'Decimal',
  'cds.Double':      'Decimal',
  'cds.Integer':     'Integer',
  'cds.Int16':       'Integer',
  'cds.Int32':       'Integer',
  'cds.Int64':       'Integer',
  'cds.Date':        'Date',
  'cds.DateTime':    'Date',
  'cds.Timestamp':   'Date',
};

function mapType(cdsType) {
  return CDS_TYPE_MAP[cdsType] || 'String';
}

// Derives the join key from a CDS association's ON condition or managed keys.
// CDS stores ON conditions as an array like:
//   [{ref: ['self', 'PARTNER']}, '=', {ref: ['target', 'PARTNER']}]
// Managed associations use col.keys: [{ref: ['PARTNER'], id: 'PARTNER'}]
function deriveJoinKeys(col) {
  if (col.on && col.on.length >= 3) {
    // CDS convention: on assocAlias.targetColumn = sourceColumn
    //   lhs = {ref: ['assocAlias', 'targetColumn']} → the joined entity's PK  → "to"
    //   rhs = {ref: ['sourceColumn']}               → this entity's FK         → "from"
    const lhs = col.on[0];
    const rhs = col.on[2];
    const toKey   = Array.isArray(lhs.ref) ? lhs.ref[lhs.ref.length - 1] : null;
    const fromKey = Array.isArray(rhs.ref) ? rhs.ref[rhs.ref.length - 1] : null;
    if (fromKey && toKey) return { from: fromKey, to: toKey };
  }
  if (col.keys && col.keys.length > 0) {
    const k = col.keys[0];
    return { from: k.ref?.[0] || k.id, to: k.id || k.ref?.[0] };
  }
  return null;
}

/**
 * Builds a schema descriptor from a loaded CDS model.
 * Call after cds.load() or inside a running CDS service where cds.model is populated.
 *
 * Returns: { EntityShortName: { label, key, fqn, columns, joins } }
 *   fqn     — fully qualified name for cds.run() e.g. 'bankingsentinel.BCA_DTI'
 *   columns — { ColName: 'String'|'Boolean'|'Decimal'|'Integer'|'Date' }
 *   joins   — { alias: { entity, from, to, type: 'INNER'|'LEFT' } }
 */
function buildSchema(cdsModel) {
  const schema = {};

  for (const [fqn, def] of Object.entries(cdsModel.definitions)) {
    if (def.kind !== 'entity') continue;
    if (fqn.startsWith('sap.') || fqn.startsWith('DRAFT.')) continue;

    const columns = {};
    const joins   = {};
    let   key     = null;

    for (const [colName, col] of Object.entries(def.elements || {})) {
      if (col.isAssociation || col.isComposition) {
        const targetFqn  = col.target || '';
        const targetShort = targetFqn.split('.').pop();
        const keys       = deriveJoinKeys(col);
        if (!keys) continue; // skip if we can't resolve join keys

        // Cardinality: to-many → LEFT (optional rows), to-one → INNER (guaranteed)
        const toMany   = col.cardinality?.max === '*' || col.is2many === true;
        const joinType = col['@NLP.joinType'] || (toMany ? 'LEFT' : 'INNER');
        const alias    = col['@NLP.alias']    || colName;

        joins[alias] = { entity: targetShort, from: keys.from, to: keys.to, type: joinType };

      } else if (col.type && !col.virtual) {
        columns[colName] = mapType(col.type);
        if (col.key) key = colName;
      }
    }

    const shortName = fqn.split('.').pop();
    schema[shortName] = {
      label:   def['@NLP.label'] || def['@title'] || shortName,
      key:     key || 'ID',
      fqn,
      columns,
      joins,
    };
  }

  return schema;
}

/** Compact text representation of the schema for the LLM prompt */
function buildSchemaPrompt(schema) {
  const lines = [];
  for (const [name, def] of Object.entries(schema)) {
    const cols  = Object.entries(def.columns).map(([c, t]) => `${c}:${t}`).join(', ');
    const joins = Object.entries(def.joins || {})
      .map(([alias, j]) => `"${alias}"→${j.entity}(${j.from}=${j.to},${j.type})`)
      .join(', ');
    lines.push(`${name} [${def.label}]`);
    lines.push(`  columns: ${cols}`);
    if (joins) lines.push(`  joins:   ${joins}`);
  }
  return lines.join('\n');
}

module.exports = { buildSchema, buildSchemaPrompt };
