'use strict';
const cds = require('@sap/cds');

function coerce(val, type) {
  if (type === 'Boolean') {
    if (val === 'true'  || val === 1 || val === '1') return true;
    if (val === 'false' || val === 0 || val === '0') return false;
    return Boolean(val);
  }
  if (type === 'Decimal' || type === 'Integer') return parseFloat(val);
  return val;
}

function applyConditions(rows, conditions, entityDef, joinEntityDef) {
  if (!conditions?.length) return rows;
  const today = new Date();

  return rows.filter(row => conditions.every(({ col, op, val }) => {
    let v, colType;
    if (col.includes('.')) {
      const [, colName] = col.split('.', 2);
      v       = row[`__join__${colName}`] ?? row[colName];
      colType = joinEntityDef?.columns[colName] || 'String';
    } else {
      v       = row[col];
      colType = entityDef.columns[col] || joinEntityDef?.columns[col] || 'String';
    }

    if (v === undefined || v === null) return false;

    const cv = coerce(v,   colType);
    const cw = coerce(val, colType);

    switch (op) {
      case '=':    return cv == cw;
      case '!=':   return cv != cw;
      case '>':    return cv  > cw;
      case '<':    return cv  < cw;
      case '>=':   return cv >= cw;
      case '<=':   return cv <= cw;
      case 'like': return String(v).toLowerCase().includes(String(val).toLowerCase());
      case 'within_days': {
        const d = new Date(v), future = new Date(today);
        future.setDate(future.getDate() + parseInt(val));
        return d >= today && d <= future;
      }
      case 'days_ago': {
        const d = new Date(v), past = new Date(today);
        past.setDate(past.getDate() - parseInt(val));
        return d >= past && d <= today;
      }
      default: return true;
    }
  }));
}

/**
 * Executes a query descriptor against the CDS db layer.
 *
 * Descriptor shape:
 *   entity    — short entity name (must be in schema)
 *   join      — join alias name (from entity's joins map) or null
 *   select    — column list, e.g. ['PARTNER', 'joinAlias.BU_SORT1'] or null (all)
 *   where     — [{ col, op, val }] conditions; col may be 'joinAlias.COL'
 *   orderBy   — column name or null
 *   orderDir  — 'ASC' | 'DESC'
 *   limit     — max rows to return (default 50)
 *
 * One-to-many joins are handled correctly: a main row with N matching join rows
 * produces N result rows (unlike the Map-overwrite approach which kept only 1).
 */
async function executeDescriptor(descriptor, schema) {
  const { entity, join: joinAlias, select, where, orderBy, orderDir, limit = 50 } = descriptor;

  const entityDef = schema[entity];
  if (!entityDef) {
    throw new Error(`Unknown entity "${entity}". Known: ${Object.keys(schema).join(', ')}`);
  }

  let joinDef       = null;
  let joinEntityDef = null;

  if (joinAlias) {
    joinDef = entityDef.joins?.[joinAlias];
    if (!joinDef) {
      throw new Error(`No join "${joinAlias}" on "${entity}". Valid: ${Object.keys(entityDef.joins || {}).join(', ')}`);
    }
    joinEntityDef = schema[joinDef.entity];
    if (!joinEntityDef) throw new Error(`Join target "${joinDef.entity}" not in schema`);
  }

  // Fetch main entity rows
  let rows = await cds.run(SELECT.from(entityDef.fqn).limit(500));

  // Merge join (correct one-to-many: group join rows by key → flatMap)
  if (joinDef && joinEntityDef) {
    const joinRows = await cds.run(SELECT.from(joinEntityDef.fqn).limit(500));

    // Group join rows by the "to" key — preserves all matches (fixes overwrite bug)
    const joinMap = new Map();
    for (const r of joinRows) {
      const k = r[joinDef.to];
      if (!joinMap.has(k)) joinMap.set(k, []);
      joinMap.get(k).push(r);
    }

    const isInner = joinDef.type === 'INNER';

    rows = rows.flatMap(row => {
      const matches = joinMap.get(row[joinDef.from]) || [];
      if (matches.length === 0) {
        return isInner ? [] : [row]; // INNER drops unmatched; LEFT keeps them
      }
      // Each match becomes a separate result row (correct one-to-many behaviour)
      return matches.map(matched => {
        const merged = { ...row };
        for (const [k, v] of Object.entries(matched)) {
          merged[`__join__${k}`] = v;
          if (!(k in row)) merged[k] = v; // non-colliding columns promoted
        }
        return merged;
      });
    });
  }

  // Apply WHERE conditions post-join (cross-entity conditions work correctly here)
  rows = applyConditions(rows, where, entityDef, joinEntityDef);

  // Sort
  if (orderBy) {
    const dir = orderDir === 'DESC' ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[orderBy] ?? a[`__join__${orderBy}`];
      const bv = b[orderBy] ?? b[`__join__${orderBy}`];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    });
  }

  // Column projection — resolve 'alias.COL' refs, strip __join__ internals
  let result = rows.slice(0, limit);
  if (select?.length) {
    result = result.map(row => {
      const out = {};
      for (const col of select) {
        if (col.includes('.')) {
          const [, colName] = col.split('.', 2);
          out[colName] = row[`__join__${colName}`] ?? row[colName];
        } else {
          out[col] = row[col];
        }
      }
      return out;
    });
  } else {
    result = result.map(row =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('__join__')))
    );
  }

  return result;
}

module.exports = { executeDescriptor };
