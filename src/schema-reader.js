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
// Entities are addressed by short name (e.g. "Loans") for ergonomics — but in a
// namespaced CAP project, two entities in different namespaces can share a short
// name (e.g. "sales.Order" and "support.Order"). Silently keying by short name
// would let the second one overwrite the first. Count occurrences up front so
// colliding entities fall back to their fully-qualified name instead — safe by
// default, only verbose where it's actually needed.
function countShortNames(cdsModel) {
  const counts = {};
  for (const [fqn, def] of Object.entries(cdsModel.definitions)) {
    if (def.kind !== 'entity') continue;
    if (fqn.startsWith('sap.') || fqn.startsWith('DRAFT.')) continue;
    const shortName = fqn.split('.').pop();
    counts[shortName] = (counts[shortName] || 0) + 1;
  }
  return counts;
}

function buildSchema(cdsModel) {
  const schema = {};
  const shortNameCounts = countShortNames(cdsModel);
  const keyFor = fqn => {
    const shortName = fqn.split('.').pop();
    return shortNameCounts[shortName] > 1 ? fqn : shortName;
  };

  for (const [fqn, def] of Object.entries(cdsModel.definitions)) {
    if (def.kind !== 'entity') continue;
    if (fqn.startsWith('sap.') || fqn.startsWith('DRAFT.')) continue;
    // No backing db table/view — querying it via cds.run() would fail or behave
    // unexpectedly, so it must never be offered to the LLM as a queryable entity.
    if (def['@cds.persistence.skip'] === true || def['@cds.persistence.skip'] === 'true') continue;

    const columns = {};
    const joins   = {};
    let   key     = null;

    for (const [colName, col] of Object.entries(def.elements || {})) {
      if (col.isAssociation || col.isComposition) {
        const targetFqn   = col.target || '';
        const targetKey   = keyFor(targetFqn);
        const keys        = deriveJoinKeys(col);
        if (!keys) continue; // skip if we can't resolve join keys

        // Cardinality: to-many → LEFT (optional rows), to-one → INNER (guaranteed)
        const toMany   = col.cardinality?.max === '*' || col.is2many === true;
        const joinType = col['@NLP.joinType'] || (toMany ? 'LEFT' : 'INNER');
        const alias    = col['@NLP.alias']    || colName;

        joins[alias] = { entity: targetKey, from: keys.from, to: keys.to, type: joinType };

      } else if (col.type && col.virtual) {
        // Virtual elements are never persisted — populated by custom handler code at
        // runtime, not safe to SELECT via cds.run(). Skip, but log so a developer
        // adding @NLP.label to a field they expect to be queryable knows why it isn't.
        process.stderr.write(
          `[cds-db-nlquery-mcp] Skipping virtual element "${fqn}.${colName}" — not queryable via cds.run().\n`
        );

      } else if (col.type) {
        // @NLP.label takes precedence (room for disambiguation text), falls back to
        // the standard CDS @title annotation (e.g. already used for Fiori labels).
        const meta = {
          type:        mapType(col.type),
          label:       col['@NLP.label'] || col['@title'] || null,
          // @description/@Core.Description are standard CDS annotations meant for longer
          // explanatory text (vs. @title's short label) — useful for disambiguating columns
          // whose name/label alone don't convey business meaning to the LLM.
          description: col['@description'] || col['@Core.Description'] || null,
        };

        // @NLP.synonyms has no standard CDS equivalent — alternate business terms the
        // LLM should map onto this column (e.g. "DTI" -> "DEBT_TO_INCOME_RATIO").
        if (col['@NLP.synonyms']?.length) {
          meta.synonyms = col['@NLP.synonyms'];
        }

        // @assert.range is normally a write-time validation annotation, but as
        // read-only metadata it's a useful hint of the column's valid domain — lets
        // the LLM catch an out-of-range filter (e.g. unit/scale mismatch) before
        // emitting a query that trivially returns zero rows.
        if (col['@assert.range']) {
          meta.range = col['@assert.range'];
        }

        // @Semantics.amount.currencyCode / @Semantics.quantity.unitOfMeasure pair an
        // amount/quantity column with the column holding its currency/unit code — a
        // signal the LLM should select both together so the presented value isn't a
        // bare number (e.g. "1500" instead of "1500 USD").
        const pairCol = col['@Semantics.amount.currencyCode'] || col['@Semantics.quantity.unitOfMeasure'];
        if (pairCol) meta.pairedWith = pairCol;

        // Calculated-on-read elements (colName = (expression)) are computed by the DB
        // on every query — safe to SELECT like any stored column, but tagged so the LLM
        // understands it's a derived value (e.g. some DBs can't index a computed expression).
        if (col.value) meta.calculated = true;

        // Native CDS enum (e.g. `STATUS : String(1) enum { active = 'A'; closed = 'C'; }`)
        // — the same SAP-standard mechanism Fiori uses for value help / coded dropdowns.
        // Captured as { rawValue: symbolicName } so the LLM knows both the business term
        // and the exact raw value to use in filters, and the executor can translate
        // raw codes back to business terms in the result rows.
        if (col.enum) {
          meta.enum = {};
          for (const [symbolicName, valueDef] of Object.entries(col.enum)) {
            meta.enum[valueDef.val] = symbolicName;
          }
        }

        // @Common.Text — SAP-standard pattern for LARGE code lists (hundreds of values),
        // where enum (compile-time fixed set) doesn't scale. Points through an association
        // to a text field on a separate code/lookup entity, e.g. `status.TEXT`. We don't
        // translate this ourselves — we tell the LLM the path exists so it can include it
        // in `select` via the normal association path mechanism (real SQL JOIN, no new code).
        const textRef = col['@Common.Text'];
        if (textRef && typeof textRef === 'object' && textRef['=']) {
          meta.textVia = textRef['='];
        }

        // @Common.ValueList — the broader OData/Fiori value-help annotation (vs. the
        // simpler @Common.Text 1:1 lookup already handled above). Resolution needs the
        // full `joins` map for this entity, which isn't built yet mid-loop, so stash the
        // raw annotation and resolve it in a second pass below once `joins` is complete.
        if (!meta.textVia && col['@Common.ValueList']?.CollectionPath) {
          meta._pendingValueList = col['@Common.ValueList'];
        }

        columns[colName] = meta;
        if (col.key) key = colName;
      }
    }

    // Resolve @Common.ValueList — find an existing association alias whose target
    // matches CollectionPath, and a ValueListParameterDisplayOnly entry (a context label,
    // not the round-trip key column from ValueListParameterInOut) to use as the text.
    // If no matching association exists, this annotation can't be turned into a join
    // path — skip silently rather than inventing one.
    for (const meta of Object.values(columns)) {
      const valueList = meta._pendingValueList;
      delete meta._pendingValueList;
      if (!valueList) continue;

      const targetShortName = valueList.CollectionPath.split('.').pop();
      const alias = Object.keys(joins).find(a => joins[a].entity.split('.').pop() === targetShortName);
      if (!alias) continue;

      const labelParam = (valueList.Parameters || [])
        .find(p => p.$Type === 'Common.ValueListParameterDisplayOnly');
      if (labelParam?.ValueListProperty) {
        meta.textVia = `${alias}.${labelParam.ValueListProperty}`;
      }
    }

    const shortName  = fqn.split('.').pop();
    const entityKey  = keyFor(fqn);

    // @cds.search declares which columns participate in CAP's built-in free-text
    // search query option — lets the LLM use a single "search" term instead of
    // having to guess which column a vague match term lives in.
    const searchAnno = def['@cds.search'];
    const searchableColumns = searchAnno
      ? Object.keys(searchAnno).filter(k => searchAnno[k] !== false)
      : [];

    schema[entityKey] = {
      label:       def['@NLP.label'] || def['@title'] || shortName,
      description: def['@description'] || def['@Core.Description'] || null,
      key:         key || 'ID',
      fqn,
      columns,
      joins,
      searchableColumns,
    };
  }

  return schema;
}

/** True if any entity short name collides with another entity in a different namespace. */
function hasNameCollisions(cdsModel) {
  return Object.values(countShortNames(cdsModel)).some(n => n > 1);
}

/** Compact text representation of the schema for the LLM prompt */
function buildSchemaPrompt(schema) {
  const lines = [];
  for (const [name, def] of Object.entries(schema)) {
    const cols  = Object.entries(def.columns)
      .map(([c, meta]) => {
        let s = `${c}:${meta.type}`;
        if (meta.label) s += `["${meta.label}"]`;
        if (meta.description) s += ` — ${meta.description}`;
        if (meta.synonyms) s += ` (aka: ${meta.synonyms.join(', ')})`;
        if (meta.range) s += `[${meta.range[0]}..${meta.range[1]}]`;
        if (meta.pairedWith) s += `{pairs with ${meta.pairedWith} — always select both together}`;
        if (meta.calculated) s += '[calculated]';
        if (meta.enum) {
          const pairs = Object.entries(meta.enum).map(([val, name]) => `${name}="${val}"`).join(',');
          s += `{values: ${pairs} — use the raw value in filters}`;
        }
        if (meta.textVia) {
          s += `{readable text available via "${meta.textVia}" — include it in select to show the human-readable value, AND use this path (not the raw "${c}" column) when the question filters by a human term like "active"/"closed"/"overdue" rather than a raw code}`;
        }
        return s;
      })
      .join(', ');
    const joins = Object.entries(def.joins || {})
      .map(([alias, j]) => `"${alias}"→${j.entity}(${j.from}=${j.to},${j.type})`)
      .join(', ');
    lines.push(`${name} [${def.label}]${def.description ? ` — ${def.description}` : ''}`);
    lines.push(`  columns: ${cols}`);
    if (joins) lines.push(`  joins:   ${joins}`);
    if (def.searchableColumns?.length) lines.push(`  searchable: ${def.searchableColumns.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { buildSchema, buildSchemaPrompt, hasNameCollisions };
